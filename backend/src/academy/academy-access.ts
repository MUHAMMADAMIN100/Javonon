import { ForbiddenException } from '@nestjs/common';
import { hasPermission, hasRole, isFounder, type UserWithRoles } from '../auth/role-utils';

/**
 * Кто что может в академии. Одно место для сервиса групп, журнала,
 * учеников и флагов.
 *
 *  - Руководство академии (isAcademyManager): основатель, админ по базовой
 *    роли, кастомная роль с правом «Академия — управление». Создаёт группы,
 *    назначает учителей, меняет состав, заводит учеников, снимает флаги и
 *    решает «отчислить / оставить». Видит все группы и всех учеников.
 *  - Учитель группы (StudyGroup.teacherId): ведёт СВОИ группы — журнал,
 *    уроки, ДЗ, материалы, расписание, флаги своим ученикам.
 *  - Подменный учитель занятия (ClassSession.teacherId): отмечает журнал
 *    только этого занятия.
 *
 * Бухгалтер сюда не входит: состав групп — персональные данные учеников,
 * а не финансовая поверхность (так было и в study-groups).
 */
export type AcademyViewer = (UserWithRoles & { id: string }) | null | undefined;

export const ACADEMY_MANAGE_PERMISSION = 'academy:manage';

export function isAcademyManager(user: AcademyViewer | UserWithRoles | null | undefined): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  // Своя роль заменяет базовую (как в RolesGuard): админ со своей ролью
  // управляет академией, только если в роли отмечено это право.
  if (user.hasCustomRole) return hasPermission(user, ACADEMY_MANAGE_PERMISSION);
  return hasRole(user, 'ADMIN');
}

export function assertAcademyManager(user: AcademyViewer) {
  if (!isAcademyManager(user)) {
    throw new ForbiddenException('Это может только руководство академии');
  }
}

/** Штатный учитель группы. */
export function teachesGroup(user: AcademyViewer, group: { teacherId: string | null }): boolean {
  return !!user && !!group.teacherId && group.teacherId === user.id;
}

/** Руководство или учитель группы — ведут журнал, уроки, материалы. */
export function canRunGroup(user: AcademyViewer, group: { teacherId: string | null }): boolean {
  return isAcademyManager(user) || teachesGroup(user, group);
}

export function assertCanRunGroup(user: AcademyViewer, group: { teacherId: string | null }) {
  if (!user) throw new ForbiddenException('Недостаточно прав');
  if (!canRunGroup(user, group)) throw new ForbiddenException('Это не ваша группа');
}

/**
 * Отметки конкретного занятия: руководство, учитель группы и подменный
 * учитель этого занятия.
 */
export function canMarkSession(
  user: AcademyViewer,
  session: { teacherId: string | null; group: { teacherId: string | null } },
): boolean {
  if (canRunGroup(user, session.group)) return true;
  return !!user && !!session.teacherId && session.teacherId === user.id;
}
