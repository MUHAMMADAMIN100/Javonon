import { hasPermission, isFounder, UserWithRoles } from '../auth/role-utils';

/**
 * Работает со ВСЕМИ сделками, а не только со своими: основатель; сотрудник
 * с ролью — «Сделки — все, не только свои»; должность — по правилу места
 * вызова (base): где-то это админ, где-то только основатель.
 */
export function seesAllDeals(
  user: (UserWithRoles & { id?: string }) | null | undefined,
  base: () => boolean,
): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  if (user.hasCustomRole) return hasPermission(user, 'submissions:all');
  return base();
}

/** Сотрудник с ролью может трогать эту сделку: своя или «все сделки». */
export function roleDealInScope(
  user: (UserWithRoles & { id: string }) | null | undefined,
  managerId: string | null,
): boolean {
  if (!user) return false;
  if (!user.hasCustomRole || isFounder(user)) return true;
  return (!!managerId && managerId === user.id) || hasPermission(user, 'submissions:all');
}
