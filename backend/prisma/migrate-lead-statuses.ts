/**
 * Миграция статусов заявок на набор квалификации лида.
 *
 * Зачем. Воронка Application перестала быть лестницей «этапов поступления»
 * (NEW → DOCS_REVIEW → … → ENROLLED) и стала набором исходов квалификации:
 * NEW_LEAD, IN_PROCESSING, ONLINE_CONSULTATION, OFFLINE_CONSULTATION,
 * THINKING, OUT_OF_TOWN, UNDER_17, POTENTIAL_LEAD, LOW_QUALITY_LEAD,
 * SUCCESSFUL_LEAD. Новые значения добавлены в enum ApplicationStatus.
 *
 * Почему одной правки схемы мало. `prisma db push` умеет только ДОБАВИТЬ
 * значения в enum — он не трогает данные. Все ~496 существующих строк
 * Application продолжают лежать со старыми статусами, а CRM их больше не
 * предлагает и не показывает: заявки не попадали бы ни в один фильтр, KPI
 * и авто-распределение считали бы не то. Этот скрипт переносит строки.
 *
 * Почему старые значения остаются в enum'е. Postgres не удаляет значение
 * enum'а, пока на него ссылается хоть одна строка, а `start:prod` выполняет
 * `prisma db push` ДО этого скрипта и без `--accept-data-loss` — попытка
 * удаления уронила бы деплой. Поэтому старые значения остаются в схеме, но
 * после этого скрипта на них не ссылается ничего, и отдельной уборкой их
 * можно будет выпилить.
 *
 * ⚠️ ЗАПУСКАЕТСЯ ТОЛЬКО ПО ЯВНОМУ ФЛАГУ — MIGRATE_LEAD_STATUSES=1 (или
 * `--force` при ручном прогоне). Без него скрипт печатает строку и выходит.
 *
 * Почему так, хотя он стоит в `start:prod`. Раньше в комментариях по всему
 * репозиторию было написано, что перенос строк идёт «уже ПОСЛЕ того, как
 * новый код поднялся». Это ровно наоборот: `start:prod` — цепочка `&&`, где
 * `node dist/main` стоит ПОСЛЕДНИМ, значит скрипт доигрывает до того, как
 * новый процесс займёт порт. Всё это время Railway отдаёт трафик ПРЕДЫДУЩЕМУ
 * контейнеру, чей Prisma-клиент сгенерён по старому enum'у и не знает
 * NEW_LEAD/IN_PROCESSING/SUCCESSFUL_LEAD. Перевести под ним ~496 строк —
 * значит уронить в 500 всю CRM и кабинет студента (любое чтение
 * Application.status: /applications, /applications/stats, /students,
 * /kpi/leaderboard, student-auth `me`) на время миграции + бута + healthcheck.
 *
 * Отсюда раскатка в два деплоя (подробности — DEPLOY.md, «Перевод статусов
 * заявок на набор квалификации лида»):
 *   N   — код с компат-чтениями (src/common/application-status.ts) уезжает
 *         БЕЗ флага. `prisma db push` добавляет значения в enum — это
 *         аддитивно и старому читателю безразлично, — строки не трогаются.
 *   N+1 — оператор выставляет MIGRATE_LEAD_STATUSES=1. Строки переезжают, но
 *         предыдущий контейнер это уже код деплоя N, который читает и
 *         легаси, и новые значения. После прогона флаг снимают.
 *
 * Маппинг (см. также FINISHED_APPLICATION_STATUSES в
 * src/common/application-status.ts — там тот же набор для чтений):
 *   NEW                                                   → NEW_LEAD
 *   IN_PROGRESS, DOCS_REVIEW, DOCS_SUBMITTED,
 *   PRE_ADMISSION, AWAITING_PAYMENT                        → IN_PROCESSING
 *   COMPLETED, ENROLLED                                    → SUCCESSFUL_LEAD
 *
 * ОТДЕЛЬНО ПРО AWAITING_PAYMENT. Этот статус нёс не этап воронки, а
 * финансовый признак «за студентом числится долг». На нём держались раздел
 * «Задолженность студентов» (GET /finance/pending-payments) и карточка
 * дашборда «Студентов с задолженностью». Схлопывание в IN_PROCESSING без
 * подготовки стёрло бы признак безвозвратно: обратно из IN_PROCESSING его не
 * достать — там же лежат все, кто просто в работе, — а финансовые экраны
 * показали бы не ошибку, а тихий ноль должников, которого никто не заметит.
 * Поэтому ПЕРЕД бакетами выполняется backfill в Application.paymentPending —
 * durable-колонку, которую статусы больше не затрагивают и которую менеджер
 * ставит/снимает руками в карточке заявки. Если backfill не прошёл,
 * AWAITING_PAYMENT в этом прогоне НЕ мигрируется (см. main): лучше оставить
 * строки на легаси-статусе и повторить прогон осознанно, чем потерять
 * список должников.
 *
 * Идемпотентно: после первого прогона строк со старыми статусами не остаётся,
 * UPDATE матчит ноль записей, скрипт печатает «переносить нечего».
 * Backfill идемпотентен по той же причине: его источник — статус
 * AWAITING_PAYMENT, которого после первого прогона в таблице нет, поэтому
 * снятый вручную флаг повторный запуск обратно не поднимет.
 * На пустой таблице ведёт себя так же и не бросает.
 *
 * Почему сырой SQL, а не prisma.application.updateMany. У Application поле
 * `updatedAt` помечено `@updatedAt` (schema.prisma), и Prisma проставляет его
 * КЛИЕНТСКИ на каждом updateMany — DB-триггера нет. Прогон через клиент
 * переписал бы updatedAt всем ~496 строкам на дату миграции и снёс бы
 * исторический таймлайн, по которому считаются:
 *   • kpi.service (applicationsEnrolled: status ∈ FINISHED + updatedAt в
 *     периоде) — весь all-time успех схлопнулся бы в период деплоя,
 *     прошлые периоды обнулились бы, conversionRate ушёл бы за 100%
 *     (знаменатель-то считается по createdAt);
 *   • users.service (enrolledMonth → kpiAchievedPct / requiredClosed) — это
 *     база KPI-плана и бонуса менеджера;
 *   • cron.service (stalePipeline: updatedAt < weekAgo) — «свежие» строки
 *     не попадали бы в понедельничное напоминание неделю после деплоя.
 * Сырой UPDATE меняет только status и оставляет updatedAt как есть.
 * Перезапись updatedAt необратима, поэтому именно этот путь.
 * По той же причине сырым SQL сделан и backfill paymentPending: список
 * должников в CRM отсортирован по updatedAt, и прогон через клиент поднял бы
 * все ~496 заявок наверх этого списка датой деплоя.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Гейт запуска. Дублирует isLeadStatusRowMigrationEnabled() из
 * src/common/application-status.ts НАМЕРЕННО, а не импортирует: prisma/ вынесена
 * из TS-проекта бэкенда (tsconfig.json → `rootDir: "./src"`,
 * `exclude: ["prisma"]`), и импорт через ../src сломал бы ts-node нарушением
 * rootDir. Списки значений обязаны совпадать — правишь здесь, правь и там.
 */
const MIGRATION_ENV = 'MIGRATE_LEAD_STATUSES';

function isMigrationEnabled(): boolean {
  // `--force` — для ручного прогона (`npm run migrate:lead-statuses`). Именно
  // аргумент, а не `VAR=1 cmd`: последнее не работает в PowerShell, а разработка
  // тут идёт с Windows.
  if (process.argv.slice(2).includes('--force')) return true;
  const raw = (process.env[MIGRATION_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Бакеты переноса. Ключ — целевой новый статус, значение — старые статусы,
 * которые в него схлопываются. Строки заморожены как строковые литералы
 * намеренно: это исторический снимок «что лежало в БД», он не должен
 * разъезжаться, если из enum'а когда-нибудь уберут легаси-значения (тогда
 * сравнение по `status::text` ниже просто перестанет находить строки — что и
 * требуется).
 */
const BUCKETS: { to: string; from: string[] }[] = [
  { to: 'NEW_LEAD', from: ['NEW'] },
  {
    to: 'IN_PROCESSING',
    from: ['IN_PROGRESS', 'DOCS_REVIEW', 'DOCS_SUBMITTED', 'PRE_ADMISSION', 'AWAITING_PAYMENT'],
  },
  { to: 'SUCCESSFUL_LEAD', from: ['COMPLETED', 'ENROLLED'] },
];

/**
 * Легаси-статус, который нёс финансовый смысл, а не этап воронки.
 * Вынесен в константу, потому что упоминается трижды: в backfill'е (источник),
 * в бакете IN_PROCESSING (цель переноса) и в гейте main() (что снять с
 * переноса, если backfill не удался).
 */
const DEBT_LEGACY_STATUS = 'AWAITING_PAYMENT';

/**
 * Итог backfill'а — от него зависит, можно ли трогать AWAITING_PAYMENT.
 *   ok      — признак долга сохранён в paymentPending, статус можно схлопывать;
 *   no-table — таблицы ещё нет, сохранять нечего, схлопывать тоже нечего;
 *   failed  — колонки нет / БД не ответила: схлопывать НЕЛЬЗЯ, признак
 *             потеряется без возможности восстановления.
 */
type BackfillResult = 'ok' | 'no-table' | 'failed';

/**
 * Взводится каждым «мягким» отказом. Нужен только ради финальной строки лога:
 * скрипт намеренно не роняет процесс (в `start:prod` он вдобавок обёрнут в
 * `|| echo`), поэтому без явного маркера частичный или полностью несработавший
 * прогон выглядит в логах Railway так же, как успешный, и легаси-строки
 * остаются незамеченными.
 */
let hadFailure = false;

/**
 * Переносит «ждёт оплаты» из статуса в durable-колонку paymentPending.
 *
 * Условие `"paymentPending" = false` не оптимизация, а защита от лишней
 * записи: строку, которой флаг уже проставлен, UPDATE не трогает.
 */
async function backfillPaymentPending(): Promise<BackfillResult> {
  try {
    const count = await prisma.$executeRawUnsafe(
      `UPDATE "Application" SET "paymentPending" = true
        WHERE status::text = $1 AND "paymentPending" = false`,
      DEBT_LEGACY_STATUS,
    );
    if (count > 0) {
      console.log(`  ✓ ${DEBT_LEGACY_STATUS} → paymentPending: ${count} должников сохранено`);
    } else {
      console.log('  · Должников со статусом AWAITING_PAYMENT нет — backfill пропущен');
    }
    return 'ok';
  } catch (e: any) {
    const message = e?.message || '';
    // Свежая БД до первого `prisma db push` — таблицы ещё нет, терять нечего.
    if (/relation "Application" does not exist/i.test(message)) {
      console.log('  · Application ещё не создана — backfill пропущен');
      return 'no-table';
    }
    // Всё остальное (в первую очередь «column "paymentPending" does not
    // exist», если db push не доехал) — повод НЕ трогать AWAITING_PAYMENT.
    hadFailure = true;
    console.warn(`  ! Backfill paymentPending не удался: ${message}`);
    console.warn(`  ! ${DEBT_LEGACY_STATUS} НЕ мигрируется в этом прогоне — должники остаются на легаси-статусе`);
    console.warn(`  ! Почините колонку и запустите миграцию заново (${MIGRATION_ENV}=1).`);
    return 'failed';
  }
}

async function migrateBucket(bucket: { to: string; from: string[] }): Promise<number> {
  if (bucket.from.length === 0) return 0;
  try {
    // Плейсхолдеры под старые статусы: $2, $3, … ($1 занят целевым значением).
    const placeholders = bucket.from.map((_, i) => `$${i + 2}`).join(', ');
    // Сравниваем `status::text`, а не кастуем параметры к enum'у: если легаси-
    // значение когда-нибудь уберут из ApplicationStatus, каст `'NEW'::"Application
    // Status"` бросил бы ошибку, а сравнение с текстом просто не найдёт строк.
    // Целевое значение кастуем — оно обязано быть в enum'е, и если db push ещё
    // не доехал, ловим это ниже как «значение ещё не в enum'е».
    const count = await prisma.$executeRawUnsafe(
      `UPDATE "Application" SET status = $1::"ApplicationStatus" WHERE status::text IN (${placeholders})`,
      bucket.to,
      ...bucket.from,
    );
    if (count > 0) {
      console.log(`  ✓ ${bucket.from.join(', ')} → ${bucket.to}: ${count} строк`);
    } else {
      console.log(`  · ${bucket.to}: строк со старыми статусами нет — пропуск`);
    }
    return count;
  } catch (e: any) {
    const message = e?.message || '';
    // Свежая БД до первого `prisma db push` — таблицы ещё нет.
    if (/does not exist/i.test(message)) {
      console.log(`  · Application ещё не создана — пропуск (${bucket.to})`);
      return 0;
    }
    // Значения нового enum'а ещё не доехали (db push не отработал) — не повод
    // валить деплой, но и не «само рассосётся»: перенос опт-ин, повтора без
    // явного флага не будет.
    if (/invalid input value for enum|not found in enum/i.test(message)) {
      hadFailure = true;
      console.warn(`  ! Значение ${bucket.to} ещё не в enum'е — пропуск`);
      return 0;
    }
    hadFailure = true;
    console.warn(`  ! ${bucket.to} migration warning: ${message}`);
    return 0;
  }
}

async function main() {
  if (!isMigrationEnabled()) {
    console.log(
      `⏭  Lead status migration skipped: ${MIGRATION_ENV} не выставлена (и нет --force).`,
    );
    console.log(
      '   Это штатное состояние, а не сбой. Перенос строк идёт ДО того, как новый',
    );
    console.log(
      '   процесс займёт порт, то есть под живым предыдущим контейнером, который',
    );
    console.log(
      '   новых значений enum\'а не знает и отвечает на них 500. Новый код читает',
    );
    console.log(
      '   легаси-строки как есть (src/common/application-status.ts), так что откладывать',
    );
    console.log(
      `   перенос безопасно. Как раскатывать — DEPLOY.md, «Перевод статусов заявок».`,
    );
    return;
  }

  console.log('🔄 Migrating application statuses to lead qualification set...');

  // ПОРЯДОК ВАЖЕН: сначала сохраняем признак долга, потом перезаписываем
  // статусы. Наоборот — значит стереть список должников без возможности
  // восстановления (см. шапку файла).
  const backfill = await backfillPaymentPending();

  let moved = 0;
  for (const bucket of BUCKETS) {
    // Backfill не прошёл → AWAITING_PAYMENT снимаем с переноса, остальные
    // статусы бакета мигрируем как обычно. Заявки-должники останутся на
    // легаси-статусе, финансы продолжат их видеть (pendingPayments читает и
    // колонку, и легаси-статус), а повторный прогон миграции доделает перенос.
    const from =
      backfill === 'failed' ? bucket.from.filter((s) => s !== DEBT_LEGACY_STATUS) : bucket.from;
    moved += await migrateBucket({ to: bucket.to, from });
  }

  if (moved === 0) {
    console.log('  · Переносить нечего — все заявки уже на новых статусах.');
  }

  // Отдельная громкая строка на случай частичного прогона. Скрипт намеренно
  // не роняет процесс, а в `start:prod` он ещё и обёрнут в `|| echo`, поэтому
  // без этого маркера «мигрировали 0 строк, потому что всё сломалось» выглядит
  // в логах ровно как «мигрировали 0 строк, потому что нечего».
  if (hadFailure) {
    console.warn(
      `⚠️  Lead status migration ЧАСТИЧНАЯ: перенесено ${moved} строк, часть бакетов не прошла (см. «!» выше).`,
    );
    console.warn(
      `⚠️  Легаси-строки остались в БД. Разберитесь и повторите прогон с ${MIGRATION_ENV}=1.`,
    );
    return;
  }

  console.log(`✅ Lead status migration complete: перенесено ${moved} строк.`);
}

main()
  .catch((e) => {
    console.error('Lead status migration failed:', e);
    // НЕ роняем процесс — деплой должен подняться даже если миграция не зашла.
    process.exit(0);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
