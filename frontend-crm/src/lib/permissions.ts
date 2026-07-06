import { isFounder } from './roles';

/**
 * Permission helpers — фронтовое зеркало backend/src/auth/role-utils.ts
 * (hasPermission) + ключи permissions из PERMISSION_CATALOG.
 *
 * Главное правило: FOUNDER — неявный супер-доступ ко всему (ровно как
 * на backend). Иначе — проверяем permissions из user.permissions[]
 * (бэкенд заполняет при validate JWT из CustomRole.permissions).
 */

export type UserWithPerms = {
  role?: string | null;
  roles?: string[] | null;
  permissions?: string[] | null;
  /** Свежий snapshot из /auth/me — используется как fallback, если JWT
   *  ещё не перечитан после того, как FOUNDER расширил роль в realtime. */
  customRole?: {
    id?: string;
    name?: string;
    isActive?: boolean;
    permissions?: string[] | null;
  } | null;
};

/**
 * Показывать ли пользователю UI/раздел, требующий один из `required`
 * пермиссий. Task 4: смотрим оба источника:
 *   1. `user.permissions` — из JWT-payload (backend кладёт при validate).
 *   2. `user.customRole.permissions` — свежий snapshot из /auth/me.
 * Второй важен когда FOUNDER только что расширил роль в realtime — JWT
 * ещё старый, но после customRole:updated мы дёрнули /auth/me и
 * `user.customRole.permissions` уже содержит новые ключи. Backend RolesGuard
 * тоже читает permissions заново из БД, поэтому запрос пройдёт.
 * FOUNDER — неявный супер-доступ ко всему.
 */
export function hasPermission(user: UserWithPerms | undefined | null, ...required: string[]): boolean {
  if (!user) return false;
  if (isFounder(user as any)) return true;
  const fromJwt = user.permissions || [];
  const fromCustomRole =
    user.customRole && user.customRole.isActive !== false
      ? user.customRole.permissions || []
      : [];
  // Объединяем оба источника — достаточно чтобы permission был в любом.
  if (fromJwt.length === 0 && fromCustomRole.length === 0) return false;
  return required.some((p) => fromJwt.includes(p) || fromCustomRole.includes(p));
}

/** Есть ли у юзера ХОТЯ БЫ ОДИН permission из списка. */
export function hasAnyPermission(user: UserWithPerms | undefined | null, list: string[]): boolean {
  return hasPermission(user, ...list);
}

/** Все ключи permissions, известные UI. Должны совпадать с backend
 *  PERMISSION_CATALOG (см. backend/src/auth/permissions.ts).
 *  Task 4: расширено до полного CRUD по всем разделам сайдбара. */
export const PERMISSION_KEYS = {
  // Applications (CRUD + assign)
  applicationsRead: 'applications:read',
  applicationsCreate: 'applications:create',
  applicationsUpdate: 'applications:update',
  applicationsDelete: 'applications:delete',
  applicationsAssign: 'applications:assign',
  /** @deprecated используйте детальные applications:{create,update,delete}. */
  applicationsWrite: 'applications:write',

  // Students (CRUD)
  studentsRead: 'students:read',
  studentsCreate: 'students:create',
  studentsUpdate: 'students:update',
  studentsDelete: 'students:delete',
  /** @deprecated */ studentsWrite: 'students:write',

  // Programs (CRUD)
  programsRead: 'programs:read',
  programsCreate: 'programs:create',
  programsUpdate: 'programs:update',
  programsDelete: 'programs:delete',
  /** @deprecated */ programsWrite: 'programs:write',

  // Tasks (CRUD)
  tasksRead: 'tasks:read',
  tasksCreate: 'tasks:create',
  tasksUpdate: 'tasks:update',
  tasksDelete: 'tasks:delete',
  /** @deprecated */ tasksWrite: 'tasks:write',

  // Pipelines (read + write)
  pipelinesRead: 'pipelines:read',
  pipelinesWrite: 'pipelines:write',

  // Chat (read + write)
  chatRead: 'chat:read',
  chatWrite: 'chat:write',

  // Inbox (read + reply)
  inboxRead: 'inbox:read',
  inboxReply: 'inbox:reply',

  // Workday (clock in/out + view team history)
  workdayRead: 'workday:read',
  workdayHistory: 'workday:history',

  // Reports (read + create)
  reportsRead: 'reports:read',
  reportsCreate: 'reports:create',

  // Calls (read + create)
  callsRead: 'calls:read',
  callsCreate: 'calls:create',
  /** @deprecated */ callsWrite: 'calls:write',

  // KPI (read only)
  kpiRead: 'kpi:read',

  // Finance (CRUD)
  financeRead: 'finance:read',
  financeCreate: 'finance:create',
  financeUpdate: 'finance:update',
  financeDelete: 'finance:delete',
  /** @deprecated */ financeWrite: 'finance:write',

  // Salary (read + calculate + pay)
  salaryRead: 'salary:read',
  salaryCalculate: 'salary:calculate',
  salaryPay: 'salary:pay',
  /** @deprecated */ salaryWrite: 'salary:write',

  // Submissions (CRUD + approve)
  submissionsRead: 'submissions:read',
  submissionsCreate: 'submissions:create',
  submissionsUpdate: 'submissions:update',
  submissionsDelete: 'submissions:delete',
  submissionsApprove: 'submissions:approve',

  // Mass-mail (read + write + send)
  massMailRead: 'massmail:read',
  massMailWrite: 'massmail:write',
  massMailSend: 'massmail:send',
  /** @deprecated legacy hyphenated key. */
  massMailWriteLegacy: 'mass-mail:write',

  // Offers (read + write + sign)
  offersRead: 'offers:read',
  offersWrite: 'offers:write',
  offersSign: 'offers:sign',

  // Activity (read only)
  activityRead: 'activity:read',

  // Users (CRUD)
  usersRead: 'users:read',
  usersCreate: 'users:create',
  usersUpdate: 'users:update',
  usersDelete: 'users:delete',
  /** @deprecated */ usersWrite: 'users:write',

  // Settings (read + write) — де-факто FOUNDER-only.
  settingsRead: 'settings:read',
  settingsWrite: 'settings:write',

  // LMS (read + write)
  lmsRead: 'lms:read',
  lmsWrite: 'lms:write',

  // Partners (read + write)
  partnersRead: 'partners:read',
  partnersWrite: 'partners:write',

  // HR (kept for backwards compat — used inside /workday sub-tabs).
  penaltiesWrite: 'penalties:write',
  attendanceRead: 'attendance:read',
  excusesWrite: 'excuses:write',
} as const;
