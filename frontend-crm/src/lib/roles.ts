import { ROLE_LABEL, type Role } from '../api/types';

/**
 * Хелперы проверки ролей. Зеркалят backend/src/auth/role-utils.ts.
 *
 * Учитывают и primary `user.role`, и массив `user.roles[]` — один человек
 * может быть, например, и ADMIN, и ACCOUNTANT одновременно.
 *
 * FOUNDER — неявный супер-доступ ко всему.
 */

export type UserWithRoles = {
  role?: string | null;
  roles?: string[] | null;
};

const NORMALIZE = (r?: string | null): Role | undefined => {
  if (!r) return undefined;
  // Старые токены/кэш могут вернуть EMPLOYEE — backend нормализует это в
  // JwtStrategy.validate, но дублируем на фронте для надёжности.
  if (r === 'EMPLOYEE') return 'SALES_MANAGER';
  return r as Role;
};

export function hasRole(user: UserWithRoles | undefined | null, ...required: Role[]): boolean {
  if (!user) return false;
  const all = [user.role, ...(user.roles || [])]
    .map(NORMALIZE)
    .filter(Boolean) as Role[];
  return required.some((r) => all.includes(r));
}

export function isFounder(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'FOUNDER');
}

/** FOUNDER / ADMIN / ACCOUNTANT — равный полный доступ к админ-зоне (по ТЗ). */
export function isElevated(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'FOUNDER', 'ADMIN', 'ACCOUNTANT');
}

export function isManager(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'SALES_MANAGER', 'CLIENT_MANAGER');
}

export function isStaff(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'FOUNDER', 'ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER');
}

/**
 * Лейбл роли для отображения. Если у юзера привязана активная кастомная
 * роль (Настройки → Роли и доступы) — показываем её имя; иначе — лейбл
 * базовой роли из ROLE_LABEL. Используется везде в UI чтобы «Таргетолог»
 * выводился вместо «Менеджер по продажам» (которая внутри как «носитель»
 * permissions для прав FK).
 */
export function displayRoleLabel(user: {
  role?: string | null;
  customRole?: { name?: string; isActive?: boolean } | null;
} | null | undefined): string {
  if (!user) return '—';
  if (user.customRole && user.customRole.name && user.customRole.isActive !== false) {
    return user.customRole.name;
  }
  const role = (user.role || 'SALES_MANAGER') as Role;
  return ROLE_LABEL[role] || String(role);
}
