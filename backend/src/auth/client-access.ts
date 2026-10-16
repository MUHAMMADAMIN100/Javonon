import { isElevated, UserWithRoles } from './role-utils';

/**
 * «Все, не только свои» — студенты, заявки, лиды.
 *
 * Обычно менеджер видит и ведёт только тех, где он назначен менеджером
 * (TJ или CN). Эти доступы снимают ограничение — по отдельности для
 * студентов, заявок и лидов (лид — заявка в статусе «Новый лид», см.
 * applications/application-access.ts). С ними сотрудник видит чужих в
 * списках и счётчиках, открывает карточки и работает с ними как со своими:
 * правит, меняет статус и этап, пишет историю общения, ведёт документы.
 *
 * Откуда берутся (любой источник):
 *  • галочка в карточке сотрудника (User.extraPermissions) — при любой роли,
 *    остальные права сотрудника не меняются;
 *  • пункт кастомной роли (Настройки → Роли, конец блока CRM).
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

/** Что основатель может выдать сотруднику лично (карточка сотрудника). */
export const EXTRA_PERMISSION_KEYS: string[] = Object.values(SEE_ALL_PERMISSION);

/** Только допустимые ключи, без повторов и в постоянном порядке — так пишем в User.extraPermissions и так читаем. */
export function cleanExtraPermissions(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return EXTRA_PERMISSION_KEYS.filter((k) => list.includes(k));
}

/** Выданы ли «все» этой области — лично или кастомной ролью (руководство здесь не учитывается). */
export function hasSeeAllGrant(user: UserWithRoles | null | undefined, scope: ClientScope): boolean {
  if (!user) return false;
  const key = SEE_ALL_PERMISSION[scope];
  if ((user.extraPermissions || []).includes(key)) return true;
  return !!user.hasCustomRole && (user.permissions || []).includes(key);
}

/** Видит и ведёт всех студентов, а не только своих. Руководство — как раньше (isElevated). */
export function canSeeAllStudents(user: UserWithRoles | null | undefined): boolean {
  if (!user) return false;
  if (isElevated(user)) return true;
  return hasSeeAllGrant(user, 'students');
}
