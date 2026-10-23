/**
 * Каталог прав для ролей (Настройки → Роли). Основатель отмечает галочками,
 * что можно сотруднику с этой ролью — личной или ролью его должности
 * (auth/position-role.ts). Основатель может всё; сотрудники без роли
 * работают по своей должности, как раньше, — этот каталог их не касается.
 *
 * Как право действует (с 19.10.2026 — на КАЖДОМ адресе, а не по префиксу):
 *   • на адресе стоит @Permissions('ключ', …) — сотруднику с ролью нужен
 *     хотя бы один из ключей; проверяют JwtAuthGuard (любой адрес под ним)
 *     и RolesGuard. Другие права раздела этот адрес больше не открывают —
 *     раньше любое «изменение» раздела пускало и на удаление;
 *   • где право зависит от самой записи (лид это или заявка, своя ли
 *     сделка) — сервис спрашивает roleAllows() (auth/role-utils.ts);
 *   • данные «Деньги клиентов», «Зарплаты» и т.п. без права приходят
 *     скрытыми (common/redact.ts) — сервер их просто не отдаёт.
 *
 * kind — место пункта в таблице редактора: строка = раздел (section),
 * столбцы «Просмотр / Создание / Изменение / Удаление», остальное — особые
 * действия той же строки (extra). Подписи на таджикском — во фронте
 * (perm.section.*, perm.short.*), здесь — русские, они же для поиска.
 */

export type PermissionKind = 'read' | 'create' | 'update' | 'delete' | 'extra';

export interface PermissionDef {
  key: string;
  /** Полная подпись: «Лиды — удаление и возврат из корзины». */
  label: string;
  /** Группа редактора: CRM, Связь, Продажи, … */
  group: string;
  /** Раздел — строка таблицы. */
  section: string;
  sectionLabel: string;
  kind: PermissionKind;
  /** Подпись в строке (особое действие) или уточнение столбца. */
  short?: string;
}

const KIND_LABEL: Record<Exclude<PermissionKind, 'extra'>, string> = {
  read: 'просмотр',
  create: 'создание',
  update: 'изменение',
  delete: 'удаление',
};

type Row = [key: string, kind: PermissionKind, short?: string];

function section(group: string, sectionKey: string, sectionLabel: string, rows: Row[]): PermissionDef[] {
  return rows.map(([key, kind, short]) => ({
    key,
    group,
    section: sectionKey,
    sectionLabel,
    kind,
    ...(short ? { short } : {}),
    label: `${sectionLabel} — ${short ?? KIND_LABEL[kind as Exclude<PermissionKind, 'extra'>]}`,
  }));
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  // ─── CRM ───────────────────────────────────────────────────────────────
  // Лид — заявка в статусе «Новый лид» (applications/application-access.ts):
  // права лида действуют, пока заявка в этом статусе, дальше — права заявки.
  // С 23.10.2026 в CRM один раздел «Лиды», а разделы прав называются «Новые
  // лиды» (leads:*) и «Лиды в работе» (applications:*); ключи прежние.
  ...section('CRM', 'leads', 'Новые лиды', [
    ['leads:read', 'read', 'просмотр в списке и карточке'],
    ['leads:create', 'create'],
    ['leads:update', 'update', 'изменение и перевод в работу'],
    ['leads:delete', 'delete', 'удаление и возврат из корзины'],
    ['leads:assign', 'extra', 'Назначение менеджера'],
    // «Передача чужих» (23.10.2026): отдать лид, у которого уже есть ДРУГОЙ
    // менеджер, — себе или третьему. «Назначение» раздаёт только свободных и
    // своих (applications/application-access.ts, canTransferOthers).
    ['leads:reassign', 'extra', 'Передача чужих'],
    ['leads:all', 'extra', 'Все, не только свои'],
  ]),
  ...section('CRM', 'applications', 'Лиды в работе', [
    ['applications:read', 'read', 'просмотр в списке и карточке'],
    ['applications:create', 'create', 'создание лида студенту'],
    ['applications:update', 'update', 'изменение и смена статуса'],
    ['applications:delete', 'delete', 'удаление и возврат из корзины'],
    ['applications:assign', 'extra', 'Назначение менеджера'],
    ['applications:reassign', 'extra', 'Передача чужих'],
    ['applications:all', 'extra', 'Все, не только свои'],
  ]),
  ...section('CRM', 'students', 'Студенты', [
    ['students:read', 'read'],
    ['students:create', 'create'],
    ['students:update', 'update', 'изменение данных, анкеты и фото'],
    ['students:delete', 'delete'],
    ['students:documents', 'extra', 'Документы: загрузка и удаление'],
    ['students:assign', 'extra', 'Назначение менеджера'],
    ['students:reassign', 'extra', 'Передача чужих'],
    ['students:password', 'extra', 'Новый пароль кабинета'],
    ['students:all', 'extra', 'Все, не только свои'],
  ]),
  ...section('CRM', 'interactions', 'История контактов', [
    ['interactions:create', 'create', 'добавление записей'],
    ['interactions:update', 'update', 'изменение своих записей'],
    ['interactions:delete', 'delete', 'удаление своих записей'],
  ]),
  // Статус своей задачи (исполнитель, контролёр) меняет каждый, у кого
  // она есть. Текст, срок и исполнителей после создания в CRM не правят —
  // пункта для этого нет.
  ...section('CRM', 'tasks', 'Задачи', [
    ['tasks:read', 'read', 'свои задачи'],
    ['tasks:create', 'create', 'с исполнителем и контролёром'],
    ['tasks:delete', 'delete'],
    ['tasks:all', 'extra', 'Все задачи, не только свои'],
  ]),
  ...section('CRM', 'programs', 'Программы', [
    ['programs:read', 'read'],
    ['programs:create', 'create'],
    ['programs:update', 'update', 'изменение, фото и галерея'],
    ['programs:delete', 'delete'],
    ['programs:scholarships', 'extra', 'Стипендии'],
    ['programs:documents', 'extra', 'Документы'],
    ['programs:comments', 'extra', 'Внутренние комментарии'],
    ['programs:installments', 'extra', 'Шаблон рассрочки'],
  ]),
  ...section('CRM', 'pipelines', 'Воронки', [
    ['pipelines:read', 'read', 'просмотр воронок и этапов'],
    ['pipelines:create', 'create', 'создание воронок и этапов'],
    ['pipelines:update', 'update', 'изменение воронок и этапов'],
    ['pipelines:delete', 'delete', 'удаление воронок и этапов'],
    ['pipelines:move', 'extra', 'Перемещение лидов по этапам'],
  ]),

  // ─── Связь ─────────────────────────────────────────────────────────────
  ...section('Связь', 'chat', 'Чат', [
    ['chat:read', 'read'],
    ['chat:delete', 'delete', 'удаление своих групп'],
    ['chat:write', 'extra', 'Отправка сообщений'],
    ['chat:groups', 'extra', 'Создание групп'],
    ['chat:direct', 'extra', 'Новые личные чаты'],
    ['chat:pin', 'extra', 'Закрепление сообщений'],
    ['chat:forward', 'extra', 'Пересылка сообщений'],
  ]),
  ...section('Связь', 'inbox', 'Входящие', [
    ['inbox:read', 'read', 'переписка с клиентами'],
    ['inbox:whatsapp', 'extra', 'Ответ в WhatsApp'],
    ['inbox:instagram', 'extra', 'Ответ в Instagram'],
    ['inbox:sms', 'extra', 'Отправка SMS'],
  ]),
  ...section('Связь', 'calls', 'Звонки', [
    ['calls:read', 'read', 'свои звонки'],
    ['calls:create', 'create', 'добавление в журнал'],
    ['calls:delete', 'delete', 'удаление своих звонков'],
    ['calls:dial', 'extra', 'Звонок из CRM'],
    ['calls:all', 'extra', 'Звонки всех и статистика'],
  ]),
  ...section('Связь', 'massmail', 'Рассылки', [
    ['massmail:read', 'read'],
    ['massmail:create', 'create'],
    ['massmail:send', 'extra', 'Отправка и отмена'],
  ]),

  // ─── Продажи ───────────────────────────────────────────────────────────
  ...section('Продажи', 'submissions', 'Сделки', [
    ['submissions:read', 'read', 'свои сделки'],
    ['submissions:create', 'create', 'оформление'],
    ['submissions:update', 'update', 'изменение данных'],
    ['submissions:delete', 'delete'],
    ['submissions:all', 'extra', 'Все сделки, не только свои'],
    ['submissions:status', 'extra', 'Смена статуса'],
    ['submissions:stages', 'extra', 'Этапы оплаты'],
    ['submissions:payment-add', 'extra', 'Платёж: добавление'],
    ['submissions:payment-edit', 'extra', 'Платёж: изменение'],
    ['submissions:payment-delete', 'extra', 'Платёж: удаление'],
    ['submissions:approve', 'extra', 'Одобрение и отклонение платежей'],
  ]),
  ...section('Продажи', 'offers', 'Оферты', [
    ['offers:read', 'read', 'просмотр и подписи'],
    ['offers:create', 'create'],
    ['offers:update', 'update'],
    ['offers:delete', 'delete'],
  ]),

  // ─── Партнёры ──────────────────────────────────────────────────────────
  // partners:read открывает и блок «Партнёр» в карточках клиентов
  // (canSeePartnerAttribution в auth/role-utils.ts).
  ...section('Партнёры', 'partners', 'Партнёры', [
    ['partners:read', 'read', 'просмотр и блок «Партнёр» в карточках'],
    ['partners:create', 'create'],
    ['partners:update', 'update'],
    ['partners:delete', 'delete'],
    ['partners:commission-approve', 'extra', 'Одобрение комиссий'],
    ['partners:commission-pay', 'extra', 'Выплата комиссий'],
    ['partners:payouts', 'extra', 'Выводы: выплата и отказ'],
  ]),

  // ─── Финансы ───────────────────────────────────────────────────────────
  ...section('Финансы', 'finance', 'Финансы', [
    ['finance:read', 'read', 'обзор, операции и аналитика'],
    ['finance:create', 'create', 'внесение операций (вручную, чек, ИИ)'],
    ['finance:update', 'update', 'изменение операций'],
    ['finance:delete', 'delete', 'удаление операций'],
    ['finance:payments', 'extra', 'Оплаты студентов: подтверждение и отклонение'],
  ]),
  ...section('Финансы', 'salary', 'Зарплата', [
    ['salary:read', 'read'],
    ['salary:calculate', 'create', 'расчёт'],
    ['salary:recalculate', 'update', 'пересчёт'],
    ['salary:delete', 'delete', 'удаление расчёта'],
    ['salary:pay', 'extra', 'Выплата'],
  ]),

  // ─── Аналитика ─────────────────────────────────────────────────────────
  ...section('Аналитика', 'kpi', 'KPI', [
    ['kpi:read', 'read', 'рейтинг сотрудников'],
    ['kpi:details', 'extra', 'KPI других подробно'],
  ]),
  // Отчёты коллег видны в их профилях (с «Сотрудники — просмотр»);
  // отдельного экрана «все отчёты» в CRM нет — и пункта для него нет.
  ...section('Аналитика', 'reports', 'Ежедневные отчёты', [
    ['reports:read', 'read', 'свои отчёты'],
    ['reports:create', 'create', 'свой отчёт за день'],
  ]),
  ...section('Аналитика', 'activity', 'Журнал активности', [['activity:read', 'read']]),

  // ─── HR ────────────────────────────────────────────────────────────────
  // Свой рабочий день (приход, обед, уход, причина опоздания) — у каждого
  // сотрудника всегда: без него человек не отметится и получит штраф.
  // Штрафы начисляет система по правилам (Настройки → Правила штрафов);
  // ручного начисления в CRM нет — и пункта для него нет.
  ...section('HR', 'users', 'Сотрудники', [
    ['users:read', 'read', 'список и карточки'],
    ['users:create', 'create'],
    ['users:update', 'update', 'изменение данных'],
    ['users:dismiss', 'delete', 'увольнение, возврат и передача дел'],
    ['users:documents', 'extra', 'Документы сотрудников'],
    ['users:access', 'extra', 'Доступ к чужим профилям'],
  ]),
  // Свой приход/уход и обед — у всех всегда (иначе штрафы), пункта нет.
  // Табель команды — «Посещаемость», опоздания — «Причины опозданий».
  ...section('HR', 'attendance', 'Посещаемость', [['attendance:read', 'read']]),
  ...section('HR', 'excuses', 'Причины опозданий', [
    ['excuses:read', 'read'],
    ['excuses:approve', 'extra', 'Одобрение и отказ'],
  ]),

  // ─── Академия и обучение ───────────────────────────────────────────────
  // Учитель группы — тот, кто записан в StudyGroup.teacherId; «свои группы»
  // — эти. academy:all снимает ограничение «только свои».
  ...section('Обучение', 'lms', 'Курсы', [
    ['lms:read', 'read'],
    ['lms:create', 'create'],
    ['lms:update', 'update', 'изменение курсов и уроков'],
    ['lms:delete', 'delete'],
  ]),
  ...section('Обучение', 'groups', 'Группы академии', [
    ['groups:read', 'read', 'свои группы'],
    ['academy:groups-create', 'create'],
    ['academy:groups-update', 'update', 'название, учитель, программа, статус'],
    ['academy:groups-delete', 'delete'],
    ['groups:write', 'extra', 'Ведение: журнал, уроки, ДЗ, расписание, флаги'],
    ['academy:all', 'extra', 'Все группы и ученики, не только свои'],
    ['academy:members-add', 'extra', 'Добавление учеников в группу'],
    ['academy:members-remove', 'extra', 'Исключение из группы'],
    ['academy:complete', 'extra', 'Завершение курса'],
  ]),
  ...section('Обучение', 'academyStudents', 'Ученики академии', [
    ['academy:students-create', 'create'],
    ['academy:students-update', 'update', 'данные и уровень'],
    ['academy:students-password', 'extra', 'Новый пароль кабинета'],
  ]),
  ...section('Обучение', 'academyLevels', 'Уровни учеников', [['academy:levels', 'update', 'список уровней']]),
  ...section('Обучение', 'academyFlags', 'Флаги и отчисление', [
    ['academy:flags-remove', 'extra', 'Снятие флагов'],
    ['academy:decide', 'extra', 'Решение по 4 флагам и возврат'],
  ]),

  // ─── Система (Настройки компании) ──────────────────────────────────────
  // «Роли и доступы», должности и оклады сотрудников — только основатель:
  // иначе сотрудник смог бы выдать себе всё.
  ...section('Система', 'settingsSchedule', 'График работы', [['settings:schedule', 'update']]),
  ...section('Система', 'settingsPenalties', 'Правила штрафов', [['settings:penalty-rules', 'update']]),
  ...section('Система', 'settingsLocations', 'Рабочие места', [['settings:locations', 'update']]),
  // Бонусная сетка задана в коде (common/bonus-bands.ts) и в CRM не
  // правится — пункта для неё нет.
  ...section('Система', 'settingsRevenue', 'Схема распределения дохода', [['settings:revenue', 'update']]),

  // ─── Видимость данных ──────────────────────────────────────────────────
  // Без права данные скрыты на сервере: «•••• TJS», «+992 •• ••• •• 45».
  // Свои деньги и данные сотрудник видит всегда.
  ...section('Данные', 'clientMoney', 'Деньги клиентов', [
    ['visibility:client-money', 'read', 'суммы сделок, оплаты, долги, рассрочки и чеки'],
  ]),
  ...section('Данные', 'companyMoney', 'Деньги компании', [
    ['visibility:company-money', 'read', 'выручка и суммы продаж: главная, KPI, профили сотрудников'],
  ]),
  ...section('Данные', 'staffPay', 'Зарплаты и оклады', [
    ['visibility:staff-pay', 'read', 'оклад, бонусы и штрафы других сотрудников'],
  ]),
  ...section('Данные', 'staffPersonal', 'Личные данные сотрудников', [
    ['visibility:staff-personal', 'read', 'телефон, email, паспорт и документы других сотрудников'],
  ]),
];

export const PERMISSION_KEYS: string[] = PERMISSION_CATALOG.map((p) => p.key);
const KEY_SET = new Set(PERMISSION_KEYS);

/** Проверить, входит ли permission в каталог (защита от мусора в БД). */
export function isValidPermission(key: string): boolean {
  return KEY_SET.has(key);
}

export function permissionLabel(key: string): string {
  return PERMISSION_CATALOG.find((p) => p.key === key)?.label ?? key;
}

/**
 * Версия каталога. Роль с меньшей CustomRole.permVersion один раз
 * переносится на неё при запуске сервера (custom-roles.service).
 *   1 — до 19.10.2026: крупные пункты, «… (устар.)», права по префиксу.
 *   2 — подробный каталог выше.
 */
export const PERMISSIONS_VERSION = 2;

/**
 * Перенос роли на версию 2. Галочки, которые были и остались, переносятся
 * как отмечены — с этого дня они действуют на самом деле (так решил
 * основатель 19.10.2026). Новые пункты выводятся из ближайших старых:
 * «Заявки — создание» открывала экран «Лиды» и ввод лида → «Лиды —
 * просмотр» и «Лиды — создание». Устаревшие ключи раскладываются на новые
 * и из роли уходят.
 */
const DERIVE_V2: Record<string, string[]> = {
  // «Рабочий день — история команды» открывал табель и причины опозданий.
  'workday:history': ['attendance:read', 'excuses:read'],
  // Лиды — это заявки: экран «Лиды» открывала «Заявки — создание», лиды
  // в общем списке видели с «Заявки — просмотр».
  'applications:read': ['leads:read', 'interactions:create', 'interactions:update', 'interactions:delete', 'visibility:client-money'],
  'applications:create': ['leads:read', 'leads:create', 'interactions:create', 'interactions:update', 'interactions:delete'],
  'applications:update': ['leads:update'],
  'applications:delete': ['leads:delete'],
  'applications:assign': ['leads:assign'],
  'applications:write': [
    'applications:create', 'applications:update', 'applications:delete',
    'leads:read', 'leads:create', 'leads:update', 'leads:delete',
  ],
  // История контактов была у всех, кто открывал карточку клиента.
  'students:read': ['interactions:create', 'interactions:update', 'interactions:delete', 'visibility:client-money'],
  'students:update': ['students:documents'],
  'students:write': ['students:create', 'students:update', 'students:delete', 'students:documents'],
  // Комментарий к программе мог оставить любой, кто её видел.
  'programs:read': ['programs:comments'],
  'programs:update': ['programs:scholarships', 'programs:documents', 'programs:installments'],
  'programs:write': [
    'programs:create', 'programs:update', 'programs:delete',
    'programs:scholarships', 'programs:documents', 'programs:installments', 'programs:comments',
  ],
  'tasks:write': ['tasks:create', 'tasks:delete'],
  'pipelines:write': ['pipelines:read', 'pipelines:create', 'pipelines:update', 'pipelines:delete', 'pipelines:move'],
  'chat:write': ['chat:groups', 'chat:direct', 'chat:pin', 'chat:forward', 'chat:delete'],
  'inbox:reply': ['inbox:read', 'inbox:whatsapp', 'inbox:instagram', 'inbox:sms'],
  // Свой звонок мог удалить любой, кто видел журнал.
  'calls:read': ['calls:delete'],
  'calls:write': ['calls:read', 'calls:create', 'calls:delete'],
  'massmail:write': ['massmail:read', 'massmail:create'],
  'mass-mail:write': ['massmail:read', 'massmail:create'],
  'submissions:read': ['visibility:client-money'],
  'submissions:create': ['submissions:payment-add'],
  'submissions:update': ['submissions:status', 'submissions:stages', 'submissions:payment-add', 'submissions:payment-edit'],
  'offers:write': ['offers:read', 'offers:create', 'offers:update', 'offers:delete'],
  'partners:write': [
    'partners:read', 'partners:create', 'partners:update', 'partners:delete',
    'partners:commission-approve', 'partners:commission-pay', 'partners:payouts',
  ],
  'finance:read': ['visibility:client-money', 'visibility:company-money'],
  'finance:create': ['finance:payments'],
  'finance:update': ['finance:payments'],
  'finance:delete': ['finance:payments'],
  'finance:write': ['finance:create', 'finance:update', 'finance:delete', 'finance:payments'],
  'salary:read': ['visibility:staff-pay'],
  'salary:calculate': ['salary:recalculate', 'salary:delete'],
  'salary:write': ['salary:read', 'salary:calculate', 'salary:recalculate', 'salary:delete', 'salary:pay', 'visibility:staff-pay'],
  'kpi:read': ['kpi:details', 'visibility:company-money'],
  'users:read': ['visibility:staff-personal', 'visibility:staff-pay'],
  'users:update': ['users:documents', 'users:access'],
  // Сотрудника не удаляют, а увольняют (DELETE /users/:id — то же увольнение).
  'users:delete': ['users:dismiss'],
  'users:write': [
    'users:read', 'users:create', 'users:update',
    'users:dismiss', 'users:documents', 'users:access', 'visibility:staff-personal', 'visibility:staff-pay',
  ],
  'excuses:write': ['excuses:read', 'excuses:approve'],
  'lms:write': ['lms:read', 'lms:create', 'lms:update', 'lms:delete'],
  // Учитель своей группы и раньше добавлял учеников, правил их, менял пароль
  // и завершал курс (Академия-2, 17.10.2026).
  'groups:write': [
    'academy:members-add', 'academy:students-create', 'academy:students-update',
    'academy:students-password', 'academy:complete',
  ],
  'academy:manage': [
    'groups:read', 'groups:write', 'academy:all',
    'academy:groups-create', 'academy:groups-update', 'academy:groups-delete',
    'academy:members-add', 'academy:members-remove', 'academy:complete',
    'academy:students-create', 'academy:students-update', 'academy:students-password',
    'academy:levels', 'academy:flags-remove', 'academy:decide',
  ],
  'settings:write': [
    'settings:schedule', 'settings:penalty-rules', 'settings:locations', 'settings:revenue',
  ],
};

/** Новые права роли после переноса на версию 2 (порядок — как в каталоге). */
export function migratePermissionsV2(old: string[]): string[] {
  const out = new Set<string>();
  for (const key of old) {
    if (KEY_SET.has(key)) out.add(key);
    for (const derived of DERIVE_V2[key] ?? []) out.add(derived);
  }
  return withSectionRead(PERMISSION_KEYS.filter((k) => out.has(k)));
}

/**
 * Любое действие раздела без его просмотра бессмысленно — как в редакторе
 * роли: отмечено действие — «Просмотр» строки отмечается сам.
 */
export function withSectionRead(keys: string[]): string[] {
  const set = new Set(keys);
  for (const p of PERMISSION_CATALOG) {
    if (p.kind === 'read' || !set.has(p.key)) continue;
    const read = PERMISSION_CATALOG.find((r) => r.section === p.section && r.kind === 'read');
    if (read) set.add(read.key);
  }
  return PERMISSION_KEYS.filter((k) => set.has(k));
}

/**
 * Кто вообще получает справочник сотрудников (GET /users) — выбор людей в
 * формах: исполнитель задачи, учитель группы, менеджер в фильтрах. Без
 * «Личных данных сотрудников» email в нём приходит с маской.
 */
export const PEOPLE_PICKER_PERMISSIONS: string[] = [
  'users:read', 'tasks:read', 'tasks:create', 'tasks:all',
  'leads:read', 'applications:read', 'students:read', 'submissions:all',
  'finance:read', 'attendance:read', 'excuses:read',
  'groups:read', 'groups:write', 'academy:all', 'academy:groups-create', 'academy:groups-update',
  'chat:groups', 'calls:all', 'kpi:read', 'salary:read',
];
