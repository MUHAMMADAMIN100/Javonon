/**
 * Единая точка правды по статусам заявки (ApplicationStatus).
 *
 * Зачем модуль. Схема перешла на набор квалификации лида (NEW_LEAD …
 * SUCCESSFUL_LEAD), но старые значения (NEW, IN_PROGRESS, COMPLETED,
 * DOCS_REVIEW, DOCS_SUBMITTED, PRE_ADMISSION, AWAITING_PAYMENT, ENROLLED)
 * остались в enum'е: Postgres не удаляет значения, на которые ссылаются строки,
 * а `start:prod` делает `prisma db push` без `--accept-data-loss`.
 *
 * ⚠️ ПОРЯДОК ДЕПЛОЯ — ОБРАТНЫЙ ТОМУ, ЧТО ЗДЕСЬ БЫЛО НАПИСАНО РАНЬШЕ.
 * Старая редакция этого блока (и его копий в prisma/migrate-lead-statuses.ts,
 * frontend-crm/src/api/types.ts, frontend-crm/src/lib/labels.ts,
 * frontend-landing/src/applicationStatus.ts) утверждала, что перенос строк
 * происходит «уже ПОСЛЕ того, как новый код поднялся». Это неверно:
 *   • `start:prod` — цепочка `&&`, в которой `node dist/main` стоит ПОСЛЕДНИМ,
 *     то есть все prisma-скрипты доигрывают ДО того, как новый процесс начнёт
 *     слушать порт;
 *   • страховочный хук PrismaService.migrateLegacyStatuses() висит на
 *     onModuleInit, а он отрабатывает внутри NestFactory.create(), тоже
 *     до `app.listen()`.
 * Railway (railway.json → startCommand, restartPolicy ON_FAILURE) до этого
 * момента продолжает отдавать трафик ПРЕДЫДУЩЕМУ контейнеру. Значит любой
 * перенос строк на новые значения enum'а происходит под живым СТАРЫМ кодом,
 * чей сгенерённый Prisma-клиент про NEW_LEAD/IN_PROCESSING/SUCCESSFUL_LEAD
 * не знает и падает на десериализации. Это 500 на всём, что читает
 * Application.status: GET /applications, /applications/stats, /students
 * (STUDENT_INCLUDE), /kpi/leaderboard, student-auth `me`. Компат-списки ниже
 * от этого не спасают — они существуют только в НОВОМ коде.
 *
 * Поэтому перенос строк сделан ЯВНО ОПТ-ИН: и prisma/migrate-lead-statuses.ts,
 * и хук в PrismaService молчат, пока не выставлена MIGRATE_LEAD_STATUSES
 * (см. isLeadStatusRowMigrationEnabled ниже и раздел «Перевод статусов заявок
 * на набор квалификации лида» в DEPLOY.md). Раскатка — в два деплоя:
 *   N   — этот код уезжает БЕЗ флага. `db push` добавляет значения в enum
 *         (аддитивно, старому читателю безразлично), строки не трогаются,
 *         старый контейнер дочитывает свои легаси-значения и спокойно уходит.
 *   N+1 — оператор выставляет флаг. Строки переезжают, но предыдущий
 *         контейнер — это уже код деплоя N, который читает и легаси, и новые
 *         значения. 500-ов нет.
 *
 * Отсюда и компат-списки ниже. Пока флаг не выставлен — а он может не быть
 * выставлен сколь угодно долго, и вдобавок скрипт умеет тихо не сработать
 * (в `start:prod` он завёрнут в `|| echo`, а сам на ошибке делает
 * process.exit(0)) — в БД ЛЕЖАТ легаси-строки. Если бы KPI читал ровно
 * `status: 'SUCCESSFUL_LEAD'`, он показал бы ноль зачислений; если бы
 * авто-распределение лидов считало активным всё, что не SUCCESSFUL_LEAD,
 * нагрузка менеджеров скакнула бы на все закрытые заявки разом. Поэтому
 * ЧТЕНИЯ матчат новый статус ВМЕСТЕ с его легаси-хвостом, а ЗАПИСИ всегда
 * идут только новым значением.
 *
 * Легаси-хвосты в списках ниже — временные, но снимать их можно не «когда-то
 * после деплоя», а только после того, как на КАЖДОМ окружении реально прогнали
 * миграцию и `SELECT DISTINCT status FROM "Application"` перестал возвращать
 * старые значения. Сначала хвосты из этих констант, потом сами значения из
 * enum'а (отдельным деплоем — иначе ловим ту же 500-ю проблему зеркально).
 */
import { ApplicationStatus } from '@prisma/client';

/**
 * Переменная окружения, разрешающая ПЕРЕНОС СТРОК Application.status на новый
 * набор значений. Читают ровно два места:
 *   • prisma/migrate-lead-statuses.ts — полная миграция всех восьми легаси-значений;
 *   • PrismaService.migrateLegacyStatuses() — страховочный хук на буте.
 *
 * Ни то, ни другое не должно срабатывать «само по себе на деплое»: перенос
 * идёт под живым предыдущим контейнером (см. блок выше), поэтому запускать его
 * можно только тем деплоем, чей предшественник уже умеет читать новые значения.
 *
 * Флаг НЕ управляет `prisma db push` — добавление значений в enum аддитивно и
 * безопасно, оно должно проходить на каждом деплое как раньше.
 */
export const LEAD_STATUS_MIGRATION_ENV = 'MIGRATE_LEAD_STATUSES';

/**
 * Разрешён ли перенос строк на новые статусы в этом процессе.
 *
 * Принимаем только явное «да» (1/true/yes/on, регистр не важен). Любое другое
 * значение, пустая строка и отсутствие переменной — «нет»: цена ложного
 * срабатывания это 500 на всей CRM, поэтому дефолт максимально трусливый.
 */
export function isLeadStatusRowMigrationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env[LEAD_STATUS_MIGRATION_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * «Заявка доведена до результата» — успешный лид.
 *
 * Пишем всегда SUCCESSFUL_LEAD; ENROLLED и COMPLETED здесь — легаси-хвост,
 * который лежит в БД до тех пор, пока не прогнали migrate-lead-statuses.ts
 * (перенос опт-ин, см. LEAD_STATUS_MIGRATION_ENV выше).
 *
 * Используется в: kpi.service (applicationsEnrolled), users.service (закрытые
 * за месяц), sales.service (заявка НЕ активна → не грузит менеджера),
 * cron.service (напоминания не трогают завершённые), applications.service
 * (поздравительная SMS).
 */
export const FINISHED_APPLICATION_STATUSES: ApplicationStatus[] = [
  'SUCCESSFUL_LEAD',
  'ENROLLED',
  'COMPLETED',
];

/**
 * «Новый, ещё не разобранный лид».
 *
 * Пишем всегда NEW_LEAD; NEW — легаси-хвост. Нужен там, где логика проверяет
 * «заявка ещё в исходном состоянии» (авто-конвертация в студента при первом
 * переводе в работу).
 */
export const NEW_LEAD_APPLICATION_STATUSES: ApplicationStatus[] = [
  'NEW_LEAD',
  'NEW',
];

/**
 * «Заявка в работе».
 *
 * Пишем всегда IN_PROCESSING. Легаси-хвост — все промежуточные этапы старой
 * воронки, которые migrate-lead-statuses.ts схлопывает в IN_PROCESSING.
 */
export const IN_PROCESSING_APPLICATION_STATUSES: ApplicationStatus[] = [
  'IN_PROCESSING',
  'IN_PROGRESS',
  'DOCS_REVIEW',
  'DOCS_SUBMITTED',
  'PRE_ADMISSION',
  'AWAITING_PAYMENT',
];

/**
 * Актуальный набор, который CRM предлагает менеджеру — в порядке показа.
 * Легаси-значений здесь нет намеренно: старую строку можно прочитать
 * (см. STATUS_LABEL в applications.service), но выбрать заново нельзя.
 */
export const ACTIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  'NEW_LEAD',
  'IN_PROCESSING',
  'ONLINE_CONSULTATION',
  'OFFLINE_CONSULTATION',
  'THINKING',
  'OUT_OF_TOWN',
  'UNDER_17',
  'POTENTIAL_LEAD',
  'LOW_QUALITY_LEAD',
  'SUCCESSFUL_LEAD',
];

/**
 * Что клиент видит в SMS про свой статус — и видит ли вообще.
 *
 * `null` = статус ВНУТРЕННИЙ. Старая воронка (NEW → DOCS_REVIEW → … →
 * ENROLLED) состояла из этапов обработки, и любой её пункт можно было без
 * стеснения назвать клиенту. Новый набор — это квалификация лида для отдела
 * продаж, и половина значений описывает не заявку, а мнение менеджера о
 * человеке: «Думает», «Вне города», «До 17 лет», «Потенциальные лиды»,
 * «Некачественные лиды». Поэтому правило «SMS на любую смену статуса» здесь
 * больше не работает: клиент получал бы «Статус Вашей заявки изменён:
 * «Думает» → «Некачественные лиды»».
 *
 * Подписи здесь КЛИЕНТСКИЕ и намеренно отличаются от CRM-меток: в CRM это
 * названия колонок воронки во множественном числе («Новые лиды»), а в SMS
 * речь про одну конкретную заявку («Принята»).
 *
 * Легаси-значения оставлены с подписями намеренно: пока строки не перенесены
 * (перенос опт-ин, см. LEAD_STATUS_MIGRATION_ENV), они приходят как
 * ПРЕДЫДУЩИЙ статус, и без подписи в SMS уехало бы голое «ENROLLED».
 *
 * Record<ApplicationStatus, …> держит таблицу полной: добавили значение в enum
 * — компилятор заставит решить, что про него узнает клиент (текст) или что не
 * узнает ничего (null). Молчание должно быть осознанным решением, а не
 * следствием забытой строки.
 */
export const CLIENT_SMS_STATUS_LABEL: Record<ApplicationStatus, string | null> = {
  // ——— Клиентские: человеку уместно про них знать.
  NEW_LEAD: 'Принята',
  IN_PROCESSING: 'В обработке',
  ONLINE_CONSULTATION: 'Онлайн-консультация',
  OFFLINE_CONSULTATION: 'Очная консультация',
  SUCCESSFUL_LEAD: 'Оформлена',
  // ——— Внутренние: оценка лида отделом продаж. Ни подписи, ни SMS.
  THINKING: null,
  OUT_OF_TOWN: null,
  UNDER_17: null,
  POTENTIAL_LEAD: null,
  LOW_QUALITY_LEAD: null,
  // ——— Легаси-этапы старой воронки — все клиентские.
  NEW: 'Новая заявка',
  IN_PROGRESS: 'В работе',
  DOCS_REVIEW: 'Документы на проверке',
  DOCS_SUBMITTED: 'Документы поданы',
  PRE_ADMISSION: 'Предварительное зачисление',
  AWAITING_PAYMENT: 'Ожидание оплаты',
  COMPLETED: 'Завершена',
  ENROLLED: 'Зачислен',
};

/** Заявка доведена до результата (с учётом легаси-хвоста). */
export function isFinishedApplicationStatus(status: ApplicationStatus): boolean {
  return FINISHED_APPLICATION_STATUSES.includes(status);
}

/**
 * Можно ли ЗАПИСАТЬ этот статус в строку.
 *
 * Читать легаси-значения обязательно (строку мог не догнать
 * migrate-lead-statuses.ts), а вот писать их заново — нельзя никогда.
 * Обратный переход неотличим от «нормального» апдейта, но откатывает строку
 * ЗА уже отработавшую миграцию, а повторно её никто не перенесёт: перенос
 * запускается только явным MIGRATE_LEAD_STATUSES (см. LEAD_STATUS_MIGRATION_ENV,
 * package.json → start:prod и PrismaService.migrateLegacyStatuses), и после
 * успешной раскатки флаг с окружения снимают. Поэтому заявка осталась бы с
 * мёртвым статусом навсегда, а клиенту при этом ушла бы SMS «Заявка возвращена».
 *
 * Реальный сценарий, ради которого нужна именно СЕРВЕРНАЯ проверка: вкладка
 * CRM, открытая до деплоя. Vercel отдаёт бандлы по immutable-хэшам, так что
 * старый JS в такой вкладке живёт, пока её не перезагрузят, — а он ещё знает
 * старую воронку и умеет отправить PATCH со статусом DOCS_REVIEW. Фронтенд
 * это починить не может по определению; тот же путь открыт для curl и любого
 * не обновлённого клиента.
 */
export function isWritableApplicationStatus(status: ApplicationStatus): boolean {
  return ACTIVE_APPLICATION_STATUSES.includes(status);
}

/**
 * Во что развернуть значение фильтра списка заявок.
 *
 * Менеджер выбирает в CRM новый статус, а в БД, пока перенос строк не прогнали
 * (он опт-ин, см. LEAD_STATUS_MIGRATION_ENV), может лежать его легаси-эквивалент.
 * Возвращаем список значений, которые надо считать равнозначными выбранному;
 * для статусов без легаси-хвоста — он сам один.
 */
export function applicationStatusFilterValues(
  status: ApplicationStatus,
): ApplicationStatus[] {
  for (const group of [
    FINISHED_APPLICATION_STATUSES,
    NEW_LEAD_APPLICATION_STATUSES,
    IN_PROCESSING_APPLICATION_STATUSES,
  ]) {
    if (group.includes(status)) return group;
  }
  return [status];
}
