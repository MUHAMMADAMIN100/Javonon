import { Role } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Роль должности.
 *
 * В «Настройки → Роли» кастомную роль можно привязать к должности
 * (CustomRole.baseRole, поле «Действует на всех с должностью»). Тогда она сама
 * действует на всех сотрудников с этой основной должностью (User.role), у кого
 * нет своей активной роли: их права — ровно отмеченные в роли пункты, как у
 * назначенной лично (база-должность становится «подложкой», см. RolesGuard).
 * Своя роль (User.customRole) важнее роли должности.
 *
 * Привязывать можно только должности менеджеров: роль заменяет права
 * должности целиком, и привязка к руководству (основатель, админ, бухгалтер)
 * урезала бы его одной галочкой.
 */
export const POSITION_ROLE_BASES: Role[] = ['SALES_MANAGER', 'CLIENT_MANAGER'];

/** Подписи должностей для сообщений сервера. */
export const POSITION_LABEL: Record<string, string> = {
  SALES_MANAGER: 'Менеджер по продажам',
  CLIENT_MANAGER: 'Клиентский менеджер',
};

export type CustomRoleRow = { id: string; name: string; isActive: boolean; permissions: string[] };
/** Действующая роль сотрудника; byPosition — пришла от должности, а не назначена лично. */
export type EffectiveCustomRole = CustomRoleRow & { byPosition: boolean };

/** select кастомной роли — тот же набор полей везде, где считаем действующую роль. */
export const CUSTOM_ROLE_SELECT = { id: true, name: true, isActive: true, permissions: true } as const;

type Db = Pick<PrismaService, 'customRole'>;
type UserForRole = { role?: Role | string | null; customRole?: CustomRoleRow | null };

function isPositionBase(role: Role | string | null | undefined): role is Role {
  return !!role && (POSITION_ROLE_BASES as string[]).includes(role);
}

/** Действующая кастомная роль: своя активная → активная роль должности → нет. */
export async function effectiveCustomRole(db: Db, user: UserForRole): Promise<EffectiveCustomRole | null> {
  if (user.customRole?.isActive) return { ...user.customRole, byPosition: false };
  if (!isPositionBase(user.role)) return null;
  const pr = await db.customRole.findFirst({
    where: { baseRole: user.role, isActive: true },
    select: CUSTOM_ROLE_SELECT,
  });
  return pr ? { ...pr, byPosition: true } : null;
}

/** Активные роли должностей одним запросом — когда считаем права многих сотрудников сразу. */
export async function loadPositionRoles(db: Db): Promise<Map<string, CustomRoleRow>> {
  const rows = await db.customRole.findMany({
    where: { baseRole: { not: null }, isActive: true },
    select: { ...CUSTOM_ROLE_SELECT, baseRole: true },
  });
  return new Map(
    rows.map((r) => [r.baseRole as string, { id: r.id, name: r.name, isActive: r.isActive, permissions: r.permissions }]),
  );
}

/** То же, что effectiveCustomRole, но по заранее загруженным ролям должностей. */
export function pickEffectiveCustomRole(user: UserForRole, positionRoles: Map<string, CustomRoleRow>): EffectiveCustomRole | null {
  if (user.customRole?.isActive) return { ...user.customRole, byPosition: false };
  const pr = isPositionBase(user.role) ? positionRoles.get(user.role) : undefined;
  return pr ? { ...pr, byPosition: true } : null;
}

/** Кто работает по роли должности: эта основная должность, не уволен, своей активной роли нет. */
export function positionUsersWhere(baseRole: Role) {
  return {
    role: baseRole,
    isActive: true,
    OR: [{ customRoleId: null }, { customRole: { isActive: false } }],
  };
}
