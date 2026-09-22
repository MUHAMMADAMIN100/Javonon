import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Optional } from '@nestjs/common';
import { ApplicationSource, ApplicationStatus, Country, Direction, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import {
  CreateStaffApplicationDto,
  STAFF_DEFAULT_SOURCE,
} from './dto/create-staff-application.dto';
import {
  canCreateApplication,
  canReassignApplicationManager,
  canSeeAllApplications,
  canTouchApplicationManager,
} from './application-access';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { ActivityService } from '../activity/activity.service';
import { canSeePartnerAttribution, isElevated, UserWithRoles } from '../auth/role-utils';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { REQUIRED_DOCUMENT_TYPES } from '../common/documents';
import { ReferralsService } from '../partners/referrals.service';
import { SalesService } from '../sales/sales.service';
import { CABINET_BY_DIRECTION, DEFAULT_CABINET } from '../common/cabinets';
import { parseCalendarDateUtc, tjLocalDay, tjYMD } from '../common/tj-time';
import { dateRangeFilter } from '../common/query-date';
import { likeLiteral, phoneDigitsPattern } from '../common/search';
import {
  ACTIVE_APPLICATION_STATUSES,
  CLIENT_SMS_STATUS_LABEL,
  FINISHED_APPLICATION_STATUSES,
  NEW_LEAD_APPLICATION_STATUSES,
  applicationStatusFilterValues,
  isFinishedApplicationStatus,
  isWritableApplicationStatus,
} from '../common/application-status';

// Направление, которое подставляется КАЖДОЙ заявке из create() (= каждой
// заявке с лендинга: другого клиента у этого метода нет).
// ЭТО ПЛЕЙСХОЛДЕР, А НЕ ОТВЕТ КЛИЕНТА: форма лендинга больше не спрашивает
// «Ҳадаф», она спрашивает страну (country). Колонка Application.direction
// осталась NOT NULL (её нельзя ослабить, не переписав ~30 файлов бэкенда
// и ~10 страниц CRM), поэтому её надо чем-то заполнить. Настоящее направление
// менеджер выставляет позже в карточке студента — плейсхолдер копируется туда
// при переводе заявки NEW_LEAD → IN_PROCESSING (см. update() ниже).
//
// ВАЖНО: каждая строка, куда попал этот плейсхолдер, помечается
// directionConfirmed=false. Без этой пометки плейсхолдер неотличим от
// настоящего ответа и утекает в аналитику: groupBy('direction') в stats()
// показывал бы 100% лидов с лендинга как «Бакалавриат», а фильтр списка
// по «Бакалавриату» возвращал бы их все. Поэтому любой read-путь, который
// трактует direction как ответ клиента (stats, фильтр, колонка списка),
// обязан смотреть на этот флаг.
const DEFAULT_DIRECTION: Direction = Direction.BACHELOR;

// Возрастное окно для заявки (включительно). Ниже 14 — школьник, которого
// не берут ни на одну программу; выше 60 — заведомо опечатка в годе.
const MIN_AGE = 14;
const MAX_AGE = 60;

const COUNTRY_LABEL: Record<Country, string> = {
  USA: 'США',
  KOREA: 'Корея',
  CHINA: 'Китай',
  LATVIA: 'Латвия',
  MALAYSIA: 'Малайзия',
  ITALY: 'Италия',
  GERMANY: 'Германия',
};

const MANAGER_INCLUDE = {
  student: {
    include: {
      manager: { select: { id: true, fullName: true, email: true } },
      chinaManager: { select: { id: true, fullName: true, email: true } },
      program: true,
    },
  },
  manager: { select: { id: true, fullName: true, email: true } },
  chinaManager: { select: { id: true, fullName: true, email: true } },
  program: true,
};

/**
 * Потолок пачки для массового назначения менеджера. Очередь «Новые лиды» —
 * десятки строк, страница — 25; 200 с запасом покрывает «отметил несколько
 * страниц», и при этом один запрос не может повесить транзакцию на тысячи
 * строк под блокировкой.
 */
const BULK_ASSIGN_MAX = 200;

/**
 * Realtime-событие «у пачки заявок сменился менеджер». Payload:
 * { applicationIds: string[], studentIds: string[], managerId: string }.
 * Подписчики в CRM: Leads, Applications, ApplicationDetail, Students,
 * StudentDetail — добавляя нового слушателя application:updated, добавь и это.
 */
export const APPLICATIONS_BULK_UPDATED_EVENT = 'applications:bulk-updated';

/** Код ответа 409 «нужно подтвердить переназначение» — его ждёт CRM. */
export const BULK_REASSIGN_CONFIRM_REQUIRED = 'REASSIGN_CONFIRM_REQUIRED';

/**
 * Строка ActivityLog о смене менеджера. Одна на оба пути назначения —
 * одиночный и массовый: отчёты и поиск по журналу читают этот текст, и два
 * формата одной и той же операции разъехались бы в первом же фильтре.
 */
function managerChangeDetails(flag: string, before: string, after: string): string {
  return `Менеджер ${flag}: ${before} → ${after}`;
}

/** Лид, у которого массовое назначение реально сменило менеджера. */
type ChangedLead = {
  updated: Prisma.ApplicationGetPayload<{ include: typeof MANAGER_INCLUDE }>;
  /** Имя прежнего менеджера для строки журнала («—», если не было). */
  beforeManagerName: string;
};

/** «Назначен 1 лид» / «Назначено 2 лида» / «Назначено 5 лидов». */
function pluralLeadsAssigned(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `Назначен ${n} лид`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `Назначено ${n} лида`;
  return `Назначено ${n} лидов`;
}

type CurrentUser = { id: string; role: Role };

/** Значение фильтра «менеджер не назначен» (см. findAll). */
export const UNASSIGNED_MANAGER = 'none';

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private telegram: TelegramService,
    private mail: MailService,
    private sms: SmsService,
    private activity: ActivityService,
    private realtime: RealtimeGateway,
    @Optional() private referrals?: ReferralsService,
    @Optional() private sales?: SalesService,
  ) {}

  // Порядок статусов — для определения, "понизили" или "продвинули" заявку.
  // Раньше это был порядок ЭТАПОВ старой воронки (NEW → DOCS_REVIEW → … →
  // ENROLLED). Теперь это порядок пунктов нового набора квалификации
  // (ACTIVE_APPLICATION_STATUSES). Строгой «лестницей» он больше не является —
  // «Вне города» и «До 17 лет» это исходы, а не ступени, — но ранг здесь
  // используется ровно для одного: выбрать формулировку SMS («возвращена
  // с … на …» против «изменён … → …»). Поведение то же, что и было.
  private static STAGE_ORDER: ApplicationStatus[] = ACTIVE_APPLICATION_STATUSES;

  /**
   * Ранг статуса в STAGE_ORDER. Легаси-значение отдаёт ранг своего нового
   * эквивалента: prev вполне может прийти старым (перенос строк опт-ин, см.
   * LEAD_STATUS_MIGRATION_ENV — пока его не прогнали, легаси-статусы лежат в
   * БД), и без этой подстановки переход «ENROLLED → THINKING» не распознался
   * бы как откат.
   */
  private static stageRank(status: ApplicationStatus): number {
    const direct = ApplicationsService.STAGE_ORDER.indexOf(status);
    if (direct >= 0) return direct;
    const legacyEquivalent = ApplicationsService.LEGACY_STAGE_EQUIVALENT[status];
    return legacyEquivalent
      ? ApplicationsService.STAGE_ORDER.indexOf(legacyEquivalent)
      : -1;
  }

  /** Легаси-статус → его новый эквивалент (тот же маппинг, что в миграции). */
  private static LEGACY_STAGE_EQUIVALENT: Partial<Record<ApplicationStatus, ApplicationStatus>> = {
    NEW: 'NEW_LEAD',
    IN_PROGRESS: 'IN_PROCESSING',
    DOCS_REVIEW: 'IN_PROCESSING',
    DOCS_SUBMITTED: 'IN_PROCESSING',
    PRE_ADMISSION: 'IN_PROCESSING',
    AWAITING_PAYMENT: 'IN_PROCESSING',
    COMPLETED: 'SUCCESSFUL_LEAD',
    ENROLLED: 'SUCCESSFUL_LEAD',
  };

  private isDowngrade(prev: ApplicationStatus, next: ApplicationStatus): boolean {
    const a = ApplicationsService.stageRank(prev);
    const b = ApplicationsService.stageRank(next);
    return a >= 0 && b >= 0 && b < a;
  }

  /**
   * Текст SMS клиенту при смене статуса — или null, если писать не о чем.
   *
   * Раньше метод возвращал строку всегда, потому что вся старая воронка
   * состояла из этапов обработки: «Документы на проверке», «Ожидание оплаты»,
   * «Зачислен» — каждый из них клиенту не стыдно назвать. Новый набор — это
   * КВАЛИФИКАЦИЯ ЛИДА для отдела продаж, и половина его значений описывает
   * не заявку, а мнение менеджера о человеке. Сохрани мы прежнее правило
   * «SMS на любую смену статуса», клиент получил бы буквально
   * «Javonon: Статус Вашей заявки изменён: «Думает» → «Некачественные лиды»».
   *
   * Поэтому источник подписей здесь — CLIENT_SMS_STATUS_LABEL (клиентский
   * словарь), а НЕ STATUS_LABEL (внутренние названия колонок воронки, они
   * для сотрудника). null в словаре = статус внутренний, и тогда:
   *   • внутренний NEXT → молчим совсем (return null);
   *   • внутренний PREV → шлём одностороннее «Статус Вашей заявки: «…»»,
   *     потому что назвать клиенту, откуда его вернули, нельзя.
   */
  private smsTextForStatus(prev: ApplicationStatus, next: ApplicationStatus): string | null {
    const labelNext = CLIENT_SMS_STATUS_LABEL[next];
    if (!labelNext) return null;
    // Успешный лид. Формулировка НЕ про зачисление в вуз: SUCCESSFUL_LEAD
    // означает «лид доведён до результата» — заявка оформлена, человек стал
    // клиентом, — и наступает он заметно раньше, чем наступал ENROLLED в
    // старой воронке. Обещать здесь «Вы зачислены» значит врать клиенту.
    // Проверка группой (isFinishedApplicationStatus), а не сравнением с
    // одним значением — на случай, если легаси-эквивалент всё-таки доберётся
    // сюда мимо isWritableApplicationStatus.
    if (isFinishedApplicationStatus(next)) {
      return `🎉 Javonon: Ваша заявка успешно оформлена! Менеджер свяжется с Вами по дальнейшим шагам. Подробности в личном кабинете.`;
    }
    const labelPrev = CLIENT_SMS_STATUS_LABEL[prev];
    if (!labelPrev) {
      return `Javonon: Статус Вашей заявки: «${labelNext}».`;
    }
    if (this.isDowngrade(prev, next)) {
      return `Javonon: Заявка возвращена с «${labelPrev}» на «${labelNext}». Свяжитесь с менеджером для уточнений.`;
    }
    return `Javonon: Статус Вашей заявки изменён: «${labelPrev}» → «${labelNext}».`;
  }

  /** Возвращает первый непустой номер телефона: из заявки, потом из связанного студента. */
  private async resolvePhone(app: { phone: string | null; studentId?: string | null }): Promise<string | null> {
    if (app.phone && app.phone.trim()) return app.phone.trim();
    if (app.studentId) {
      const s = await this.prisma.student.findUnique({
        where: { id: app.studentId },
        select: { phones: true },
      });
      const first = s?.phones?.[0];
      if (first && first.trim()) return first.trim();
    }
    return null;
  }

  /**
   * ВНУТРЕННИЕ подписи статусов — для СОТРУДНИКА, не для клиента.
   *
   * Это названия колонок воронки как их видит менеджер в CRM («Новые лиды»,
   * «Некачественные лиды»). Единственный потребитель — текст ошибки про
   * устаревший статус в update(): её читает тот, кто прислал PATCH, то есть
   * сотрудник со старой вкладкой CRM.
   *
   * В SMS клиенту это НЕ идёт: там свой словарь CLIENT_SMS_STATUS_LABEL
   * (common/application-status.ts), в котором внутренние оценки лида вообще
   * не имеют подписи. Не подставлять сюда клиентские тексты и наоборот —
   * половина этих строк для клиента оскорбительна, а половина клиентских
   * («Принята») ничего не говорит менеджеру о колонке воронки.
   *
   * Легаси-значения оставлены НАМЕРЕННО: именно они и попадают в текст
   * ошибки — старая вкладка присылает DOCS_REVIEW, и менеджер должен увидеть
   * «Документы на проверке», а не сырой ключ enum'а. Record<ApplicationStatus,
   * string> обязывает покрыть весь enum: забытая подпись — ошибка компиляции.
   */
  private static STATUS_LABEL: Record<ApplicationStatus, string> = {
    // Актуальный набор квалификации лида.
    NEW_LEAD: 'Новые лиды',
    IN_PROCESSING: 'В обработке',
    ONLINE_CONSULTATION: 'Онлайн консультации',
    OFFLINE_CONSULTATION: 'Оффлайн консультации',
    THINKING: 'Думает',
    OUT_OF_TOWN: 'Вне города',
    UNDER_17: 'До 17 лет',
    POTENTIAL_LEAD: 'Потенциальные лиды',
    LOW_QUALITY_LEAD: 'Некачественные лиды',
    SUCCESSFUL_LEAD: 'Успешные лиды',
    // Легаси — только для чтения старых строк, в UI не предлагаются.
    NEW: 'Новая заявка',
    IN_PROGRESS: 'В работе',
    COMPLETED: 'Завершена',
    DOCS_REVIEW: 'Документы на проверке',
    DOCS_SUBMITTED: 'Документы поданы',
    PRE_ADMISSION: 'Предварительное зачисление',
    AWAITING_PAYMENT: 'Ожидание оплаты',
    ENROLLED: 'Зачислен',
  };

  /**
   * Парсит дату рождения с лендинга и проверяет возрастное окно 14–60.
   *
   * Считаем «сегодня» через tjYMD() (Asia/Dushanbe, см. common/tj-time.ts),
   * а НЕ через голый `new Date()`: Railway живёт в UTC, и у таджикского
   * пользователя, отправляющего форму после 19:00 UTC, «сегодня» уже
   * следующие сутки — на границе дня рождения возраст считался бы на год
   * меньше.
   *
   * А вот саму дату рождения храним UTC-полуночью (parseCalendarDateUtc), а
   * НЕ душанбинской: DOB — календарный день, а не момент. Раньше здесь стоял
   * tjParseLocalDate(), и «12.03» ложилось в БД как «2006-03-11T19:00:00Z» —
   * cron birthdayGreetings читает колонку через `EXTRACT(DAY FROM birthday)`
   * (сырой UTC) и слал поздравление 11 марта. При этом students.service.ts
   * писал UTC-полночь, так что в одной таблице сосуществовали две конвенции.
   */
  private parseBirthday(input?: string): Date | null {
    if (!input) return null;
    const date = parseCalendarDateUtc(input);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Некорректная дата рождения');
    }
    const today = tjYMD();
    // Дата лежит UTC-полуночью → календарные части читаем в UTC. Окно 14..60
    // при этом сравнивается с сегодняшним днём по Душанбе (tjYMD выше).
    const born = {
      y: date.getUTCFullYear(),
      m: date.getUTCMonth() + 1,
      d: date.getUTCDate(),
    };
    let age = today.y - born.y;
    // День рождения в этом году ещё не наступил → минус год.
    if (today.m < born.m || (today.m === born.m && today.d < born.d)) age--;
    if (age < MIN_AGE || age > MAX_AGE) {
      throw new BadRequestException(
        `Дата рождения указана неверно: возраст должен быть от ${MIN_AGE} до ${MAX_AGE} лет`,
      );
    }
    return date;
  }

  /**
   * Общее ядро создания лида: валидация даты рождения → авто-подбор
   * менеджера/воронки → INSERT. Ноль side-effect'ов наружу: ни Telegram,
   * ни почты, ни SMS, ни уведомлений, ни реферальной атрибуции — их
   * навешивает вызывающий, потому что у заявки с лендинга и у лида,
   * набранного сотрудником руками, наборы этих эффектов принципиально
   * разные (см. create() и createByStaff() ниже).
   *
   * opts.source — провенанс строки. Передаётся ЯВНО, а не берётся из dto:
   * это единственное место, где он решается, и на staff-пути значения
   * LANDING_FORM/SELF_REGISTRATION недопустимы (см. STAFF_ALLOWED_SOURCES
   * в create-staff-application.dto.ts).
   *
   * opts.autoAssignManager — round-robin по SALES_MANAGER. Для лендинга
   * true: лид приходит ночью и обязан кому-то достаться сразу. Для ручного
   * ввода false: менеджера выбирает квалификатор прямо в строке списка, а
   * авто-назначение перебило бы его выбор ещё до того, как он его сделает,
   * и не-elevated сотрудник потом не смог бы переназначить занятый слот
   * (см. assignManager).
   */
  private async persistNewLead(
    dto: CreateApplicationDto | CreateStaffApplicationDto,
    opts: { source: ApplicationSource; autoAssignManager: boolean },
  ): Promise<{ app: Prisma.ApplicationGetPayload<{}>; duplicate: boolean }> {
    // Валидируем дату рождения ДО любых side-effect'ов (создание заявки,
    // назначение менеджера, реферальная атрибуция) — иначе при 400 в БД
    // осталась бы половинчатая заявка.
    const birthday = this.parseBirthday(dto.birthday);

    // Повторное обращение. Номер сравниваем по последним 9 цифрам
    // («+992 90 123-45-67» и «901234567» — один человек). Замок на номер
    // держится до конца транзакции: двойной клик и две вкладки дают ОДНУ
    // заявку, второй запрос дождётся первого и увидит её.
    //
    // Авто-распределение держит второй, общий замок: менеджер выбирается по
    // нагрузке, и два одновременных лида без него доставались бы одному.
    // Порядок замков всегда «номер → распределение» — взаимной блокировки нет.
    const key = phoneKey(dto.phone);
    return this.prisma.$transaction(async (tx) => {
      if (key) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'lead:' + key}))`;
        const open = await this.findOpenByPhone(tx, key);
        if (open) {
          const line = `[${tjLocalDay()}] Повторное обращение` +
            (dto.comment?.trim() ? `: ${dto.comment.trim()}` : '');
          const app = await tx.application.update({
            where: { id: open.id },
            data: { comment: open.comment ? `${open.comment}\n${line}` : line },
          });
          return { app, duplicate: true };
        }
      }
      if (opts.autoAssignManager) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('lead-distribution'))`;
      }
      return { app: await this.insertLead(tx, dto, opts, birthday), duplicate: false };
    });
  }

  /**
   * Открытая заявка с этим номером: не успешная и не «некачественный лид».
   * По закрытой клиент заводится заново — это новая сделка.
   */
  private async findOpenByPhone(tx: Prisma.TransactionClient, key: string) {
    const closed: ApplicationStatus[] = [...FINISHED_APPLICATION_STATUSES, 'LOW_QUALITY_LEAD'];
    const rows = await tx.$queryRaw<{ id: string; comment: string | null }[]>`
      SELECT id, comment FROM "Application"
      WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${key}
        AND status::text NOT IN (${Prisma.join(closed)})
      ORDER BY "createdAt" DESC
      LIMIT 1`;
    return rows[0] ?? null;
  }

  private async insertLead(
    db: Prisma.TransactionClient | PrismaService,
    dto: CreateApplicationDto | CreateStaffApplicationDto,
    opts: { source: ApplicationSource; autoAssignManager: boolean },
    birthday: Date | null,
  ) {

    // Sprint E: авто-распределение лидов. Если managerId не задан явно —
    // round-robin среди SALES_MANAGER (наименее загруженный).
    let assignedManagerId: string | null = null;
    let pipelineId: string | null = null;
    let pipelineStageId: string | null = null;
    if (this.sales) {
      if (opts.autoAssignManager) {
        try { assignedManagerId = await this.sales.pickManagerForLead(db); }
        catch { /* fallback: оставляем без менеджера */ }
      }
      // Авто-проставление дефолтной воронки и её первого этапа.
      try {
        const def = await this.sales.pickDefaultPipelineStage();
        pipelineId = def.pipelineId;
        pipelineStageId = def.pipelineStageId;
      } catch { /* без воронки — норм */ }
    }
    return db.application.create({
      data: {
        fullName: dto.fullName.trim(),
        phone: dto.phone.trim(),
        // Нормализация та же, что у phone — иначе один и тот же номер
        // хранился бы в двух разных видах.
        whatsappPhone: dto.whatsappPhone?.trim() || null,
        secondaryPhone: (dto as any).secondaryPhone?.trim() || null,
        secondaryContactLabel: (dto as any).secondaryContactLabel?.trim() || null,
        preferredChannel: (dto as any).preferredChannel || null,
        email: dto.email?.trim() || null,
        // Направление здесь ВСЕГДА плейсхолдер: create() вызывается ровно из
        // одного места — POST /applications/public, а туда ходит только форма
        // лендинга, которая спрашивает страну вместо «Ҳадаф». Никакой другой
        // клиент этого метода не существует (Telegram-бот заявок не создаёт,
        // он уводит человека на ту же форму — telegram/bot-funnel.service.ts).
        // Остальные создатели заявок — CRM (StudentsService.create),
        // самозапись (StudentAuthService.register), approve заявки партнёра
        // (SubmissionsService) — пишут Application напрямую через Prisma
        // с настоящим направлением и получают directionConfirmed=true
        // по @default из схемы.
        direction: DEFAULT_DIRECTION,
        // …и честно помечаем, что это плейсхолдер, а не ответ. Иначе он
        // попадёт в дашборд/фильтр как настоящее направление клиента.
        directionConfirmed: false,
        // Статус пишем ЯВНО, хотя в схеме на колонке стоит @default(NEW).
        // Дефолт остался легаси намеренно (enum правим только аддитивно, см.
        // комментарий в schema.prisma), а новый лид обязан попадать сразу в
        // актуальный набор — иначе каждая заявка с лендинга рождалась бы в
        // статусе, которого нет ни в одном фильтре CRM.
        status: 'NEW_LEAD',
        country: dto.country ?? null,
        birthday,
        comment: dto.comment?.trim() || null,
        programId: (dto as any).programId || null,
        source: opts.source,
        managerId: assignedManagerId,
        pipelineId,
        pipelineStageId,
      },
    });
  }

  async create(dto: CreateApplicationDto & { ref?: string }) {
    const { app, duplicate } = await this.persistNewLead(dto, {
      source: dto.source || 'LANDING_FORM',
      autoAssignManager: true,
    });

    // Публичный ответ — без данных заявки: иначе по чужому номеру можно было
    // бы получить чужую заявку (комментарии, менеджера).
    if (duplicate) {
      await this.notifyRepeat(app);
      this.telegram
        .send(`🔁 *Повторное обращение*\n*ФИО:* ${dto.fullName.trim()}\n*Телефон:* ${dto.phone.trim()}` +
          (dto.comment?.trim() ? `\n*Комментарий:* ${dto.comment.trim()}` : ''))
        .catch(() => undefined);
      return { ok: true };
    }

    // Реферальная атрибуция: если в заявке пришёл ref-код партнёра,
    // привязываем заявку к нему через ReferralsService.
    if (dto.ref && this.referrals) {
      this.referrals.attribute({
        code: dto.ref,
        source: 'SITE',
        applicationId: app.id,
        emailHint: app.email || undefined,
      }).catch(() => undefined);
    }

    // Направление сотрудникам не печатаем вообще: в заявках, созданных этим
    // методом, в нём всегда плейсхолдер (directionConfirmed=false выше), и
    // «Бакалавриат» в уведомлении читался бы как ответ клиента. Печатаем
    // страну — единственное, что клиент действительно выбрал.
    const countryText = app.country ? COUNTRY_LABEL[app.country] : null;
    // DOB лежит UTC-полуночью (parseBirthday) → календарный день читаем прямо
    // из ISO-префикса. Прогонять его через tjLocalDay() нельзя: это сдвиг
    // календарной даты в таймзону, а 12 марта остаётся 12 марта везде.
    const birthdayText = app.birthday ? app.birthday.toISOString().slice(0, 10) : null;
    const headline = countryText || '—';

    // Новая заявка (ФИО, телефон) — только тем, кто видит все заявки, и
    // назначенным менеджерам; раньше — каждому сотруднику.
    await this.notifications.notifyAudience('applications', [app.managerId, app.chinaManagerId], {
      type: 'APPLICATION_NEW',
      title: 'Новая заявка',
      message: `${app.fullName} — ${headline}, ${app.phone}`,
      payload: { applicationId: app.id },
    });

    const tgText =
      `🆕 *Новая заявка Javonon*\n` +
      `*ФИО:* ${app.fullName}\n` +
      `*Телефон:* ${app.phone}\n` +
      (app.whatsappPhone ? `*WhatsApp:* ${app.whatsappPhone}\n` : '') +
      (app.email ? `*Email:* ${app.email}\n` : '') +
      (birthdayText ? `*Дата рождения:* ${birthdayText}\n` : '') +
      (countryText ? `*Страна:* ${countryText}\n` : '') +
      (app.comment ? `*Комментарий:* ${app.comment}` : '');
    this.telegram.send(tgText).catch(() => undefined);

    this.mail
      .sendToAdmin(
        `Новая заявка: ${app.fullName}`,
        `<h2>Новая заявка с лендинга</h2>
         <p><b>ФИО:</b> ${app.fullName}</p>
         <p><b>Телефон:</b> ${app.phone}</p>
         ${app.whatsappPhone ? `<p><b>WhatsApp:</b> ${app.whatsappPhone}</p>` : ''}
         ${app.email ? `<p><b>Email:</b> ${app.email}</p>` : ''}
         ${birthdayText ? `<p><b>Дата рождения:</b> ${birthdayText}</p>` : ''}
         ${countryText ? `<p><b>Страна:</b> ${countryText}</p>` : ''}
         ${app.comment ? `<p><b>Комментарий:</b> ${app.comment}</p>` : ''}`,
      )
      .catch(() => undefined);

    // SMS студенту: подтверждение получения заявки
    this.sms
      .send(
        app.phone,
        `Javonon: Ваша заявка получена. Менеджер свяжется с Вами в ближайшее время.`,
      )
      .catch(() => undefined);

    this.realtime.emitApplication('application:new', app, { application: app });
    return { ok: true };
  }

  /** Повторное обращение: менеджерам заявки и тем, кто видит все заявки, плюс живое обновление. */
  private async notifyRepeat(app: Prisma.ApplicationGetPayload<{}>) {
    await this.notifications.notifyAudience(
      'applications',
      [app.managerId, app.chinaManagerId],
      {
        type: 'APPLICATION_NEW',
        title: 'Повторное обращение',
        message: `${app.fullName}, ${app.phone}`,
        payload: { applicationId: app.id },
      },
    );
    this.realtime.emitApplication('application:updated', app, { application: app });
  }

  /**
   * Ручной ввод лида сотрудником из CRM (экран /leads, POST
   * /applications/staff). Meta/Facebook-интеграции ещё нет: лиды приходят по
   * телефону и в мессенджерах, и квалификатор набирает их десятками подряд.
   *
   * Лид — ЭТО заявка. Отдельной таблицы Lead нет и быть не должно: первый
   * статус заявки буквально «Новые лиды» (NEW_LEAD), и параллельная таблица
   * заставила бы каждый отчёт делать UNION.
   *
   * Чем отличается от create() (заявки с лендинга) — и почему:
   *  • НЕТ реферальной атрибуции. У лида, набранного руками, партнёра нет по
   *    определению; поля `ref` нет и в DTO, так что запустить её нельзя даже
   *    подсунув код в теле запроса.
   *  • НЕТ SMS клиенту «Ваша заявка получена, менеджер свяжется». Менеджер
   *    уже на линии — это его разговор и есть.
   *  • НЕТ письма админу «Новая заявка с лендинга» и НЕТ поста в Telegram:
   *    оба текста прямо утверждают происхождение с лендинга, а при десятке
   *    лидов подряд это ещё и спам в общий канал.
   *  • НЕТ notifyAllStaff: строка уведомления каждому сотруднику на каждый
   *    набранный вручную лид — тот же спам, только в БД.
   *  • ЕСТЬ realtime-эмит: список /leads и доска заявок должны показать
   *    новую строку немедленно, в том числе у остальных сотрудников.
   *  • НЕТ авто-назначения менеджера: его выбирает квалификатор в строке
   *    списка (см. persistNewLead, opts.autoAssignManager).
   *
   * Права проверяются в контроллере (RolesGuard + canCreateApplication),
   * здесь — вторым рубежом, потому что RolesGuard на этом контроллере
   * исторически не висел, а его неявная проверка по URL засчитывает любой
   * write-пермишен раздела, не только applications:create.
   */
  async createByStaff(dto: CreateStaffApplicationDto, user: CurrentUser) {
    if (!canCreateApplication(user as any)) {
      throw new ForbiddenException('Недостаточно прав для создания заявки');
    }
    const { app, duplicate } = await this.persistNewLead(dto, {
      source: dto.source || STAFF_DEFAULT_SOURCE,
      autoAssignManager: false,
    });
    if (duplicate) {
      await this.notifyRepeat(app);
      return { ...app, duplicate: true };
    }
    this.realtime.emitApplication('application:new', app, { application: app });
    return app;
  }

  /**
   * Плоский справочник сотрудников, которым можно назначить лид, — для
   * инлайнового <select> в строке списка /leads.
   *
   * Зачем отдельный метод, а не GET /users: тот эндпоинт закрыт
   * @Roles(ADMIN, ACCOUNTANT) и отдаёт кадровую карточку целиком (почта,
   * телефон, зарплатные поля). Квалификатору лидов не нужно ни то, ни
   * другое — ему нужны id и имя, и открывать ради выпадающего списка
   * весь кадровый раздел было бы худшим из двух решений.
   *
   * Отдаём только активных SALES_MANAGER/CLIENT_MANAGER — включая тех, у
   * кого роль лежит в roles[] (мульти-роли, ТЗ §2), иначе половина отдела
   * в списке бы не появилась.
   */
  async listAssignableManagers(user: CurrentUser) {
    if (!canTouchApplicationManager(user as any)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { role: { in: ['SALES_MANAGER', 'CLIENT_MANAGER'] } },
          { roles: { hasSome: ['SALES_MANAGER', 'CLIENT_MANAGER'] } },
        ],
      },
      select: { id: true, fullName: true, role: true },
      orderBy: { fullName: 'asc' },
    });
  }

  async findAll(filters: {
    status?: ApplicationStatus;
    direction?: Direction;
    // Фильтр CRM по стране (тулбар «Страна»), зеркалит фильтр по источнику.
    country?: Country;
    search?: string;
    mine?: boolean;
    managerUserId?: string;
    source?: ApplicationSource;
    /** Период списка (createdAt), тот же, что у дашборда. */
    from?: Date;
    to?: Date;
    /** Только заявки БЕЗ подтверждённого направления (строка дашборда). */
    directionPending?: boolean;
    /** Только заявки, в которых страна не указана (строка дашборда). */
    countryPending?: boolean;
    currentUserId?: string;
    currentUserRole?: Role;
    currentUserRoles?: Role[];
    // Пермиссии и признак активной кастомной роли — нужны, чтобы решить,
    // видит ли юзер весь раздел (canSeeAllApplications). Без них база
    // SALES_MANAGER у «Квалификатора лидов» резала список до назначенных
    // на него заявок, а ручной лид создаётся БЕЗ менеджера — экран /leads
    // был бы пуст.
    currentUserPermissions?: string[];
    currentUserHasCustomRole?: boolean;
    /** Страница (с 1). Задана — ответ { items, total } вместо массива. */
    page?: number;
    pageSize?: number;
    /** Колонка сортировки, «-» в начале — по убыванию (как ?sort= в CRM). */
    sort?: string;
    /** Порядок подписей для колонок-списков: «значение:ранг,…» (см. labelRanks в CRM). */
    ranks?: string;
  }) {
    const where: Prisma.ApplicationWhereInput = {};
    const and: Prisma.ApplicationWhereInput[] = [];
    // Фильтр по статусу разворачиваем в группу равнозначных значений: пока
    // перенос строк не прогнали (он опт-ин, MIGRATE_LEAD_STATUSES — см.
    // src/common/application-status.ts), часть строк носит легаси-статус, и
    // выбор «Успешные лиды» показывал бы пустой список вместо зачисленных.
    // Для статусов без легаси-хвоста applicationStatusFilterValues()
    // возвращает одно значение — поведение ровно прежнее.
    if (filters.status) {
      where.status = { in: applicationStatusFilterValues(filters.status) };
    }
    // Фильтр по направлению отдаёт только ПОДТВЕРЖДЁННЫЕ направления.
    // Без directionConfirmed выбор «Бакалавриат» возвращал бы вообще все
    // лиды с лендинга — у них там плейсхолдер DEFAULT_DIRECTION, а не выбор
    // клиента. Менеджер, ищущий бакалавров, получал бы мусорную выборку.
    if (filters.direction) {
      where.direction = filters.direction;
      where.directionConfirmed = true;
    }
    // Противоположность фильтра выше: заявки, которым направление ещё не
    // проставили руками. Взаимоисключающи — при обоих параметрах побеждает
    // явное направление (там directionConfirmed уже выставлен в true).
    if (filters.directionPending && !filters.direction) {
      where.directionConfirmed = false;
    }
    if (filters.country) where.country = filters.country;
    else if (filters.countryPending) where.country = null;
    if (filters.source) where.source = filters.source;
    // Период — по дате создания заявки, ровно как в stats(): иначе клик по
    // строке дашборда открывал бы другой набор строк, чем тот, что карточка
    // посчитала.
    const createdAt = dateRangeFilter({ from: filters.from, to: filters.to });
    if (createdAt) where.createdAt = createdAt;
    // Менеджеры (SALES_MANAGER/CLIENT_MANAGER) всегда видят только свои
    // заявки. FOUNDER/ADMIN/ACCOUNTANT — все, если только не запросили mine.
    const elevated = canSeeAllApplications({
      role: filters.currentUserRole,
      roles: filters.currentUserRoles,
      permissions: filters.currentUserPermissions,
      hasCustomRole: filters.currentUserHasCustomRole,
    });
    const restrictToMine =
      (filters.mine && filters.currentUserId) ||
      (!elevated && filters.currentUserId);
    if (restrictToMine) {
      and.push({
        OR: [
          { managerId: filters.currentUserId },
          { chinaManagerId: filters.currentUserId },
        ],
      });
    }
    // Фильтр по конкретному менеджеру: показываем заявки где он
    // назначен либо локальным, либо китайским менеджером.
    //
    // Особое значение 'none' — «ещё никому не назначено». Нужно на экране
    // лидов: там первый вопрос как раз «что осталось без хозяина», а id
    // пустоты не бывает.
    if (filters.managerUserId === UNASSIGNED_MANAGER) {
      and.push({ managerId: null, chinaManagerId: null });
    } else if (filters.managerUserId) {
      and.push({
        OR: [
          { managerId: filters.managerUserId },
          { chinaManagerId: filters.managerUserId },
        ],
      });
    }
    const search = filters.search?.trim();
    if (search) {
      const literal = likeLiteral(search);
      const or: Prisma.ApplicationWhereInput[] = [
        { fullName: { contains: literal, mode: 'insensitive' } },
        { phone: { contains: literal, mode: 'insensitive' } },
        { whatsappPhone: { contains: literal, mode: 'insensitive' } },
        { email: { contains: literal, mode: 'insensitive' } },
      ];
      // Номер — по одним цифрам (см. common/search.ts). Prisma не умеет
      // сравнивать по выражению над колонкой, поэтому id подходящих строк
      // достаём отдельным запросом.
      const pattern = phoneDigitsPattern(search);
      if (pattern) {
        const rows = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Application"
          WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${pattern}
             OR regexp_replace(COALESCE("whatsappPhone", ''), '[^0-9]', '', 'g') LIKE ${pattern}`;
        if (rows.length) or.push({ id: { in: rows.map((r) => r.id) } });
      }
      and.push({ OR: or });
    }
    if (and.length) where.AND = and;
    if (!filters.page) {
      return this.prisma.application.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: MANAGER_INCLUDE,
      });
    }
    const size = filters.pageSize ?? 20;
    const skip = (filters.page - 1) * size;
    const key = filters.sort?.replace(/^-/, '');
    // По дате (и по умолчанию) — страница прямо из базы.
    if (!key || key === 'createdAt' || !SORT_VALUE[key]) {
      const desc = key === 'createdAt' ? !!filters.sort?.startsWith('-') : true;
      const [items, total] = await Promise.all([
        this.prisma.application.findMany({
          where,
          orderBy: [{ createdAt: desc ? 'desc' : 'asc' }, { id: 'asc' }],
          include: MANAGER_INCLUDE,
          skip,
          take: size,
        }),
        this.prisma.application.count({ where }),
      ]);
      return { items, total };
    }
    // Остальные колонки — ровно как сортировала таблица CRM: «Заявка 2»
    // раньше «Заявка 12», регистр не важен, пустые всегда в конце, списки —
    // по подписям. Такой порядок база сама не даёт, поэтому берём лёгкие
    // строки (только поля сортировки), сортируем здесь, а целиком читаем
    // лишь строки страницы.
    const light = await this.prisma.application.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true, fullName: true, phone: true, country: true, direction: true,
        directionConfirmed: true, source: true, status: true, manager: { select: { fullName: true } },
      },
    });
    const rank = new Map<string, number>();
    for (const part of (filters.ranks || '').split(',')) {
      const [v, r] = part.split(':');
      if (v && r !== undefined && !Number.isNaN(Number(r))) rank.set(v, Number(r));
    }
    const dir = filters.sort?.startsWith('-') ? -1 : 1;
    const valueOf = SORT_VALUE[key];
    const decorated = light.map((row, i) => ({ id: row.id, i, v: valueOf(row, rank) }));
    decorated.sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : SORT_COLLATOR.compare(String(a.v), String(b.v));
      return c === 0 ? a.i - b.i : c * dir;
    });
    const ids = decorated.slice(skip, skip + size).map((d) => d.id);
    const rows = await this.prisma.application.findMany({ where: { id: { in: ids } }, include: MANAGER_INCLUDE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { items: ids.map((id) => byId.get(id)).filter(Boolean), total: light.length };
  }

  /**
   * Карточка заявки.
   *
   * @param viewer — кто смотрит. Нужен ТОЛЬКО для блока «Партнёр»:
   *   partnerAttribution попадает в ответ исключительно руководству
   *   (канонический гейт canSeePartnerAttribution из auth/role-utils —
   *   FOUNDER/ADMIN/ACCOUNTANT, но НЕ носитель активной кастомной роли
   *   с базой-«подложкой»: ему нужен явный partners:read). Остальным поля
   *   в ответе НЕТ вовсе — менеджер по продажам не должен знать ни имени
   *   партнёра, ни суммы, ни самого факта партнёрского происхождения
   *   клиента, а «скрыть в UI» он обошёл бы чтением сетевого ответа.
   *   Внутренние вызовы (update и т.п.) viewer не передают.
   */
  async findOne(id: string, viewer?: UserWithRoles | null) {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: MANAGER_INCLUDE,
    });
    if (!app) throw new NotFoundException('Заявка не найдена');
    if (!canSeePartnerAttribution(viewer)) return app;
    const partnerAttribution = this.referrals
      ? await this.referrals.getPartnerAttributionView({
          applicationId: app.id,
          studentId: app.studentId,
        })
      : null;
    return { ...app, partnerAttribution };
  }

  /**
   * Кто видит и правит заявку — то же правило, что у списка (findAll):
   * кто видит все заявки (canSeeAllApplications) — любую; остальные — только
   * те, где они назначены (TJ или CN). Раньше карточка по прямой ссылке
   * открывалась любому сотруднику, а заявку без менеджера мог править любой.
   */
  canAccess(app: { managerId: string | null; chinaManagerId?: string | null }, user: CurrentUser) {
    if (canSeeAllApplications(user as any)) return true;
    return app.managerId === user.id || app.chinaManagerId === user.id;
  }

  async assertCanView(id: string, user: CurrentUser) {
    const a = await this.prisma.application.findUnique({ where: { id }, select: { managerId: true, chinaManagerId: true } });
    if (!a) throw new NotFoundException('Заявка не найдена');
    if (!this.canAccess(a, user)) throw new ForbiddenException('Нет доступа к этой заявке');
  }

  private ensureCanEdit(
    app: { managerId: string | null; chinaManagerId?: string | null },
    user: CurrentUser,
  ) {
    if (this.canAccess(app, user)) return;
    throw new ForbiddenException(
      'Только назначенные менеджеры или администратор могут редактировать эту заявку',
    );
  }

  async update(id: string, dto: UpdateApplicationDto, user: CurrentUser) {
    const existing = await this.findOne(id);
    this.ensureCanEdit(existing, user);

    // Второй рубеж к @IsIn в UpdateApplicationDto: писать легаси-статус нельзя
    // никогда. DTO ловит это на HTTP-границе (ValidationPipe в main.ts), но
    // проверка живёт и здесь — сервис не должен зависеть от того, каким путём
    // до него дошли данные, а цена ошибки высокая: откат строки за уже
    // отработавшую миграцию необратим (migrate-lead-statuses.ts запускается
    // только по явному MIGRATE_LEAD_STATUSES, и после раскатки флаг снимают —
    // никто эту строку заново не перенесёт) и сопровождается SMS клиенту
    // «Заявка возвращена».
    if (dto.status != null && !isWritableApplicationStatus(dto.status)) {
      throw new BadRequestException(
        `Статус «${ApplicationsService.STATUS_LABEL[dto.status] || dto.status}» устарел и доступен только для чтения. Обновите страницу CRM и выберите статус заново.`,
      );
    }

    // Направление, пришедшее из карточки заявки, — это уже решение живого
    // менеджера, а не плейсхолдер. Снимаем пометку, и заявка возвращается
    // в срез «по направлениям» на дашборде и в фильтр списка.
    const data = {
      ...dto,
      ...(dto.direction != null ? { directionConfirmed: true } : {}),
    };
    // Направление, которое будет у заявки ПОСЛЕ этого PATCH. Студента ниже
    // заводим по нему, а не по existing.direction: менеджер обычно правит
    // направление тем же запросом, которым двигает статус в IN_PROCESSING,
    // и иначе в карточку студента (и в номер кабинета) уехал бы плейсхолдер.
    const effectiveDirection = dto.direction ?? existing.direction;

    // Авто-создание студента при переходе «новый лид» → «в обработке»
    // (если ещё не создан). Раньше триггером была пара NEW → DOCS_REVIEW;
    // в новом наборе это NEW_LEAD → IN_PROCESSING. Прежний статус матчим
    // через NEW_LEAD_APPLICATION_STATUSES, чтобы заявка, которая ещё лежит
    // с легаси-NEW, тоже конвертировалась — иначе на неперенесённых строках
    // (перенос опт-ин, MIGRATE_LEAD_STATUSES) студент бы молча не создавался.
    if (
      dto.status === ApplicationStatus.IN_PROCESSING &&
      NEW_LEAD_APPLICATION_STATUSES.includes(existing.status) &&
      !existing.studentId
    ) {
      // Email у студента уникален. Если ученик с этим email уже есть — это
      // тот же человек: привязываем заявку к нему, а не создаём второго.
      // Любая другая ошибка создания — наружу, и статус НЕ меняется (раньше
      // ошибка глоталась, заявка уходила «в обработку» без ученика молча).
      let studentId = existing.studentId;
      const email = existing.email?.trim() || null;
      const sameEmail = email
        ? await this.prisma.student.findUnique({ where: { email }, select: { id: true } })
        : null;
      if (sameEmail) studentId = sameEmail.id;
      else {
        // По ТЗ §8 — все доп. поля из Application переносим в Student
        // (раньше терялись secondaryPhone, preferredChannel — менеджеру
        // пришлось бы заполнять заново).
        const phones: string[] = [existing.phone];
        const phoneLabels: string[] = ['сам'];
        // WhatsApp кладём в тот же массив phones[] — это принятая в модели
        // Student конвенция для «дополнительных» номеров (phones[0] основной,
        // phoneLabels[i] — подпись). Дубль не добавляем: на лендинге чекбокс
        // «тот же номер» включён по умолчанию, и WhatsApp обычно совпадает
        // с основным телефоном.
        const waPhone = (existing as any).whatsappPhone as string | null;
        if (waPhone && !phones.includes(waPhone)) {
          phones.push(waPhone);
          phoneLabels.push('WhatsApp');
        }
        if ((existing as any).secondaryPhone) {
          phones.push((existing as any).secondaryPhone);
          phoneLabels.push((existing as any).secondaryContactLabel || '');
        }
        // Подтверждено ли направление на момент конвертации: либо менеджер
        // прислал его этим же PATCH'ем, либо оно уже было настоящим на заявке.
        const directionConfirmed =
          dto.direction != null || existing.directionConfirmed;
        const studentData: any = {
          fullName: existing.fullName,
          // Дата рождения из заявки → в карточку студента, иначе cron
          // birthdayGreetings никогда бы не сработал для лидов с лендинга.
          // Student создаётся здесь с нуля, так что перезаписывать нечего.
          birthday: (existing as any).birthday ?? null,
          phones,
          phoneLabels,
          preferredChannel: (existing as any).preferredChannel ?? null,
          email: existing.email,
          // Плейсхолдер приходится скопировать (Student.direction — NOT NULL),
          // но он переезжает ВМЕСТЕ с пометкой directionConfirmed. Иначе на
          // студенте он становился бы неотличим от ответа клиента, а вернуться
          // к правде было бы уже неоткуда: заявку менеджеру пришлось бы
          // открывать отдельно.
          direction: effectiveDirection,
          directionConfirmed,
          // Кабинет — это маршрутизация/владение в CRM (см. common/cabinets.ts),
          // и выводить его из плейсхолдера нельзя: CABINET_BY_DIRECTION.BACHELOR
          // = 1, поэтому 100% лидов с лендинга оседали бы в кабинете 1, а
          // кабинеты 2–6 переставали бы наполняться новым потоком вообще.
          // Пока направление не подтверждено, пишем DEFAULT_CABINET ЯВНО —
          // это «приёмник» до решения менеджера, а не итог маршрутизации.
          // Как только направление проставят (в карточке заявки до конвертации
          // или в карточке студента после — StudentsService.update), кабинет
          // пересчитается по CABINET_BY_DIRECTION.
          cabinet: directionConfirmed
            ? CABINET_BY_DIRECTION[effectiveDirection]
            : DEFAULT_CABINET,
          // Страна — единственный настоящий ответ клиента о его цели
          // («Кишвар» вместо снятого вопроса «Ҳадаф»). Переносим её на
          // студента, иначе после конвертации намерение восстанавливалось бы
          // только из исходной Application.
          country: (existing as any).country ?? null,
          comment: existing.comment,
        };
        try {
          const student = await this.prisma.student.create({ data: studentData });
          studentId = student.id;
        } catch (e: any) {
          // Гонка: ученика с этим email завели между проверкой и созданием.
          const again = e?.code === 'P2002' && email
            ? await this.prisma.student.findUnique({ where: { email }, select: { id: true } })
            : null;
          if (!again) {
            throw new BadRequestException(
              'Не удалось создать ученика из заявки — статус не изменён. Попробуйте ещё раз.',
            );
          }
          studentId = again.id;
        }
      }
      const updated = await this.prisma.application.update({
        where: { id },
        data: { ...data, ...(studentId ? { studentId } : {}) },
        include: MANAGER_INCLUDE,
      });

      // Реферальная атрибуция с лендинга привязана к ЗАЯВКЕ: в момент
      // отправки формы Student ещё не существовал, поэтому в строке
      // ReferralAttribution.studentId = null. Здесь студент наконец создан —
      // проставляем его id. Без этого back-fill'а PaymentsService при
      // подтверждении оплаты ищет партнёра по studentId, ничего не находит,
      // и комиссия партнёру не начисляется никогда.
      if (updated.studentId) {
        try {
          await this.prisma.referralAttribution.updateMany({
            where: { applicationId: id, studentId: null },
            data: { studentId: updated.studentId },
          });
        } catch {
          // Не валим смену статуса из-за партнёрской таблицы — поиск
          // атрибуции (ReferralsService.findAttribution) всё равно умеет
          // искать по applicationId, в том числе по всем заявкам студента.
        }
      }

      this.realtime.emitApplication('application:updated', updated, { application: updated }, [existing.managerId, existing.chinaManagerId]);
      if (updated.studentId) {
        this.realtime.emitStudent(updated.studentId, 'student:updated', { studentId: updated.studentId });
      }
      // SMS студенту: статус изменился на «В обработке». Здесь next всегда
      // IN_PROCESSING, то есть статус клиентский и текст будет непустым, но
      // проверку держим общей — правило «шлём, только если есть что сказать»
      // одно на оба места вызова.
      const text = this.smsTextForStatus(existing.status, ApplicationStatus.IN_PROCESSING);
      if (text) {
        this.resolvePhone(updated).then((phone) => {
          if (phone) this.sms.send(phone, text).catch(() => undefined);
        }).catch(() => undefined);
      }

      // ActivityLog
      this.activity
        .log({
          actorId: user.id,
          actorName: '',
          actorRole: user.role,
          action: 'STATUS_CHANGE',
          studentId: updated.studentId,
          studentName: updated.fullName,
          details: `Статус: ${existing.status} → ${updated.status}`,
        })
        .catch(() => undefined);
      return updated;
    }

    // Гейт DOCS_SUBMITTED удалён по запросу: менеджер должен иметь возможность
    // переводить заявку на следующий этап даже если не все документы загружены
    // (документы могут быть переданы по другим каналам, или клиент просит
    // двигаться дальше). Список недостающих документов всё ещё доступен для
    // справки через `missingRequiredDocs` и UI-предупреждение в CRM.

    const updated = await this.prisma.application.update({
      where: { id },
      data,
      include: MANAGER_INCLUDE,
    });

    // Зеркало синхронизации из StudentsService.update: менеджер проставил
    // направление в карточке ЗАЯВКИ, а студент из неё уже сконвертирован —
    // до-маршрутизируем студента. Условие directionConfirmed:false в where
    // делает это безопасным и идемпотентным: студента, чьё направление уже
    // подтверждено (заведён вручную или менеджер правил его карточку),
    // не трогаем — у него cabinet мог быть выставлен руками.
    if (dto.direction != null && updated.studentId) {
      await this.prisma.student
        .updateMany({
          where: { id: updated.studentId, directionConfirmed: false },
          data: {
            direction: dto.direction,
            directionConfirmed: true,
            cabinet: CABINET_BY_DIRECTION[dto.direction],
          },
        })
        .catch(() => undefined);
    }

    this.realtime.emitApplication('application:updated', updated, { application: updated }, [existing.managerId, existing.chinaManagerId]);
    if (updated.studentId) {
      this.realtime.emitStudent(updated.studentId, 'student:updated', { studentId: updated.studentId });
      this.realtime.emitStudent(updated.studentId, 'application:updated', { application: updated });
    }

    // SMS клиенту — ТОЛЬКО по клиентским статусам. Переход во внутреннюю
    // квалификацию («Думает», «До 17 лет», «Некачественные лиды») меняет
    // строку и пишется в ActivityLog ниже, но клиента не касается: SMS про
    // него не уходит (smsTextForStatus вернёт null). ActivityLog при этом
    // ведём по-прежнему на КАЖДУЮ смену — это внутренняя история заявки.
    if (dto.status && dto.status !== existing.status) {
      const text = this.smsTextForStatus(existing.status, dto.status);
      if (text) {
        this.resolvePhone(updated).then((phone) => {
          if (phone) this.sms.send(phone, text).catch(() => undefined);
        }).catch(() => undefined);
      }
    }

    // ActivityLog для смены статуса
    if (dto.status && dto.status !== existing.status) {
      this.activity
        .log({
          actorId: user.id,
          actorName: '',
          actorRole: user.role,
          action: 'STATUS_CHANGE',
          studentId: updated.studentId,
          studentName: updated.fullName,
          details: `Статус: ${existing.status} → ${dto.status}`,
        })
        .catch(() => undefined);
    }

    // ActivityLog для признака долга. Раньше долг выражался статусом
    // AWAITING_PAYMENT, и его снятие попадало в журнал само собой — веткой
    // STATUS_CHANGE выше. Теперь это отдельная колонка (paymentPending), на
    // которой целиком держится раздел «Задолженность студентов», поэтому
    // логируем её отдельно: иначе «почему клиент исчез из должников»
    // становится вопросом без ответа. Action — FINANCE_UPDATE, чтобы такие
    // записи находились тем же фильтром /activity, что и правки транзакций.
    if (
      dto.paymentPending !== undefined &&
      dto.paymentPending !== existing.paymentPending
    ) {
      this.activity
        .log({
          actorId: user.id,
          actorName: '',
          actorRole: user.role,
          action: 'FINANCE_UPDATE',
          studentId: updated.studentId,
          studentName: updated.fullName,
          details: dto.paymentPending
            ? 'Задолженность: отмечена («ждёт оплаты»)'
            : 'Задолженность: снята',
        })
        .catch(() => undefined);
    }

    return updated;
  }

  async assignManager(
    id: string,
    patch: { managerId?: string | null; chinaManagerId?: string | null },
    user: CurrentUser,
  ) {
    // Рубеж 1 — ПРАВО ВООБЩЕ ТРОГАТЬ НАЗНАЧЕНИЕ.
    // Для носителя активной кастомной роли решает только явный
    // 'applications:assign': RolesGuard на этом эндпоинте пропускает и по
    // неявной проверке URL, где любой write-пермишен раздела ('/applications')
    // засчитывается одинаково — то есть роль с одним лишь «Заявки —
    // редактирование» дошла бы сюда. Базовые роли — как раньше.
    if (!canTouchApplicationManager(user as any)) {
      throw new ForbiddenException('Недостаточно прав для назначения менеджера');
    }
    const existing = await this.findOne(id);
    // По ТЗ §7: переназначение между сотрудниками — ТОЛЬКО ADMIN/FOUNDER.
    // Не-elevated (SALES_MANAGER/CLIENT_MANAGER) могут:
    //   • взять неназначенный лид себе (managerId/chinaManagerId === null)
    //   • снять себя с лида (присвоить null)
    // Но НЕ могут передать чужой лид кому-то другому. Это закрывает дыру
    // когда SM мог отнять чужого клиента, и аудит-замечание из код-ревью.
    // Рубеж 2 — ОБЪЁМ прав. Раньше здесь стоял голый isElevated(), слепой к
    // hasCustomRole: квалификатор лидов с applications:assign, но с
    // технической подложкой SALES_MANAGER, попадал в ветку «не-elevated» и
    // мог взять лид только на себя — то есть не мог распределить ни одного,
    // а сам пермишен не значил ничего (см. application-access.ts).
    if (!canReassignApplicationManager(user as any)) {
      const slot: 'managerId' | 'chinaManagerId' | null =
        patch.managerId !== undefined ? 'managerId' :
        patch.chinaManagerId !== undefined ? 'chinaManagerId' : null;
      if (!slot) {
        throw new ForbiddenException('Нет изменений');
      }
      this.assertOwnSlotChangeOnly(
        user,
        (existing as any)[slot] as string | null,
        patch[slot] as string | null | undefined,
      );
    }

    const data: any = {};
    if (patch.managerId !== undefined) {
      if (patch.managerId) {
        const exists = await this.prisma.user.findUnique({ where: { id: patch.managerId } });
        if (!exists) throw new NotFoundException('Локальный менеджер не найден');
        if (exists.isActive === false) throw new BadRequestException('Менеджер уволен');
      }
      data.managerId = patch.managerId;
    }
    if (patch.chinaManagerId !== undefined) {
      if (patch.chinaManagerId) {
        const exists = await this.prisma.user.findUnique({ where: { id: patch.chinaManagerId } });
        if (!exists) throw new NotFoundException('Китайский менеджер не найден');
        if (exists.isActive === false) throw new BadRequestException('Менеджер уволен');
      }
      data.chinaManagerId = patch.chinaManagerId;
    }

    // Синхронизируем менеджеров на связанном студенте
    if (existing.studentId && Object.keys(data).length > 0) {
      await this.prisma.student.update({
        where: { id: existing.studentId },
        data,
      });
    }

    const updated = await this.prisma.application.update({
      where: { id },
      data,
      include: MANAGER_INCLUDE,
    });
    this.realtime.emitApplication('application:updated', updated, { application: updated }, [existing.managerId, existing.chinaManagerId]);
    if (updated.studentId) {
      this.realtime.emitStudent(updated.studentId, 'student:updated', { studentId: updated.studentId });
    }

    // ActivityLog + уведомление о смене менеджера
    const beforeManager = existing.manager?.fullName || '—';
    const afterManager = updated.manager?.fullName || '—';
    const beforeChina = existing.chinaManager?.fullName || '—';
    const afterChina = updated.chinaManager?.fullName || '—';
    const detailsParts: string[] = [];
    if (patch.managerId !== undefined && existing.managerId !== updated.managerId) {
      detailsParts.push(managerChangeDetails('🇹🇯', beforeManager, afterManager));
    }
    if (patch.chinaManagerId !== undefined && existing.chinaManagerId !== updated.chinaManagerId) {
      detailsParts.push(managerChangeDetails('🇨🇳', beforeChina, afterChina));
    }
    if (detailsParts.length > 0) {
      const details = detailsParts.join('; ');
      this.activity
        .log({
          actorId: user.id,
          actorRole: user.role,
          action: 'MANAGER_CHANGE',
          studentId: updated.studentId,
          studentName: updated.fullName,
          details,
        })
        .catch(() => undefined);

      // О переназначении — руководству, старому и новому менеджеру.
      this.notifications
        .notifyAudience('applications', [updated.managerId, updated.chinaManagerId, existing.managerId, existing.chinaManagerId], {
          type: 'MANAGER_CHANGE',
          title: 'Менеджер изменён',
          message: `${updated.fullName}: ${details}`,
          payload: { applicationId: updated.id, studentId: updated.studentId },
        })
        .catch(() => undefined);
    }

    return updated;
  }

  /**
   * ОБЪЁМ прав сотрудника БЕЗ права раздавать лиды (см.
   * canReassignApplicationManager): взять свободный лид себе или снять
   * себя — и только. Чужой лид не трогает вообще, свой передать другому не
   * может (ТЗ §7: переназначение между сотрудниками — только руководство).
   *
   * Вынесено из assignManager в отдельный метод, потому что то же правило
   * обязано стоять и перед массовым назначением: вторая копия условия
   * разошлась бы с первой при первой же правке, а массовая ручка — это
   * способ нарушить правило сразу на двадцати пяти лидах.
   */
  private assertOwnSlotChangeOnly(
    user: CurrentUser,
    currentOwner: string | null,
    requested: string | null | undefined,
  ) {
    // 1) Слот пустой → можно присвоить только себе.
    if (!currentOwner) {
      if (requested !== null && requested !== user.id) {
        throw new ForbiddenException('Можно взять лид только на себя');
      }
      return;
    }
    // 2) Слот занят:
    //    a) текущий владелец — я → могу снять (null), но НЕ могу передать другому
    //    b) текущий владелец — не я → не могу трогать вообще
    if (currentOwner !== user.id) {
      throw new ForbiddenException('Лид назначен другому сотруднику — обратись к админу');
    }
    if (requested !== null && requested !== user.id) {
      throw new ForbiddenException('Передать лид другому сотруднику может только админ');
    }
  }

  /**
   * МАССОВОЕ НАЗНАЧЕНИЕ МЕНЕДЖЕРА (экран /leads: отметил галочками пачку
   * лидов → выбрал менеджера → «Назначить»).
   *
   * ПОЧЕМУ ОТДЕЛЬНАЯ РУЧКА, А НЕ N ВЫЗОВОВ PATCH /:id/manager С ФРОНТА.
   *  • Одиночное назначение шлёт notifyAllStaff («Менеджер изменён») на
   *    КАЖДЫЙ лид: 25 лидов = 25 уведомлений каждому сотруднику. Здесь —
   *    одно сводное.
   *  • Глобальный троттлер режет 60 запросов в минуту: очередь в 73 лида
   *    упёрлась бы в 429 на середине, оставив пачку назначенной наполовину.
   *  • Пачка обязана быть атомарной: либо назначены все, либо никто.
   *    Полуприменённое массовое действие — худший исход: человек не знает,
   *    какие строки «проскочили», и идёт сверять глазами.
   *
   * ЧТО ОБЩЕЕ С ОДИНОЧНЫМ ПУТЁМ (и обязано таким оставаться): те же два
   * рубежа прав, зеркалирование менеджера на Student, realtime по каждому
   * лиду (карточка заявки перечитывается по application.id из события),
   * запись ActivityLog(MANAGER_CHANGE) ПО КАЖДОМУ лиду — аудит по клиенту
   * остаётся точным, сводным бывает только уведомление.
   *
   * ПЕРЕНАЗНАЧЕНИЕ ТРЕБУЕТ ЯВНОГО ПОДТВЕРЖДЕНИЯ. Если среди выбранных есть
   * лиды, уже закреплённые за ДРУГИМ менеджером, без confirmReassign=true
   * ручка ничего не меняет и отвечает 409 с разбивкой «у кого сколько».
   * CRM спрашивает подтверждение сама, по своему кешу, — но кеш может
   * отстать (лид только что назначил коллега), и тогда молча затёртое
   * чужое назначение стало бы сюрпризом. Поэтому последнее слово за
   * сервером: он видит строки под блокировкой, а не снимок минутной давности.
   *
   * Массово только НАЗНАЧАЕМ (managerId обязателен). Снять менеджера с пачки
   * нельзя намеренно: это редкое действие, а цена ошибки — двадцать пять
   * лидов без хозяина; в строке списка снять по-прежнему можно.
   */
  async bulkAssignManager(
    body: { ids?: unknown; managerId?: unknown; confirmReassign?: unknown },
    user: CurrentUser,
  ) {
    // Рубеж 1 — тот же, что у assignManager.
    if (!canTouchApplicationManager(user as any)) {
      throw new ForbiddenException('Недостаточно прав для назначения менеджера');
    }

    // Тело приходит как есть: у ручки нет DTO-класса (как и у одиночной), и
    // ValidationPipe его не проверяет. Любой из этих случаев без проверки
    // превратился бы в 500 из недр Prisma вместо внятного 400.
    const rawIds = Array.isArray(body?.ids) ? (body.ids as unknown[]) : null;
    if (!rawIds || rawIds.length === 0) {
      throw new BadRequestException('Не выбрано ни одного лида');
    }
    if (rawIds.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new BadRequestException('Некорректный список лидов');
    }
    // Дубли в списке схлопываем: иначе сверка «нашли столько же, сколько
    // просили» ниже ложно сработала бы на повторе одного id.
    const ids = [...new Set((rawIds as string[]).map((x) => x.trim()))];
    if (ids.length > BULK_ASSIGN_MAX) {
      throw new BadRequestException(
        `За один раз можно назначить не больше ${BULK_ASSIGN_MAX} лидов`,
      );
    }
    const managerId = typeof body?.managerId === 'string' ? body.managerId.trim() : '';
    if (!managerId) throw new BadRequestException('Не выбран менеджер');
    const confirmReassign = body?.confirmReassign === true;

    const manager = await this.prisma.user.findUnique({
      where: { id: managerId },
      select: { id: true, fullName: true, isActive: true },
    });
    if (!manager) throw new NotFoundException('Локальный менеджер не найден');
    // Строже одиночного пути намеренно: деактивированный сотрудник в систему
    // не войдёт, и пачка лидов, назначенная на него, просто ляжет мёртвым
    // грузом. Один лид так потерять неприятно, двадцать пять — уже инцидент.
    if (manager.isActive === false) {
      throw new BadRequestException('Сотрудник деактивирован — назначить на него лиды нельзя');
    }

    const canReassign = canReassignApplicationManager(user as any);

    const { changed, unchangedCount, reassignedCount } = await this.prisma.$transaction(
      async (tx) => {
        // Блокируем строки ДО чтения: решение «кого переназначаем» и сама
        // запись обязаны видеть одно и то же состояние. Без FOR UPDATE
        // коллега мог бы назначить лид между нашим SELECT и UPDATE — и
        // подтверждение, которое дал пользователь, этого лида не покрывало
        // бы. ORDER BY — чтобы две пересекающиеся пачки брали блокировки в
        // одном порядке и не ловили взаимную блокировку.
        await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;

        const existing = await tx.application.findMany({
          where: { id: { in: ids } },
          include: MANAGER_INCLUDE,
        });
        if (existing.length !== ids.length) {
          // Лид удалили, пока человек ставил галочки. Назначать «тех, что
          // остались» не станем: пользователь подтверждал другую пачку.
          throw new ConflictException(
            'Часть выбранных лидов уже удалена — обновите список и повторите',
          );
        }

        // Рубеж 2 — по КАЖДОМУ лиду, тем же правилом, что и одиночный путь.
        if (!canReassign) {
          for (const app of existing) {
            this.assertOwnSlotChangeOnly(user, app.managerId, managerId);
          }
        }

        const toChange = existing.filter((a) => a.managerId !== managerId);
        const reassigned = toChange.filter((a) => !!a.managerId);

        if (reassigned.length > 0 && !confirmReassign) {
          const byManager = new Map<
            string,
            { managerId: string; managerName: string; count: number }
          >();
          for (const a of reassigned) {
            const key = a.managerId as string;
            const row = byManager.get(key) || {
              managerId: key,
              managerName: a.manager?.fullName || '—',
              count: 0,
            };
            row.count += 1;
            byManager.set(key, row);
          }
          throw new ConflictException({
            statusCode: 409,
            code: BULK_REASSIGN_CONFIRM_REQUIRED,
            message:
              'Часть выбранных лидов уже назначена другим менеджерам — нужно подтверждение',
            total: existing.length,
            reassignCount: reassigned.length,
            conflicts: [...byManager.values()].sort((x, y) => y.count - x.count),
          });
        }

        if (toChange.length === 0) {
          return {
            changed: [] as ChangedLead[],
            unchangedCount: existing.length,
            reassignedCount: 0,
          };
        }

        const changeIds = toChange.map((a) => a.id);
        // Зеркалим менеджера на связанных студентов — как одиночный путь.
        const studentIds = toChange
          .map((a) => a.studentId)
          .filter((x): x is string => !!x);
        if (studentIds.length > 0) {
          await tx.student.updateMany({
            where: { id: { in: studentIds } },
            data: { managerId },
          });
        }
        await tx.application.updateMany({
          where: { id: { in: changeIds } },
          data: { managerId },
        });
        const updatedRows = await tx.application.findMany({
          where: { id: { in: changeIds } },
          include: MANAGER_INCLUDE,
        });
        const beforeById = new Map(toChange.map((a) => [a.id, a]));
        const changedLeads: ChangedLead[] = updatedRows.map((u) => ({
          updated: u,
          beforeManagerName: beforeById.get(u.id)?.manager?.fullName || '—',
        }));
        return {
          changed: changedLeads,
          unchangedCount: existing.length - toChange.length,
          reassignedCount: reassigned.length,
        };
      },
      // Пять запросов, но пачка до BULK_ASSIGN_MAX строк и БД за прокси:
      // дефолтные 5 с интерактивной транзакции оставляют слишком мало запаса.
      { timeout: 20_000, maxWait: 10_000 },
    );

    // Всё ниже — ПОСЛЕ коммита: событие про незакоммиченную строку заставило
    // бы клиента перечитать старое значение.
    //
    // ОДНО realtime-событие на всю пачку, а не application:updated на каждый
    // лид. Списки в CRM на каждое такое событие перечитывают GET
    // /applications: пачка из 25 лидов превращалась бы в 25 запросов с
    // КАЖДОГО открытого экрана у КАЖДОГО сотрудника, а глобальный троттлер
    // даёт 60 запросов в минуту — два массовых назначения подряд выбивали бы
    // коллегам 429 на их собственной работе. В событии только id: открытая
    // карточка заявки сверяет свой id со списком и перечитывается сама.
    if (changed.length > 0) {
      this.realtime.emitStaff(APPLICATIONS_BULK_UPDATED_EVENT, {
        applicationIds: changed.map((c) => c.updated.id),
        studentIds: changed.map((c) => c.updated.studentId).filter((x): x is string => !!x),
        managerId: manager.id,
      });
    }
    for (const { updated, beforeManagerName } of changed) {
      if (updated.studentId) {
        this.realtime.emitStudent(updated.studentId, 'student:updated', {
          studentId: updated.studentId,
        });
      }
      this.activity
        .log({
          actorId: user.id,
          actorRole: user.role,
          action: 'MANAGER_CHANGE',
          studentId: updated.studentId,
          studentName: updated.fullName,
          details: `${managerChangeDetails('🇹🇯', beforeManagerName, manager.fullName)} (массовое назначение)`,
        })
        .catch(() => undefined);
    }

    if (changed.length > 0) {
      // ОДНО сводное уведомление на всю пачку. Тип тот же, что у одиночного
      // назначения, — колокольчик его уже знает. В payload нет applicationId
      // намеренно: заявок много, вести клик на одну из них некуда.
      this.notifications
        .notifyAudience('applications', [manager.id], {
          type: 'MANAGER_CHANGE',
          title: 'Лиды назначены',
          message: `${pluralLeadsAssigned(changed.length)} → ${manager.fullName}`,
          payload: {
            bulk: true,
            count: changed.length,
            managerId: manager.id,
            applicationIds: changed.map((c) => c.updated.id),
          },
        })
        .catch(() => undefined);
    }

    return {
      updated: changed.map((c) => c.updated),
      changed: changed.length,
      unchanged: unchangedCount,
      reassigned: reassignedCount,
      manager: { id: manager.id, fullName: manager.fullName },
    };
  }

  private async missingRequiredDocs(studentId: string): Promise<string[]> {
    const docs = await this.prisma.document.findMany({
      where: { studentId },
      select: { type: true },
    });
    const uploaded = new Set(docs.map((d) => d.type));
    return REQUIRED_DOCUMENT_TYPES.filter((t) => !uploaded.has(t.type)).map((t) => t.label);
  }

  async remove(id: string, user: CurrentUser) {
    // Удаление заявки — elevated (FOUNDER/ADMIN/ACCOUNTANT с мульти-роли).
    // Раньше primary-only `user.role !== 'ADMIN'` блокировало FOUNDER
    // и любого ADMIN'а назначенного через secondary roles[] (ТЗ §2).
    if (!isElevated(user as any)) {
      throw new ForbiddenException('Удалять заявки может только администрация');
    }
    const app = await this.findOne(id);
    if (app.studentId) {
      await this.prisma.student.delete({ where: { id: app.studentId } }).catch(() => undefined);
    }
    await this.prisma.application.delete({ where: { id } }).catch(() => undefined);
    this.realtime.emitStaff('application:deleted', { id });
    return { ok: true };
  }

  /**
   * @param range — опциональный период дашборда. Фильтрует по ДАТЕ СОЗДАНИЯ
   *   заявки (Application.createdAt), т.е. все карточки читаются как
   *   «из заявок, созданных за период, сколько сейчас в таком-то статусе».
   *   Границы уже разобраны контроллером через общий parseDate (TJT).
   *   Без периода where остаётся ровно прежним — «за всё время».
   */
  async stats(
    user?: { id: string; role: Role; roles?: Role[] },
    range?: { from?: Date; to?: Date },
  ) {
    // Менеджеры видят только свои заявки. Elevated (FOUNDER/ADMIN/ACCOUNTANT) — все.
    const scope: Prisma.ApplicationWhereInput | undefined =
      user && !isElevated(user)
        ? { OR: [{ managerId: user.id }, { chinaManagerId: user.id }] }
        : undefined;
    // Период накладывается ПОВЕРХ скоупа, не заменяя его: менеджер и с
    // фильтром по месяцу обязан видеть только свои заявки.
    const createdAt = dateRangeFilter(range);
    const where: Prisma.ApplicationWhereInput | undefined = createdAt
      ? { ...(scope ?? {}), createdAt }
      : scope;
    const [total, byStatus, byDirection, byCountry, directionUnconfirmed] = await Promise.all([
      this.prisma.application.count({ where }),
      this.prisma.application.groupBy({ by: ['status'], _count: true, where }),
      // Только подтверждённые направления. Заявки с лендинга носят
      // плейсхолдер DEFAULT_DIRECTION, и без этого условия дашборд
      // рапортовал бы 100% входящего трафика как «Бакалавриат».
      this.prisma.application.groupBy({
        by: ['direction'],
        _count: true,
        where: { ...where, directionConfirmed: true },
      }),
      // Страна — то, что клиент теперь РЕАЛЬНО выбирает в форме. Это и есть
      // осмысленный срез входящего трафика вместо фальшивых направлений.
      // country IS NULL отсекаем: это заявки до релиза новой формы, плюс всё,
      // что создано в обход формы (CRM через StudentsService, самозапись,
      // approve заявки партнёра) — в разрезе «по странам» они не ответ,
      // а отсутствие ответа (их видно как total − сумма строк).
      this.prisma.application.groupBy({
        by: ['country'],
        _count: true,
        where: { ...where, country: { not: null } },
      }),
      // Сколько заявок ждут, пока менеджер проставит направление руками.
      // Дашборд показывает это рядом со срезом «по направлениям», иначе
      // тот выглядел бы просто «пустым» без объяснения причины.
      this.prisma.application.count({ where: { ...where, directionConfirmed: false } }),
    ]);
    return { total, byStatus, byDirection, byCountry, directionUnconfirmed };
  }
}

/** Ключ номера для поиска повторов: последние 9 цифр; короче 7 цифр — не номер, не сравниваем. */
function phoneKey(phone: string): string | null {
  const d = (phone || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-9) : null;
}

/** То же сравнение, что у таблиц CRM (components/TableSort.tsx). */
const SORT_COLLATOR = new Intl.Collator(['ru', 'tg', 'en'], { sensitivity: 'base', numeric: true });

type SortRow = {
  fullName: string; phone: string; country: string | null; direction: string; directionConfirmed: boolean;
  source: string; status: string; manager: { fullName: string } | null;
};
const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
/**
 * Значение колонки для серверной сортировки. Колонки-списки — по рангу
 * подписи из CRM; значение без ранга — в конец. Неподтверждённое
 * направление в таблице — прочерк, и в сортировке тоже пусто.
 */
const SORT_VALUE: Record<string, (row: SortRow, rank: Map<string, number>) => string | number | null> = {
  fullName: (r) => text(r.fullName),
  phone: (r) => text(r.phone),
  manager: (r) => text(r.manager?.fullName),
  country: (r, rank) => (r.country ? rank.get(r.country) ?? null : null),
  direction: (r, rank) => (r.directionConfirmed === false ? null : rank.get(r.direction) ?? null),
  source: (r, rank) => rank.get(r.source || 'OTHER') ?? null,
  status: (r, rank) => rank.get(r.status) ?? null,
};
