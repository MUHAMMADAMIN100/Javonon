import { ForbiddenException } from '@nestjs/common';
import { hasPermission, hasRole, isFounder, type UserWithRoles } from '../auth/role-utils';

/**
 * Кто что может в академии. Одно место для сервиса групп, журнала,
 * учеников и флагов.
 *
 *  - Руководство академии по должности: основатель и админ. Видит все
 *    группы и всех учеников и может в академии всё.
 *  - Сотрудник с ролью (Настройки → Роли, «Академия и обучение») — ровно
 *    по галочкам (с 19.10.2026, раньше было одно «управление» на всё):
 *      «Группы академии — просмотр своих групп» (groups:read) и
 *      «Ведение: журнал, уроки, ДЗ, расписание, флаги» (groups:write) —
 *      свои группы, где он учитель; «Все группы и ученики» (academy:all)
 *      — снимает «только свои»; создание, изменение и удаление групп,
 *      состав, ученики, уровни, флаги, решения, завершение курса — каждое
 *      своей галочкой.
 *  - Учитель группы (StudyGroup.teacherId): ведёт СВОИ группы — журнал,
 *    уроки, ДЗ, материалы, расписание, флаги своим ученикам; добавляет
 *    учеников, правит их и завершает курс.
 *  - Подменный учитель занятия (ClassSession.teacherId): отмечает журнал
 *    только этого занятия.
 *
 * Бухгалтер сюда не входит: состав групп — персональные данные учеников,
 * а не финансовая поверхность (так было и в study-groups).
 */
export type AcademyViewer = (UserWithRoles & { id: string }) | null | undefined;

const ALL_PERMISSION = 'academy:all';

/**
 * Видит все группы и всех учеников, а не только свои: основатель, админ по
 * должности; сотрудник с ролью — «Все группы и ученики, не только свои».
 */
export function isAcademyManager(user: AcademyViewer | UserWithRoles | null | undefined): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  // Своя роль заменяет должность (как в RolesGuard): админ со своей ролью
  // видит всё, только если в роли это отмечено.
  if (user.hasCustomRole) return hasPermission(user, ALL_PERMISSION);
  return hasRole(user, 'ADMIN');
}

/** Действие руководства академии: основатель, админ по должности; роль — её галочка. */
export function academyCan(user: AcademyViewer | UserWithRoles | null | undefined, key: string): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  if (user.hasCustomRole) return hasPermission(user, key);
  return hasRole(user, 'ADMIN');
}

export function assertAcademyCan(user: AcademyViewer, key: string) {
  if (!academyCan(user, key)) {
    throw new ForbiddenException('Это может только руководство академии');
  }
}

/**
 * Действие в конкретной группе. Роль — её галочка и группа своя (учитель)
 * или «Все группы»; основатель — всегда; должность — по правилу места
 * вызова (base), как было до подробных прав.
 */
export function academyGroupCan(
  user: AcademyViewer,
  group: { teacherId: string | null },
  key: string,
  base: () => boolean,
): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  if (user.hasCustomRole) {
    return hasPermission(user, key) && (teachesGroup(user, group) || hasPermission(user, ALL_PERMISSION));
  }
  return base();
}

/** Есть ли галочка у сотрудника с ролью (основатель и должности — да: их ведут прежние правила). */
export function roleHas(user: AcademyViewer, key: string): boolean {
  return !user?.hasCustomRole || isFounder(user) || hasPermission(user, key);
}

/** Сотрудник с ролью без этой галочки — отказ (основатель и должности не затрагиваются). */
export function assertRoleHas(user: AcademyViewer, key: string, message = 'Недостаточно прав') {
  if (!roleHas(user, key)) {
    throw new ForbiddenException(message);
  }
}

/** Штатный учитель группы. */
export function teachesGroup(user: AcademyViewer, group: { teacherId: string | null }): boolean {
  return !!user && !!group.teacherId && group.teacherId === user.id;
}

/**
 * Ведёт журнал, уроки, материалы: руководство или учитель группы; сотрудник
 * с ролью — с «Ведением» и в своей группе (или во всех — с «Все группы»).
 */
export function canRunGroup(user: AcademyViewer, group: { teacherId: string | null }): boolean {
  if (!user) return false;
  if (user.hasCustomRole && !isFounder(user)) {
    return hasPermission(user, 'groups:write') && (teachesGroup(user, group) || hasPermission(user, ALL_PERMISSION));
  }
  return isAcademyManager(user) || teachesGroup(user, group);
}

export function assertCanRunGroup(user: AcademyViewer, group: { teacherId: string | null }) {
  if (!user) throw new ForbiddenException('Недостаточно прав');
  if (!canRunGroup(user, group)) throw new ForbiddenException('Это не ваша группа');
}

/**
 * Отметки конкретного занятия: руководство, учитель группы и подменный
 * учитель этого занятия (сотруднику с ролью нужно «Ведение»).
 */
export function canMarkSession(
  user: AcademyViewer,
  session: { teacherId: string | null; group: { teacherId: string | null } },
): boolean {
  if (canRunGroup(user, session.group)) return true;
  const substitute = !!user && !!session.teacherId && session.teacherId === user.id;
  if (!substitute) return false;
  return !user!.hasCustomRole || isFounder(user) || hasPermission(user, 'groups:write');
}
