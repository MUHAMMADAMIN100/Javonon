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
};

export function hasPermission(user: UserWithPerms | undefined | null, ...required: string[]): boolean {
  if (!user) return false;
  if (isFounder(user as any)) return true;
  const list = user.permissions || [];
  if (list.length === 0) return false;
  return required.some((p) => list.includes(p));
}

/** Есть ли у юзера ХОТЯ БЫ ОДИН permission из списка. */
export function hasAnyPermission(user: UserWithPerms | undefined | null, list: string[]): boolean {
  return hasPermission(user, ...list);
}

/** Все ключи permissions, известные UI. Должны совпадать с backend
 *  PERMISSION_CATALOG (см. backend/src/auth/permissions.ts). */
export const PERMISSION_KEYS = {
  applicationsRead: 'applications:read',
  applicationsWrite: 'applications:write',
  studentsRead: 'students:read',
  studentsWrite: 'students:write',
  programsRead: 'programs:read',
  programsWrite: 'programs:write',
  tasksRead: 'tasks:read',
  tasksWrite: 'tasks:write',
  pipelinesWrite: 'pipelines:write',
  chatRead: 'chat:read',
  inboxRead: 'inbox:read',
  callsRead: 'calls:read',
  callsWrite: 'calls:write',
  massMailWrite: 'mass-mail:write',
  financeRead: 'finance:read',
  financeWrite: 'finance:write',
  salaryRead: 'salary:read',
  salaryWrite: 'salary:write',
  penaltiesWrite: 'penalties:write',
  kpiRead: 'kpi:read',
  reportsRead: 'reports:read',
  activityRead: 'activity:read',
  usersRead: 'users:read',
  usersWrite: 'users:write',
  attendanceRead: 'attendance:read',
  excusesWrite: 'excuses:write',
  lmsRead: 'lms:read',
  lmsWrite: 'lms:write',
  partnersRead: 'partners:read',
} as const;
