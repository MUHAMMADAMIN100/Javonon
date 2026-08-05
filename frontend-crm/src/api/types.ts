export type Role =
  | 'FOUNDER'
  | 'ADMIN'
  | 'ACCOUNTANT'
  | 'SALES_MANAGER'
  | 'CLIENT_MANAGER'
  // Legacy: бэкенд нормализует EMPLOYEE → SALES_MANAGER при разборе JWT,
  // но старые токены/кэш могут вернуть это значение до релогина.
  | 'EMPLOYEE';

export const ROLE_LABEL: Record<Role, string> = {
  FOUNDER: 'Основатель',
  ADMIN: 'Администратор',
  ACCOUNTANT: 'Бухгалтер',
  SALES_MANAGER: 'Менеджер по продажам',
  CLIENT_MANAGER: 'Клиентский менеджер',
  EMPLOYEE: 'Менеджер по продажам',
};
export type Direction =
  | 'BACHELOR'
  | 'MASTER'
  | 'LANGUAGE'
  | 'LANGUAGE_COLLEGE'
  | 'LANGUAGE_BACHELOR'
  | 'COLLEGE';
/**
 * Страна, которую клиент выбирает в форме лендинга («Кишвар»).
 * Соответствует Prisma enum Country (backend/prisma/schema.prisma) —
 * значения обязаны совпадать с БД, иначе backend вернёт 400
 * «Неизвестная страна» на фильтре GET /applications?country=…
 *
 * Заменяет собой старый вопрос «Ҳадаф» на лендинге, но НЕ заменяет
 * Direction: направление менеджер по-прежнему проставляет руками в CRM.
 */
export type Country =
  | 'USA'
  | 'KOREA'
  | 'CHINA'
  | 'LATVIA'
  | 'MALAYSIA'
  | 'ITALY'
  | 'GERMANY';

/** Порядок как на лендинге — чтобы дропдаун CRM читался так же, как форма. */
export const COUNTRIES: Country[] = [
  'USA',
  'KOREA',
  'CHINA',
  'LATVIA',
  'MALAYSIA',
  'ITALY',
  'GERMANY',
];

export const COUNTRY_LABEL: Record<Country, string> = {
  USA: 'США',
  KOREA: 'Корея',
  CHINA: 'Китай',
  LATVIA: 'Латвия',
  MALAYSIA: 'Малайзия',
  ITALY: 'Италия',
  GERMANY: 'Германия',
};

/**
 * Статус заявки. Соответствует Prisma enum ApplicationStatus.
 *
 * Актуальные значения — 10 исходов квалификации лида (см. APPLICATION_STATUSES).
 * Это НЕ воронка: «Вне города» и «До 17 лет» — не этапы, а причины отказа,
 * поэтому статус меняется выпадающим списком, а не кнопками «вперёд/назад».
 *
 * LEGACY-значения ниже удалять из типа НЕЛЬЗЯ: enum в Postgres additive-only
 * (старые строки на них ссылаются), а перенос строк на новые значения —
 * ЯВНО ОПТ-ИН на бэкенде (MIGRATE_LEAD_STATUSES, см.
 * backend/src/common/application-status.ts и DEPLOY.md). Пока его не прогнали
 * — а это может быть сколь угодно долго, — API реально отдаёт старые значения,
 * и тип обязан это описывать.
 *
 * ⚠️ Раньше здесь было написано, что «миграция rows идёт скриптом уже после
 * деплоя». Это неверно и в другую сторону опасно: в `start:prod` перенос
 * стоит в цепочке `&&` ПЕРЕД `node dist/main`, то есть отрабатывает, пока
 * трафик держит предыдущий контейнер. Именно поэтому его и сделали опт-ин.
 * Не используй старую формулировку как основание «легаси уже мигрировали,
 * хвосты можно удалять» — проверяй по БД.
 *
 * Из UI-списков легаси исключены (APPLICATION_STATUSES), но метку и badge для
 * них держим — иначе старая заявка отрисуется пустым бейджем с сырым ключом
 * enum.
 */
export type ApplicationStatus =
  // ===== актуальные =====
  | 'NEW_LEAD'
  | 'IN_PROCESSING'
  | 'ONLINE_CONSULTATION'
  | 'OFFLINE_CONSULTATION'
  | 'THINKING'
  | 'OUT_OF_TOWN'
  | 'UNDER_17'
  | 'POTENTIAL_LEAD'
  | 'LOW_QUALITY_LEAD'
  | 'SUCCESSFUL_LEAD'
  // ===== legacy (мигрируются скриптом migrate-lead-statuses.ts) =====
  | 'NEW'
  | 'DOCS_REVIEW'
  | 'DOCS_SUBMITTED'
  | 'PRE_ADMISSION'
  | 'AWAITING_PAYMENT'
  | 'ENROLLED'
  | 'IN_PROGRESS'
  | 'COMPLETED';

// Источник заявки — соответствует Prisma enum ApplicationSource
// (backend/prisma/schema.prisma). Значения обязаны совпадать с БД, иначе
// backend вернёт 400 «Неизвестный источник».
export type ApplicationSource =
  | 'LANDING_FORM'
  | 'SELF_REGISTRATION'
  | 'REFERRAL'
  | 'INSTAGRAM'
  | 'TELEGRAM'
  | 'GOOGLE_ADS'
  | 'TIKTOK'
  | 'WORD_OF_MOUTH'
  | 'EVENT'
  | 'OTHER';

export const APPLICATION_SOURCES: ApplicationSource[] = [
  'LANDING_FORM',
  'SELF_REGISTRATION',
  'REFERRAL',
  'INSTAGRAM',
  'TELEGRAM',
  'GOOGLE_ADS',
  'TIKTOK',
  'WORD_OF_MOUTH',
  'EVENT',
  'OTHER',
];

export const SOURCE_LABEL: Record<ApplicationSource, string> = {
  LANDING_FORM: 'Сайт',
  SELF_REGISTRATION: 'Самозапись',
  REFERRAL: 'Реферал',
  INSTAGRAM: 'Instagram',
  TELEGRAM: 'Telegram',
  GOOGLE_ADS: 'Google Ads',
  TIKTOK: 'TikTok',
  WORD_OF_MOUTH: 'Сарафан',
  EVENT: 'Мероприятие',
  OTHER: 'Другое',
};

// Разные цвета — чтобы источник считывался глазом за долю секунды
// в таблице из десятков заявок. Совпадают с общими badge-*
// классами приложения; для источников, у которых нет прямого
// цвета, используем inline background в компоненте (см. Applications.tsx).
export const SOURCE_BADGE: Record<ApplicationSource, string> = {
  LANDING_FORM: 'badge-info',
  SELF_REGISTRATION: 'badge-success',
  REFERRAL: 'badge-warning',
  INSTAGRAM: 'badge-instagram',
  TELEGRAM: 'badge-telegram',
  GOOGLE_ADS: 'badge-google',
  TIKTOK: 'badge-tiktok',
  WORD_OF_MOUTH: 'badge-gray',
  EVENT: 'badge-event',
  OTHER: 'badge-gray',
};

/**
 * Единственный список статусов, который предлагается пользователю —
 * во всех дропдаунах (фильтры списков и редактор статуса в карточке).
 * Порядок задан бизнесом и осмыслен: сверху свежие лиды, снизу исход.
 *
 * LEGACY сюда НЕ входят: выбрать старый статус заново нельзя, движение
 * только в новую схему.
 */
export const APPLICATION_STATUSES: ApplicationStatus[] = [
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

/** Старые значения enum — только для чтения уже существующих строк. */
export const LEGACY_APPLICATION_STATUSES: ApplicationStatus[] = [
  'NEW',
  'DOCS_REVIEW',
  'DOCS_SUBMITTED',
  'PRE_ADMISSION',
  'AWAITING_PAYMENT',
  'ENROLLED',
  'IN_PROGRESS',
  'COMPLETED',
];

const LEGACY_SET = new Set<string>(LEGACY_APPLICATION_STATUSES);

/** Заявка ещё не мигрирована на новую схему статусов? */
export function isLegacyApplicationStatus(status: string | null | undefined): boolean {
  return !!status && LEGACY_SET.has(status);
}

/**
 * «Успешный» исход. Зеркалит FINISHED_APPLICATION_STATUSES на бэкенде
 * (backend/src/common/application-status.ts): пока перенос строк не прогнали
 * (он опт-ин, MIGRATE_LEAD_STATUSES), часть заявок носит ENROLLED/COMPLETED,
 * поэтому любой подсчёт «успешных» обязан считать старое и новое как одно и
 * то же.
 */
export const FINISHED_APPLICATION_STATUSES: ApplicationStatus[] = [
  'SUCCESSFUL_LEAD',
  'ENROLLED',
  'COMPLETED',
];

const FINISHED_SET = new Set<string>(FINISHED_APPLICATION_STATUSES);

export function isFinishedApplicationStatus(status: string | null | undefined): boolean {
  return !!status && FINISHED_SET.has(status);
}

/**
 * Статусы, о переходе в которые бэкенд шлёт клиенту SMS.
 *
 * Зеркалит CLIENT_SMS_STATUS_LABEL в backend/src/common/application-status.ts
 * (там это подписи, где null = «клиенту не пишем»); при правке одного —
 * правь второе. Остальные значения нового набора — внутренняя квалификация
 * лида («Думает», «До 17 лет», «Некачественные лиды»), и отправлять её
 * человеку нельзя.
 *
 * CRM использует список ровно для одного: честно показать менеджеру, уйдёт
 * клиенту SMS от этой смены статуса или нет. Решает всё равно бэкенд —
 * фронт ничего не отправляет и отключить отправку не может.
 */
export const CLIENT_NOTIFIED_APPLICATION_STATUSES: ApplicationStatus[] = [
  'NEW_LEAD',
  'IN_PROCESSING',
  'ONLINE_CONSULTATION',
  'OFFLINE_CONSULTATION',
  'SUCCESSFUL_LEAD',
  // legacy — вся старая воронка состояла из этапов обработки и была клиентской
  'NEW',
  'IN_PROGRESS',
  'DOCS_REVIEW',
  'DOCS_SUBMITTED',
  'PRE_ADMISSION',
  'AWAITING_PAYMENT',
  'COMPLETED',
  'ENROLLED',
];

const CLIENT_NOTIFIED_SET = new Set<string>(CLIENT_NOTIFIED_APPLICATION_STATUSES);

/** Узнает ли клиент о переходе заявки в этот статус? */
export function isClientNotifiedApplicationStatus(status: string | null | undefined): boolean {
  return !!status && CLIENT_NOTIFIED_SET.has(status);
}

/** Новый, ещё не взятый в работу лид (новое значение + его legacy-предок). */
export const NEW_LEAD_APPLICATION_STATUSES: ApplicationStatus[] = ['NEW_LEAD', 'NEW'];

const NEW_LEAD_SET = new Set<string>(NEW_LEAD_APPLICATION_STATUSES);

export function isNewLeadApplicationStatus(status: string | null | undefined): boolean {
  return !!status && NEW_LEAD_SET.has(status);
}
export type StudentStatus = 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'ARCHIVED';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  /** Дополнительные роли (один человек может быть, например, ADMIN+ACCOUNTANT). */
  roles?: Role[];
  /** Permissions (берём из customRole) — backend кладёт в JWT-payload при validate. */
  permissions?: string[];
  /** Кастомная роль, если назначена. */
  customRoleId?: string | null;
  customRole?: {
    id: string;
    name: string;
    isActive?: boolean;
    permissions?: string[];
  } | null;
  createdAt?: string;
}

export interface ManagerInfo {
  id: string;
  fullName: string;
  email: string;
}

/**
 * Блок «Партнёр» в карточке сделки / студента / заявки.
 * Зеркалит backend `PartnerAttributionView` (partners/referrals.service.ts).
 *
 * ПОЛЕ ОПЦИОНАЛЬНО НЕ ПРОСТО ТАК. Бэкенд отдаёт `partnerAttribution` ТОЛЬКО
 * руководству (FOUNDER/ADMIN/ACCOUNTANT — канонический isElevated). Менеджеру
 * по продажам ключа в ответе НЕТ ВООБЩЕ: он не должен знать ни имени партнёра,
 * ни суммы, ни самого факта, что клиент партнёрский. Это гейт бэкенда, а не
 * UI — поэтому на фронте роль НЕ проверяем: пришло поле → рисуем, не пришло →
 * не рисуем. Дублирующая клиентская проверка создала бы ложное ощущение, что
 * приватность держится на UI (её можно обойти чтением сетевого ответа).
 *
 * `undefined` = «не элевейтед либо ответ старого бэка», `null` = «элевейтед,
 * но клиент органический». Оба случая рисуются одинаково — ничем.
 */
export interface PartnerAttributionView {
  partnerId: string;
  fullName: string;
  referralCode: string;
  /** Готовая ссылка с бэка. Никогда не собираем её на клиенте. */
  referralUrl: string;
  /**
   * Сумма комиссии за клиента (копейки). ДО начисления — прогноз по текущей
   * фикс-ставке партнёра; ПОСЛЕ — замороженная сумма из Commission, то есть
   * сколько партнёру реально записали. Бэкенд подставляет нужный источник
   * сам, на клиенте пересчитывать нечего.
   */
  commissionAmountCents: number;
  /**
   * Валюта `commissionAmountCents`, заполнена ТОЛЬКО когда сумма взята из
   * реальной Commission. Это и есть признак «число настоящее»: null →
   * рисуем как ставку-прогноз (всегда TJS), строка → рисуем как деньги в
   * этой валюте, ровно как «Партнёры → Комиссии».
   *
   * Опционально: CRM (Vercel) может выкатиться раньше API (Railway), и
   * старый бэкенд поля не отдаёт — undefined трактуем как null.
   */
  commissionCurrency?: string | null;
  /** null = комиссия за этого клиента ещё не начислена (одна на клиента). */
  commissionedAt: string | null;
  commissionId: string | null;
}

export interface Application {
  id: string;
  fullName: string;
  phone: string;
  secondaryPhone?: string | null;
  secondaryContactLabel?: string | null;
  preferredChannel?: ContactChannel | null;
  email: string | null;
  direction: Direction;
  /**
   * Направление в поле выше — настоящий ответ (true) или плейсхолдер (false)?
   *
   * Форма лендинга направление не спрашивает, но колонка в БД NOT NULL,
   * поэтому бэкенд подставляет туда Direction.BACHELOR. Пока менеджер не
   * подтвердит направление в карточке, показывать его как выбор клиента
   * нельзя — иначе весь входящий трафик выглядит «Бакалавриатом».
   *
   * Опционально: старые ответы API (и мок-данные) поля не содержат —
   * `undefined` трактуем как подтверждённое, как и `@default(true)` в схеме.
   */
  directionConfirmed?: boolean;
  /**
   * Страна из формы лендинга. nullable: заявки, созданные до релиза формы
   * (и всё, что заведено в обход формы: ручное создание в CRM, самозапись
   * студента, approve заявки партнёра) её не имеют.
   */
  country?: Country | null;
  /** WhatsApp клиента. Может совпадать с phone (чекбокс «тот же номер»). */
  whatsappPhone?: string | null;
  /** ISO-дата рождения; переносится в Student.birthday при конвертации. */
  birthday?: string | null;
  comment: string | null;
  status: ApplicationStatus;
  /**
   * За заявкой числится долг («ждёт оплаты»).
   *
   * Раньше это выражалось статусом AWAITING_PAYMENT. В новом наборе (исходы
   * квалификации лида) такого значения нет, а миграция схлопывает его в
   * IN_PROCESSING — поэтому признак вынесен в отдельное поле. Именно по нему
   * строятся раздел «Задолженность студентов» на /finance и карточка
   * «Студентов с задолженностью» на дашборде.
   *
   * Опционально: ответы API, отданные до появления колонки (и мок-данные)
   * поля не содержат — `undefined` трактуем как «долга нет», как и
   * `@default(false)` в схеме.
   */
  paymentPending?: boolean;
  source: ApplicationSource;
  studentId: string | null;
  student?: Student | null;
  managerId: string | null;
  manager?: ManagerInfo | null;
  chinaManagerId: string | null;
  chinaManager?: ManagerInfo | null;
  /** Воронка продаж, в которой сейчас заявка (опционально). */
  pipelineId?: string | null;
  /** Текущий этап воронки. Меняется через POST /sales/applications/:id/move-stage. */
  pipelineStageId?: string | null;
  createdAt: string;
  /**
   * Партнёр, приведший клиента. Только в ответе GET /applications/:id и только
   * руководству — см. {@link PartnerAttributionView}. В списках и во всех
   * остальных ответах поля нет.
   */
  partnerAttribution?: PartnerAttributionView | null;
}

export interface Document {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  type: string;
  createdAt: string;
}

export type ContactChannel = 'WHATSAPP' | 'PHONE' | 'INSTAGRAM' | 'TELEGRAM' | 'EMAIL';

export const CONTACT_CHANNEL_LABEL: Record<ContactChannel, string> = {
  WHATSAPP: 'WhatsApp',
  PHONE: 'Телефон',
  INSTAGRAM: 'Instagram',
  TELEGRAM: 'Telegram',
  EMAIL: 'Email',
};

export type OnboardingStage =
  | 'WELCOME'
  | 'DOCS_COLLECTED'
  | 'CABINET_OPENED'
  | 'ACADEMY_INTRO'
  | 'ACTIVE';

export const ONBOARDING_STAGE_LABEL: Record<OnboardingStage, string> = {
  WELCOME: 'Приветствие',
  DOCS_COLLECTED: 'Документы собраны',
  CABINET_OPENED: 'Кабинет открыт',
  ACADEMY_INTRO: 'Ознакомление с программой',
  ACTIVE: 'В активной работе',
};

export interface Student {
  id: string;
  fullName: string;
  /** ISO дата рождения (для авто-поздравления cron'ом). */
  birthday?: string | null;
  phones: string[];
  /** Подписи к phones, синхронные по индексу. */
  phoneLabels?: string[];
  preferredChannel?: ContactChannel | null;
  /** Этап онбординга после оплаты — ведёт клиентский менеджер. */
  onboardingStage?: OnboardingStage;
  email: string | null;
  photoUrl: string | null;
  direction: Direction;
  /**
   * То же, что Application.directionConfirmed, но уже на студенте: при
   * конвертации заявки плейсхолдер переезжает в Student.direction ВМЕСТЕ
   * с этой пометкой. Без неё placeholder «Бакалавриат» на карточке студента
   * невозможно отличить от ответа клиента, а исходная заявка — единственное
   * место, где осталась правда.
   *
   * Пока false, `cabinet` ниже — кабинет-«приёмник» (DEFAULT_CABINET), а не
   * результат маршрутизации по направлению.
   *
   * Опционально: старые ответы API поля не содержат — `undefined` трактуем
   * как подтверждённое, как и `@default(true)` в схеме.
   */
  directionConfirmed?: boolean;
  /**
   * Страна из формы лендинга, перенесённая с заявки при конвертации, —
   * единственный НАСТОЯЩИЙ ответ клиента о цели. nullable: у студентов,
   * заведённых вручную в CRM/самозаписью, страны нет.
   */
  country?: Country | null;
  cabinet: number;
  status: StudentStatus;
  comment: string | null;
  managerId: string | null;
  manager?: ManagerInfo | null;
  chinaManagerId: string | null;
  chinaManager?: ManagerInfo | null;
  applicationForm?: any;
  documents?: Document[];
  applications?: Application[];
  createdAt: string;
  /**
   * Партнёр, приведший клиента. Только в ответе GET /students/:id и только
   * руководству — см. {@link PartnerAttributionView}. В списках поля нет.
   */
  partnerAttribution?: PartnerAttributionView | null;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  payload: any;
  read: boolean;
  createdAt: string;
}

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';

export interface TaskUserSummary {
  id: string;
  fullName: string;
  email: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  deadline: string | null;
  deadlineReminderSent?: boolean;
  overdueNotified?: boolean;
  /** Список ID исполнителей — может быть несколько сотрудников на одну задачу. */
  assigneeIds: string[];
  /** Развёрнутые данные исполнителей (для отрисовки без доп. запросов). */
  assignees: TaskUserSummary[];
  /** Контролёр задачи — опциональный, проверяет выполнение. */
  controllerId: string | null;
  controller?: TaskUserSummary | null;
  createdById: string | null;
  createdBy?: TaskUserSummary | null;
  createdAt: string;
  updatedAt: string;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'К выполнению',
  IN_PROGRESS: 'В работе',
  DONE: 'Выполнено',
};

export const TASK_STATUS_BADGE: Record<TaskStatus, string> = {
  TODO: 'badge-info',
  IN_PROGRESS: 'badge-warning',
  DONE: 'badge-success',
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  BACHELOR: 'Бакалавриат',
  MASTER: 'Магистратура',
  LANGUAGE: 'Языковые курсы',
  LANGUAGE_COLLEGE: 'Языковой + колледж',
  LANGUAGE_BACHELOR: 'Языковой + бакалавриат',
  COLLEGE: 'Колледж',
};

/**
 * RU-фоллбэк для меток статуса. Основной источник — i18n
 * (`app.status.*`, см. useApplicationStatusLabel): здесь остаётся то, что
 * нужно вне React-дерева и как страховка от отсутствующего ключа.
 */
export const STATUS_LABEL: Record<ApplicationStatus, string> = {
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
  // legacy
  NEW: 'Новая заявка',
  DOCS_REVIEW: 'Документы на проверке',
  DOCS_SUBMITTED: 'Подача документов',
  PRE_ADMISSION: 'Предварительное зачисление',
  AWAITING_PAYMENT: 'Ожидание оплаты',
  ENROLLED: 'Зачислен',
  IN_PROGRESS: 'Документы на проверке',
  COMPLETED: 'Зачислен',
};

export const STATUS_SHORT: Record<ApplicationStatus, string> = {
  NEW_LEAD: 'Новый',
  IN_PROCESSING: 'В работе',
  ONLINE_CONSULTATION: 'Онлайн',
  OFFLINE_CONSULTATION: 'Оффлайн',
  THINKING: 'Думает',
  OUT_OF_TOWN: 'Вне города',
  UNDER_17: 'До 17',
  POTENTIAL_LEAD: 'Потенциальный',
  LOW_QUALITY_LEAD: 'Некачественный',
  SUCCESSFUL_LEAD: 'Успешный',
  // legacy
  NEW: 'Новая',
  DOCS_REVIEW: 'Проверка',
  DOCS_SUBMITTED: 'Подача',
  PRE_ADMISSION: 'Предв. зачисление',
  AWAITING_PAYMENT: 'Оплата',
  ENROLLED: 'Зачислен',
  IN_PROGRESS: 'Проверка',
  COMPLETED: 'Зачислен',
};

export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  ACTIVE: 'Активный',
  PAUSED: 'Приостановлен',
  GRADUATED: 'Выпустился',
  ARCHIVED: 'В архиве',
};

/**
 * Цвет бейджа. Логика: синий — лид только пришёл, жёлтый — с ним идёт
 * работа, серый — отложен по внешней причине, красный — отказ,
 * зелёный — успех.
 */
export const STATUS_BADGE: Record<ApplicationStatus, string> = {
  NEW_LEAD: 'badge-info',
  IN_PROCESSING: 'badge-warning',
  ONLINE_CONSULTATION: 'badge-warning',
  OFFLINE_CONSULTATION: 'badge-warning',
  THINKING: 'badge-warning',
  OUT_OF_TOWN: 'badge-gray',
  UNDER_17: 'badge-gray',
  POTENTIAL_LEAD: 'badge-info',
  LOW_QUALITY_LEAD: 'badge-danger',
  SUCCESSFUL_LEAD: 'badge-success',
  // legacy — старые строки должны рисоваться бейджем, а не голым текстом
  NEW: 'badge-info',
  DOCS_REVIEW: 'badge-warning',
  DOCS_SUBMITTED: 'badge-warning',
  PRE_ADMISSION: 'badge-info',
  AWAITING_PAYMENT: 'badge-warning',
  ENROLLED: 'badge-success',
  IN_PROGRESS: 'badge-warning',
  COMPLETED: 'badge-success',
};

export const STUDENT_STATUS_BADGE: Record<StudentStatus, string> = {
  ACTIVE: 'badge-success',
  PAUSED: 'badge-warning',
  GRADUATED: 'badge-info',
  ARCHIVED: 'badge-gray',
};
