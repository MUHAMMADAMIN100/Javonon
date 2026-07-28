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

export type ApplicationStatus =
  | 'NEW'
  | 'DOCS_REVIEW'
  | 'DOCS_SUBMITTED'
  | 'PRE_ADMISSION'
  | 'AWAITING_PAYMENT'
  | 'ENROLLED'
  // legacy (migrated automatically)
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

export const APPLICATION_STAGES: ApplicationStatus[] = [
  'NEW',
  'DOCS_REVIEW',
  'DOCS_SUBMITTED',
  'PRE_ADMISSION',
  'AWAITING_PAYMENT',
  'ENROLLED',
];

export const STAGE_INDEX: Record<ApplicationStatus, number> = {
  NEW: 0,
  DOCS_REVIEW: 1,
  IN_PROGRESS: 1, // legacy
  DOCS_SUBMITTED: 2,
  PRE_ADMISSION: 3,
  AWAITING_PAYMENT: 4,
  ENROLLED: 5,
  COMPLETED: 5, // legacy
};
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

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
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

export const STATUS_BADGE: Record<ApplicationStatus, string> = {
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
