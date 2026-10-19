import { hasPermission, isElevated, isFounder, UserWithRoles } from './role-utils';

/**
 * «Все, не только свои» — студенты, заявки, лиды.
 *
 * Обычно менеджер видит и ведёт только тех, где он назначен менеджером
 * (TJ или CN). Эти пункты роли снимают ограничение — по отдельности для
 * студентов, заявок и лидов (лид — заявка в статусе «Новый лид», см.
 * applications/application-access.ts). С ними сотрудник видит чужих в
 * списках и счётчиках, открывает карточки и работает с ними как со своими:
 * правит, меняет статус и этап, пишет историю общения, ведёт документы.
 *
 * Выдаются только ролью (Настройки → Роли, конец блока CRM): назначенной
 * сотруднику лично или ролью его должности (auth/position-role.ts).
 * Руководство (основатель, админ, бухгалтер) видит всех и без них.
 *
 * Удаление и назначение менеджера сюда НЕ входят: удалить чужую заявку или
 * студента, отдать клиента другому менеджеру — по-прежнему по своим правилам.
 */
export type ClientScope = 'students' | 'applications' | 'leads';

export const SEE_ALL_PERMISSION: Record<ClientScope, string> = {
  students: 'students:all',
  applications: 'applications:all',
  leads: 'leads:all',
};

/** Выданы ли «все» этой области действующей ролью (руководство здесь не учитывается). */
export function hasSeeAllGrant(user: UserWithRoles | null | undefined, scope: ClientScope): boolean {
  if (!user) return false;
  return !!user.hasCustomRole && (user.permissions || []).includes(SEE_ALL_PERMISSION[scope]);
}

/**
 * Видит и ведёт всех студентов, а не только своих. Руководство — как раньше
 * (isElevated); у сотрудника с ролью должность под ролью ничего не даёт —
 * только «Студенты — все, не только свои».
 */
export function canSeeAllStudents(user: UserWithRoles | null | undefined): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  if (user.hasCustomRole) return hasSeeAllGrant(user, 'students');
  return isElevated(user);
}

/** Роль без «Студенты — просмотр» студентов не видит вовсе (списки, счётчики). */
export function canReadStudents(user: UserWithRoles | null | undefined): boolean {
  if (!user) return false;
  if (!user.hasCustomRole || isFounder(user)) return true;
  return hasPermission(user, 'students:read');
}
