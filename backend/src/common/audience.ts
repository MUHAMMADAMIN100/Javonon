import { canSeeAllApplications } from '../applications/application-access';
import { hasRole, isFounder, type UserWithRoles } from '../auth/role-utils';
import { CUSTOM_ROLE_SELECT, pickEffectiveCustomRole, type CustomRoleRow } from '../auth/position-role';

/**
 * Кому положено видеть данные — одно правило для REST, сокета и
 * уведомлений (раньше новая заявка с ФИО и телефоном, день рождения
 * студента, смена менеджера у транзакции с суммой уходили ВСЕМ
 * сотрудникам, включая уволенных).
 *
 *  - applications — все заявки/студенты: основатель, админ/бухгалтер по
 *    базовой роли, кастомная роль с правом «Заявки — назначение»
 *    (canSeeAllApplications); плюс назначенные менеджеры — отдельно;
 *  - finance      — финансы: основатель, админ/бухгалтер по базовой роли,
 *    кастомная роль с любым правом «Финансы — …».
 */
export type AudienceKind = 'applications' | 'finance';

export function canSeeFinance(user: UserWithRoles | null | undefined): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  if (user.hasCustomRole) return (user.permissions || []).some((p) => p.startsWith('finance:'));
  return hasRole(user, 'ADMIN', 'ACCOUNTANT');
}

export function inAudience(kind: AudienceKind, user: UserWithRoles | null | undefined): boolean {
  return kind === 'finance' ? canSeeFinance(user) : canSeeAllApplications(user);
}

/**
 * Строка пользователя из БД → UserWithRoles. Действующая кастомная роль (своя
 * или роль должности — positionRoles из loadPositionRoles) заменяет базовую.
 */
export function toUserWithRoles(
  u: {
    role: string;
    roles?: string[] | null;
    customRole?: CustomRoleRow | null;
  },
  positionRoles: Map<string, CustomRoleRow> = new Map(),
): UserWithRoles {
  const custom = pickEffectiveCustomRole(u, positionRoles);
  return {
    role: u.role as any,
    roles: (u.roles || []) as any,
    permissions: custom ? custom.permissions : [],
    hasCustomRole: !!custom,
  };
}

/** select для toUserWithRoles. */
export const AUDIENCE_USER_SELECT = {
  id: true,
  role: true,
  roles: true,
  isActive: true,
  customRole: { select: CUSTOM_ROLE_SELECT },
} as const;
