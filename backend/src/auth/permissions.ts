/**
 * Каталог пермиссий для кастомных ролей (Task 4 — расширение до полного
 * CRUD по всем разделам сайдбара). FOUNDER в /settings → Роли выбирает
 * чекбоксами какие из них дать новой роли.
 *
 * Ключ — формат `section:action`. Action — read | create | update | delete
 * | write | assign | approve | send | sign | reply | calculate | pay |
 * history.
 *
 * Правила:
 * - :read (и :history) — read-only. Не открывает write-запросы.
 * - Любое другое action — write-family: неявно даёт read по URL раздела.
 *   Это чтобы юзер с applications:create мог видеть список заявок.
 * - :write в паре с :read — для секций, где полноценный CRUD-детализация
 *   избыточна (chat, pipelines, mass-mail, lms, partners, settings).
 *
 * Sidebar/ProtectedRoute на фронте + RolesGuard на бэке смотрят на ЭТОТ ЖЕ
 * список — он единый источник правды.
 */

export interface PermissionDef {
  key: string;
  /** Короткая метка для чекбокса в UI. */
  label: string;
  /** Подзаголовок группы в UI (человекочитаемо, на русском). */
  group: string;
  /** Внутренний неймспейс раздела (applications, students, ...). Для UI
   *  можно использовать чтобы группировать по секциям внутри группы. */
  section: string;
  /** Какие URL-пути на бэке этот пермишен «открывает». RolesGuard
   *  использует, чтобы понять — даже без @Roles на эндпоинте — что
   *  custom-role-юзер имеет доступ. */
  paths?: Array<{ method?: string; prefix: string }>;
}

/** Action-суффиксы, которые считаются read-only. Всё остальное — write-family
 *  (создание/редактирование/удаление и т.д. — они неявно покрывают чтение). */
const READ_ONLY_ACTIONS = new Set(['read', 'history']);

/** Извлечь action из ключа `section:action`. */
function actionOf(key: string): string {
  const idx = key.lastIndexOf(':');
  return idx === -1 ? '' : key.slice(idx + 1);
}

/** Read-only permission — не должен допускаться на write-запросы. */
function isReadOnlyPermission(key: string): boolean {
  return READ_ONLY_ACTIONS.has(actionOf(key));
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  // ─── CRM ───────────────────────────────────────────────────────────────
  { key: 'applications:read',   section: 'applications', group: 'CRM',
    label: 'Заявки — просмотр',
    paths: [{ method: 'GET', prefix: '/applications' }] },
  { key: 'applications:create', section: 'applications', group: 'CRM',
    label: 'Заявки — создание',
    paths: [{ prefix: '/applications' }] },
  { key: 'applications:update', section: 'applications', group: 'CRM',
    label: 'Заявки — редактирование',
    paths: [{ prefix: '/applications' }] },
  { key: 'applications:delete', section: 'applications', group: 'CRM',
    label: 'Заявки — удаление',
    paths: [{ prefix: '/applications' }] },
  { key: 'applications:assign', section: 'applications', group: 'CRM',
    label: 'Заявки — назначение менеджера',
    paths: [{ prefix: '/applications' }, { prefix: '/sales/applications' }] },

  { key: 'students:read',   section: 'students', group: 'CRM',
    label: 'Студенты — просмотр',
    paths: [{ method: 'GET', prefix: '/students' }] },
  { key: 'students:create', section: 'students', group: 'CRM',
    label: 'Студенты — создание',
    paths: [{ prefix: '/students' }] },
  { key: 'students:update', section: 'students', group: 'CRM',
    label: 'Студенты — редактирование',
    paths: [{ prefix: '/students' }] },
  { key: 'students:delete', section: 'students', group: 'CRM',
    label: 'Студенты — удаление',
    paths: [{ prefix: '/students' }] },

  { key: 'programs:read',   section: 'programs', group: 'CRM',
    label: 'Программы — просмотр',
    paths: [{ method: 'GET', prefix: '/programs' }] },
  { key: 'programs:create', section: 'programs', group: 'CRM',
    label: 'Программы — создание',
    paths: [{ prefix: '/programs' }] },
  { key: 'programs:update', section: 'programs', group: 'CRM',
    label: 'Программы — редактирование',
    paths: [{ prefix: '/programs' }] },
  { key: 'programs:delete', section: 'programs', group: 'CRM',
    label: 'Программы — удаление',
    paths: [{ prefix: '/programs' }] },

  { key: 'tasks:read',   section: 'tasks', group: 'CRM',
    label: 'Задачи — просмотр',
    paths: [{ method: 'GET', prefix: '/tasks' }] },
  { key: 'tasks:create', section: 'tasks', group: 'CRM',
    label: 'Задачи — создание',
    paths: [{ prefix: '/tasks' }] },
  { key: 'tasks:update', section: 'tasks', group: 'CRM',
    label: 'Задачи — редактирование',
    paths: [{ prefix: '/tasks' }] },
  { key: 'tasks:delete', section: 'tasks', group: 'CRM',
    label: 'Задачи — удаление',
    paths: [{ prefix: '/tasks' }] },

  { key: 'pipelines:read',  section: 'pipelines', group: 'CRM',
    label: 'Воронки — просмотр',
    paths: [{ method: 'GET', prefix: '/sales' }, { method: 'GET', prefix: '/pipelines' }] },
  { key: 'pipelines:write', section: 'pipelines', group: 'CRM',
    label: 'Воронки — редактирование',
    paths: [{ prefix: '/sales' }, { prefix: '/pipelines' }] },

  // ─── Связь ─────────────────────────────────────────────────────────────
  { key: 'chat:read',  section: 'chat', group: 'Связь',
    label: 'Чат — просмотр',
    paths: [{ method: 'GET', prefix: '/chat' }] },
  { key: 'chat:write', section: 'chat', group: 'Связь',
    label: 'Чат — отправка сообщений',
    paths: [{ prefix: '/chat' }] },

  { key: 'inbox:read',  section: 'inbox', group: 'Связь',
    label: 'Входящие — просмотр',
    paths: [
      { method: 'GET', prefix: '/external-messages' },
      { method: 'GET', prefix: '/integrations/inbox' },
    ] },
  { key: 'inbox:reply', section: 'inbox', group: 'Связь',
    label: 'Входящие — ответ',
    paths: [{ prefix: '/external-messages' }, { prefix: '/integrations/inbox' }] },

  { key: 'calls:read',   section: 'calls', group: 'Связь',
    label: 'Звонки — просмотр',
    paths: [
      { method: 'GET', prefix: '/calls' },
      { method: 'GET', prefix: '/call-logs' },
    ] },
  { key: 'calls:create', section: 'calls', group: 'Связь',
    label: 'Звонки — добавление',
    paths: [{ prefix: '/calls' }, { prefix: '/call-logs' }] },

  { key: 'massmail:read',  section: 'massmail', group: 'Связь',
    label: 'Рассылки — просмотр',
    paths: [
      { method: 'GET', prefix: '/integrations/massmail' },
      { method: 'GET', prefix: '/mass-mail' },
    ] },
  { key: 'massmail:write', section: 'massmail', group: 'Связь',
    label: 'Рассылки — редактирование',
    paths: [{ prefix: '/integrations/massmail' }, { prefix: '/mass-mail' }] },
  { key: 'massmail:send',  section: 'massmail', group: 'Связь',
    label: 'Рассылки — отправка',
    paths: [{ prefix: '/integrations/massmail' }, { prefix: '/mass-mail' }] },
  // Legacy alias — чтобы записи в БД с прежним ключом продолжали валидиться.
  { key: 'mass-mail:write', section: 'massmail', group: 'Связь',
    label: 'Рассылки (устар.)',
    paths: [{ prefix: '/integrations/massmail' }, { prefix: '/mass-mail' }] },

  // ─── Аналитика ─────────────────────────────────────────────────────────
  { key: 'kpi:read', section: 'kpi', group: 'Аналитика',
    label: 'KPI — просмотр',
    paths: [{ prefix: '/kpi' }] },

  { key: 'reports:read',   section: 'reports', group: 'Аналитика',
    label: 'Отчёты — просмотр',
    paths: [
      { method: 'GET', prefix: '/daily-reports' },
      { method: 'GET', prefix: '/reports' },
    ] },
  { key: 'reports:create', section: 'reports', group: 'Аналитика',
    label: 'Отчёты — создание',
    paths: [{ prefix: '/daily-reports' }, { prefix: '/reports' }] },

  { key: 'activity:read', section: 'activity', group: 'Аналитика',
    label: 'Журнал активности',
    paths: [{ prefix: '/activity' }] },

  // ─── Продажи ───────────────────────────────────────────────────────────
  { key: 'submissions:read',    section: 'submissions', group: 'Продажи',
    label: 'Сделки — просмотр',
    paths: [{ method: 'GET', prefix: '/submissions' }] },
  { key: 'submissions:create',  section: 'submissions', group: 'Продажи',
    label: 'Сделки — оформление',
    paths: [{ prefix: '/submissions' }] },
  { key: 'submissions:update',  section: 'submissions', group: 'Продажи',
    label: 'Сделки — редактирование',
    paths: [{ prefix: '/submissions' }] },
  { key: 'submissions:delete',  section: 'submissions', group: 'Продажи',
    label: 'Сделки — удаление',
    paths: [{ prefix: '/submissions' }] },
  { key: 'submissions:approve', section: 'submissions', group: 'Продажи',
    label: 'Сделки — одобрение',
    paths: [{ prefix: '/submissions' }] },

  { key: 'offers:read',  section: 'offers', group: 'Продажи',
    label: 'Оферты — просмотр',
    paths: [{ method: 'GET', prefix: '/offers' }] },
  { key: 'offers:write', section: 'offers', group: 'Продажи',
    label: 'Оферты — редактирование',
    paths: [{ prefix: '/offers' }] },
  { key: 'offers:sign',  section: 'offers', group: 'Продажи',
    label: 'Оферты — подписание',
    paths: [{ prefix: '/offers' }] },

  // ─── Финансы ───────────────────────────────────────────────────────────
  { key: 'finance:read',   section: 'finance', group: 'Финансы',
    label: 'Финансы — просмотр',
    paths: [
      { method: 'GET', prefix: '/finance' },
      { method: 'GET', prefix: '/transactions' },
      { method: 'GET', prefix: '/payments' },
    ] },
  { key: 'finance:create', section: 'finance', group: 'Финансы',
    label: 'Финансы — внесение',
    paths: [{ prefix: '/finance' }, { prefix: '/transactions' }, { prefix: '/payments' }] },
  { key: 'finance:update', section: 'finance', group: 'Финансы',
    label: 'Финансы — редактирование',
    paths: [{ prefix: '/finance' }, { prefix: '/transactions' }, { prefix: '/payments' }] },
  { key: 'finance:delete', section: 'finance', group: 'Финансы',
    label: 'Финансы — удаление',
    paths: [{ prefix: '/finance' }, { prefix: '/transactions' }, { prefix: '/payments' }] },
  // Legacy alias — старые записи с `finance:write` продолжают работать.
  { key: 'finance:write', section: 'finance', group: 'Финансы',
    label: 'Финансы (устар. write)',
    paths: [{ prefix: '/finance' }, { prefix: '/transactions' }, { prefix: '/payments' }] },

  { key: 'salary:read',      section: 'salary', group: 'Финансы',
    label: 'Зарплата — просмотр',
    paths: [{ method: 'GET', prefix: '/salary' }] },
  { key: 'salary:calculate', section: 'salary', group: 'Финансы',
    label: 'Зарплата — расчёт',
    paths: [{ prefix: '/salary' }] },
  { key: 'salary:pay',       section: 'salary', group: 'Финансы',
    label: 'Зарплата — выплата',
    paths: [{ prefix: '/salary' }] },
  // Legacy alias.
  { key: 'salary:write',     section: 'salary', group: 'Финансы',
    label: 'Зарплата (устар. write)',
    paths: [{ prefix: '/salary' }] },

  { key: 'penalties:write', section: 'penalties', group: 'Финансы',
    label: 'Штрафы — ручное создание',
    paths: [{ prefix: '/penalties' }] },

  // ─── HR ────────────────────────────────────────────────────────────────
  { key: 'users:read',   section: 'users', group: 'HR',
    label: 'Сотрудники — просмотр',
    paths: [{ method: 'GET', prefix: '/users' }] },
  { key: 'users:create', section: 'users', group: 'HR',
    label: 'Сотрудники — создание',
    paths: [{ prefix: '/users' }] },
  { key: 'users:update', section: 'users', group: 'HR',
    label: 'Сотрудники — редактирование',
    paths: [{ prefix: '/users' }] },
  { key: 'users:delete', section: 'users', group: 'HR',
    label: 'Сотрудники — удаление',
    paths: [{ prefix: '/users' }] },
  // Legacy alias.
  { key: 'users:write',  section: 'users', group: 'HR',
    label: 'Сотрудники (устар. write)',
    paths: [{ prefix: '/users' }] },

  { key: 'workday:read',    section: 'workday', group: 'HR',
    label: 'Рабочий день — свой вход/выход',
    paths: [{ prefix: '/time' }] },
  { key: 'workday:history', section: 'workday', group: 'HR',
    label: 'Рабочий день — история команды',
    paths: [
      { method: 'GET', prefix: '/time' },
      { prefix: '/attendance' },
      { prefix: '/excuses' },
    ] },

  { key: 'attendance:read', section: 'attendance', group: 'HR',
    label: 'Посещаемость',
    paths: [{ prefix: '/attendance' }] },
  { key: 'excuses:write',   section: 'excuses', group: 'HR',
    label: 'Причины опозданий',
    paths: [{ prefix: '/excuses' }] },

  // ─── Обучение ──────────────────────────────────────────────────────────
  { key: 'lms:read',  section: 'lms', group: 'Обучение',
    label: 'Обучение — просмотр',
    paths: [{ method: 'GET', prefix: '/lms' }] },
  { key: 'lms:write', section: 'lms', group: 'Обучение',
    label: 'Обучение — редактирование',
    paths: [{ prefix: '/lms' }] },

  // Группы и расписание занятий. Свой ключ нужен именно потому, что префикс
  // /study-groups новый: без записи в каталоге implicit-проверка RolesGuard
  // не нашла бы для него НИ ОДНОГО permission'а, и носитель кастомной роли
  // получал бы 403 на разделе, который ему открыли в сайдбаре.
  // Пара read/write (а не полный CRUD) — как у lms/partners/settings: тонкой
  // детализации внутри расписания не требуется.
  { key: 'groups:read',  section: 'groups', group: 'Обучение',
    label: 'Группы и расписание — просмотр',
    paths: [{ method: 'GET', prefix: '/study-groups' }] },
  { key: 'groups:write', section: 'groups', group: 'Обучение',
    label: 'Группы и расписание — редактирование',
    paths: [{ prefix: '/study-groups' }] },

  // ─── Партнёры ──────────────────────────────────────────────────────────
  { key: 'partners:read',  section: 'partners', group: 'Партнёры',
    label: 'Партнёры — просмотр',
    paths: [{ method: 'GET', prefix: '/admin/partners' }] },
  { key: 'partners:write', section: 'partners', group: 'Партнёры',
    label: 'Партнёры — редактирование',
    paths: [{ prefix: '/admin/partners' }] },

  // ─── Система ───────────────────────────────────────────────────────────
  // Настройки — по ТЗ доступ у FOUNDER. Пермиссии выданы, но UI-чекбоксы
  // прячутся для не-FOUNDER: смысла тонко настраивать `settings:*` для
  // кастом-роли нет — FOUNDER единолично управляет системой.
  { key: 'settings:read',  section: 'settings', group: 'Система',
    label: 'Настройки — просмотр',
    paths: [{ method: 'GET', prefix: '/settings' }] },
  { key: 'settings:write', section: 'settings', group: 'Система',
    label: 'Настройки — редактирование',
    paths: [{ prefix: '/settings' }] },
];

export const PERMISSION_KEYS: string[] = PERMISSION_CATALOG.map((p) => p.key);

/** Проверить, входит ли permission в каталог (защита от мусора в БД). */
export function isValidPermission(key: string): boolean {
  return PERMISSION_KEYS.includes(key);
}

/** Найти permission(ы) который требуется для конкретного URL+method.
 *  Несколько permissions = OR (любой из них подойдёт).
 *
 *  Правила матчинга:
 *  - Path без method — подходит для любого HTTP-метода.
 *  - Path с method — подходит только на этот метод.
 *  - Для write-запросов (POST/PATCH/PUT/DELETE) read-only permissions
 *    (`:read`, `:history`) НЕ засчитываются — даже если URL матчится. Иначе
 *    юзер с чистым «просмотром» смог бы делать mutations.
 *  - Для read-запросов (GET/HEAD/OPTIONS) засчитывается любой permission
 *    секции — write-family неявно даёт read. */
export function permissionsForRequest(method: string, url: string): string[] {
  const m = method.toUpperCase();
  const isRead = m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
  const matches: string[] = [];
  for (const p of PERMISSION_CATALOG) {
    if (!p.paths) continue;
    let matched = false;
    for (const path of p.paths) {
      if (path.method && path.method.toUpperCase() !== m) continue;
      if (url.startsWith(path.prefix) || url.startsWith(`/api${path.prefix}`)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    // Write запросы не должны удовлетворяться read-only пермиссией.
    if (!isRead && isReadOnlyPermission(p.key)) continue;
    matches.push(p.key);
  }
  return matches;
}
