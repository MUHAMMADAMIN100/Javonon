/**
 * Каталог пермиссий для кастомных ролей. FOUNDER в /settings → Роли
 * выбирает чекбоксами какие из них дать новой роли (например
 * «Таргетолог» → заявки/чтение + KPI/чтение + лиды/запись).
 *
 * Ключ — формат `module:action`. Действие — read | write.
 * write подразумевает read.
 *
 * Sidebar/ProtectedRoute на фронте + RolesGuard на бэке смотрят
 * на ЭТОТ ЖЕ список — он единый источник правды.
 */

export interface PermissionDef {
  key: string;
  label: string;     // что показать в чекбоксе
  group: string;     // под какой подзаголовок
  /** Какие URL-пути на бэке этот пермишен «открывает». RolesGuard
   *  использует, чтобы понять — даже без @Roles на эндпоинте — что
   *  custom-role-юзер имеет доступ. */
  paths?: Array<{ method?: string; prefix: string }>;
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  // CRM core
  { key: 'applications:read',  group: 'CRM',     label: 'Заявки — просмотр',
    paths: [{ method: 'GET', prefix: '/applications' }] },
  { key: 'applications:write', group: 'CRM',     label: 'Заявки — редактирование',
    paths: [{ prefix: '/applications' }] },
  { key: 'students:read',      group: 'CRM',     label: 'Студенты — просмотр',
    paths: [{ method: 'GET', prefix: '/students' }] },
  { key: 'students:write',     group: 'CRM',     label: 'Студенты — редактирование',
    paths: [{ prefix: '/students' }] },
  { key: 'programs:read',      group: 'CRM',     label: 'Программы — просмотр',
    paths: [{ method: 'GET', prefix: '/programs' }] },
  { key: 'programs:write',     group: 'CRM',     label: 'Программы — редактирование',
    paths: [{ prefix: '/programs' }] },
  { key: 'tasks:read',         group: 'CRM',     label: 'Задачи — просмотр',
    paths: [{ method: 'GET', prefix: '/tasks' }] },
  { key: 'tasks:write',        group: 'CRM',     label: 'Задачи — редактирование',
    paths: [{ prefix: '/tasks' }] },
  { key: 'pipelines:write',    group: 'CRM',     label: 'Воронки — редактирование',
    paths: [{ prefix: '/pipelines' }] },

  // Связь
  { key: 'chat:read',          group: 'Связь',   label: 'Чат',
    paths: [{ prefix: '/chat' }] },
  { key: 'inbox:read',         group: 'Связь',   label: 'Входящие сообщения',
    paths: [{ prefix: '/external-messages' }] },
  { key: 'calls:read',         group: 'Связь',   label: 'Звонки — просмотр',
    paths: [{ method: 'GET', prefix: '/call-logs' }] },
  { key: 'calls:write',        group: 'Связь',   label: 'Звонки — добавление',
    paths: [{ prefix: '/call-logs' }] },
  { key: 'mass-mail:write',    group: 'Связь',   label: 'Рассылки',
    paths: [{ prefix: '/mass-mail' }] },

  // Финансы
  { key: 'finance:read',       group: 'Финансы', label: 'Финансы — просмотр',
    paths: [{ method: 'GET', prefix: '/finance' }] },
  { key: 'finance:write',      group: 'Финансы', label: 'Финансы — внесение',
    paths: [{ prefix: '/finance' }, { prefix: '/transactions' }] },
  { key: 'salary:read',        group: 'Финансы', label: 'Зарплата — просмотр',
    paths: [{ method: 'GET', prefix: '/salary' }] },
  { key: 'salary:write',       group: 'Финансы', label: 'Зарплата — расчёт/выплата',
    paths: [{ prefix: '/salary' }] },
  { key: 'penalties:write',    group: 'Финансы', label: 'Штрафы — ручное создание',
    paths: [{ prefix: '/penalties' }] },

  // Аналитика
  { key: 'kpi:read',           group: 'Аналитика', label: 'KPI — просмотр',
    paths: [{ prefix: '/kpi' }] },
  { key: 'reports:read',       group: 'Аналитика', label: 'Отчёты — просмотр',
    paths: [{ prefix: '/daily-reports' }] },
  { key: 'activity:read',      group: 'Аналитика', label: 'Журнал активности',
    paths: [{ prefix: '/activity' }] },

  // HR
  { key: 'users:read',         group: 'HR',      label: 'Сотрудники — просмотр',
    paths: [{ method: 'GET', prefix: '/users' }] },
  { key: 'users:write',        group: 'HR',      label: 'Сотрудники — редактирование',
    paths: [{ prefix: '/users' }] },
  { key: 'attendance:read',    group: 'HR',      label: 'Посещаемость',
    paths: [{ prefix: '/attendance' }] },
  { key: 'excuses:write',      group: 'HR',      label: 'Причины опозданий',
    paths: [{ prefix: '/excuses' }] },

  // Обучение
  { key: 'lms:read',           group: 'Обучение', label: 'Обучение — просмотр',
    paths: [{ method: 'GET', prefix: '/lms' }] },
  { key: 'lms:write',          group: 'Обучение', label: 'Обучение — редактирование',
    paths: [{ prefix: '/lms' }] },

  // Партнёры
  { key: 'partners:read',      group: 'Партнёры', label: 'Партнёры',
    paths: [{ prefix: '/admin/partners' }] },
];

export const PERMISSION_KEYS: string[] = PERMISSION_CATALOG.map((p) => p.key);

/** Проверить, входит ли permission в каталог (защита от мусора в БД). */
export function isValidPermission(key: string): boolean {
  return PERMISSION_KEYS.includes(key);
}

/** Найти permission(ы) который требуется для конкретного URL+method.
 *  Несколько permissions = OR (любой из них подойдёт). */
export function permissionsForRequest(method: string, url: string): string[] {
  const m = method.toUpperCase();
  const isRead = m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
  const matches: string[] = [];
  for (const p of PERMISSION_CATALOG) {
    if (!p.paths) continue;
    for (const path of p.paths) {
      if (path.method && path.method.toUpperCase() !== m) continue;
      // path без method подходит и для GET тоже
      if (url.startsWith(path.prefix) || url.startsWith(`/api${path.prefix}`)) {
        // Если пермиссия пишущая (`:write`), но request — read, не блокируем —
        // запись разрешает чтение. Read запросы матчатся И read-пермиссией,
        // И write-пермиссией.
        if (isRead && p.key.endsWith(':write')) {
          matches.push(p.key);
        } else {
          matches.push(p.key);
        }
      }
    }
  }
  return matches;
}
