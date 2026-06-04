import { Role } from '@prisma/client';

/**
 * Хелперы проверки ролей с учётом множественных ролей (User.roles[]).
 * FOUNDER неявно имеет доступ ко всему — этот же check применяется в
 * RolesGuard, поэтому отдельно перечислять 'FOUNDER' в @Roles(...) не нужно.
 *
 * Также: ADMIN и ACCOUNTANT имеют одинаковый уровень доступа (по ТЗ),
 * поэтому везде где раньше было @Roles('ADMIN'), теперь @Roles('ADMIN',
 * 'ACCOUNTANT'). Эта пара вынесена в ELEVATED_ROLES для краткости.
 */

export const ELEVATED_ROLES: Role[] = ['ADMIN', 'ACCOUNTANT'];
export const MANAGER_ROLES: Role[] = ['SALES_MANAGER', 'CLIENT_MANAGER'];

export type UserWithRoles = {
  role?: Role | string | null;
  roles?: (Role | string)[] | null;
};

/** Есть ли у пользователя любая из перечисленных ролей. */
export function hasRole(user: UserWithRoles | undefined | null, ...required: Role[]): boolean {
  if (!user) return false;
  const all = [user.role, ...(user.roles || [])].filter(Boolean) as string[];
  return required.some((r) => all.includes(r));
}

/** FOUNDER. */
export function isFounder(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'FOUNDER');
}

/** FOUNDER / ADMIN / ACCOUNTANT — те, кому в ТЗ дан полный доступ к админ-зоне. */
export function isElevated(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'FOUNDER', 'ADMIN', 'ACCOUNTANT');
}

/** Любой менеджер по продажам или клиентский менеджер. */
export function isManager(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'SALES_MANAGER', 'CLIENT_MANAGER');
}

/** Любой сотрудник компании (кроме студентов/партнёров). */
export function isStaff(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'FOUNDER', 'ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER');
}
