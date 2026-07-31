import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { ApplicationSource, ApplicationStatus, Country, Direction, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { ActivityService } from '../activity/activity.service';
import { isElevated } from '../auth/role-utils';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { REQUIRED_DOCUMENT_TYPES } from '../common/documents';
import { ReferralsService } from '../partners/referrals.service';
import { SalesService } from '../sales/sales.service';
import { CABINET_BY_DIRECTION, DEFAULT_CABINET } from '../common/cabinets';
import { parseCalendarDateUtc, tjYMD } from '../common/tj-time';
import {
  ACTIVE_APPLICATION_STATUSES,
  CLIENT_SMS_STATUS_LABEL,
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

type CurrentUser = { id: string; role: Role };

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

  async create(dto: CreateApplicationDto & { ref?: string }) {
    // Валидируем дату рождения ДО любых side-effect'ов (создание заявки,
    // назначение менеджера, реферальная атрибуция) — иначе при 400 в БД
    // осталась бы половинчатая заявка.
    const birthday = this.parseBirthday(dto.birthday);

    // Sprint E: авто-распределение лидов. Если managerId не задан явно —
    // round-robin среди SALES_MANAGER (наименее загруженный).
    let assignedManagerId: string | null = null;
    let pipelineId: string | null = null;
    let pipelineStageId: string | null = null;
    if (this.sales) {
      try { assignedManagerId = await this.sales.pickManagerForLead(); }
      catch { /* fallback: оставляем без менеджера */ }
      // Авто-проставление дефолтной воронки и её первого этапа.
      try {
        const def = await this.sales.pickDefaultPipelineStage();
        pipelineId = def.pipelineId;
        pipelineStageId = def.pipelineStageId;
      } catch { /* без воронки — норм */ }
    }
    const app = await this.prisma.application.create({
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
        programId: dto.programId || null,
        source: dto.source || 'LANDING_FORM',
        managerId: assignedManagerId,
        pipelineId,
        pipelineStageId,
      },
    });

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

    await this.notifications.notifyAllStaff({
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

    this.realtime.emitStaff('application:new', { application: app });
    return app;
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
    currentUserId?: string;
    currentUserRole?: Role;
    currentUserRoles?: Role[];
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
    if (filters.country) where.country = filters.country;
    if (filters.source) where.source = filters.source;
    // Менеджеры (SALES_MANAGER/CLIENT_MANAGER) всегда видят только свои
    // заявки. FOUNDER/ADMIN/ACCOUNTANT — все, если только не запросили mine.
    const elevated = isElevated({
      role: filters.currentUserRole,
      roles: filters.currentUserRoles,
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
    if (filters.managerUserId) {
      and.push({
        OR: [
          { managerId: filters.managerUserId },
          { chinaManagerId: filters.managerUserId },
        ],
      });
    }
    if (filters.search) {
      and.push({
        OR: [
          { fullName: { contains: filters.search, mode: 'insensitive' } },
          { phone: { contains: filters.search, mode: 'insensitive' } },
          { email: { contains: filters.search, mode: 'insensitive' } },
        ],
      });
    }
    if (and.length) where.AND = and;
    return this.prisma.application.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: MANAGER_INCLUDE,
    });
  }

  async findOne(id: string) {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: MANAGER_INCLUDE,
    });
    if (!app) throw new NotFoundException('Заявка не найдена');
    return app;
  }

  private ensureCanEdit(
    app: { managerId: string | null; chinaManagerId?: string | null },
    user: CurrentUser,
  ) {
    // Elevated (FOUNDER/ADMIN/ACCOUNTANT, мульти-роли учтены) могут
    // редактировать любую заявку. Раньше было `user.role === 'ADMIN'`
    // — блокировало FOUNDER и игнорировало мульти-роли.
    if (isElevated(user as any)) return;
    const assigned = app.managerId || app.chinaManagerId;
    if (!assigned) return; // ещё не назначен — любой может взять в работу
    if (app.managerId === user.id || app.chinaManagerId === user.id) return;
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
      // Создаём студента только если email уникален (он обязателен для ЛК)
      // Старый флоу (без email) — пропускаем, студент создастся при отдельном действии
      let studentId = existing.studentId;
      try {
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
        const student = await this.prisma.student.create({ data: studentData });
        studentId = student.id;
      } catch {
        // Если студент с таким email уже есть — просто переводим статус без создания
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
          // Не валим смену статуса из-за партнёрской таблицы —
          // resolvePartner всё равно умеет искать по applicationId.
        }
      }

      this.realtime.emitStaff('application:updated', { application: updated });
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

    this.realtime.emitStaff('application:updated', { application: updated });
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
    const existing = await this.findOne(id);
    // По ТЗ §7: переназначение между сотрудниками — ТОЛЬКО ADMIN/FOUNDER.
    // Не-elevated (SALES_MANAGER/CLIENT_MANAGER) могут:
    //   • взять неназначенный лид себе (managerId/chinaManagerId === null)
    //   • снять себя с лида (присвоить null)
    // Но НЕ могут передать чужой лид кому-то другому. Это закрывает дыру
    // когда SM мог отнять чужого клиента, и аудит-замечание из код-ревью.
    if (!isElevated(user as any)) {
      const slot: 'managerId' | 'chinaManagerId' | null =
        patch.managerId !== undefined ? 'managerId' :
        patch.chinaManagerId !== undefined ? 'chinaManagerId' : null;
      if (!slot) {
        throw new ForbiddenException('Нет изменений');
      }
      const currentOwner = (existing as any)[slot] as string | null;
      const requested = patch[slot] as string | null | undefined;
      // 1) Слот пустой → можно присвоить только себе.
      if (!currentOwner) {
        if (requested !== null && requested !== user.id) {
          throw new ForbiddenException('Можно взять лид только на себя');
        }
      } else {
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
    }

    const data: any = {};
    if (patch.managerId !== undefined) {
      if (patch.managerId) {
        const exists = await this.prisma.user.findUnique({ where: { id: patch.managerId } });
        if (!exists) throw new NotFoundException('Локальный менеджер не найден');
      }
      data.managerId = patch.managerId;
    }
    if (patch.chinaManagerId !== undefined) {
      if (patch.chinaManagerId) {
        const exists = await this.prisma.user.findUnique({ where: { id: patch.chinaManagerId } });
        if (!exists) throw new NotFoundException('Китайский менеджер не найден');
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
    this.realtime.emitStaff('application:updated', { application: updated });
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
      detailsParts.push(`Менеджер 🇹🇯: ${beforeManager} → ${afterManager}`);
    }
    if (patch.chinaManagerId !== undefined && existing.chinaManagerId !== updated.chinaManagerId) {
      detailsParts.push(`Менеджер 🇨🇳: ${beforeChina} → ${afterChina}`);
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

      // Уведомления staff (всем) о переназначении
      this.notifications
        .notifyAllStaff({
          type: 'MANAGER_CHANGE',
          title: 'Менеджер изменён',
          message: `${updated.fullName}: ${details}`,
          payload: { applicationId: updated.id, studentId: updated.studentId },
        })
        .catch(() => undefined);
    }

    return updated;
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

  async stats(user?: { id: string; role: Role; roles?: Role[] }) {
    // Менеджеры видят только свои заявки. Elevated (FOUNDER/ADMIN/ACCOUNTANT) — все.
    const where: Prisma.ApplicationWhereInput | undefined =
      user && !isElevated(user)
        ? { OR: [{ managerId: user.id }, { chinaManagerId: user.id }] }
        : undefined;
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
