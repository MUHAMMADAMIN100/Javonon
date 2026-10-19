import { hasRole, isElevated, isFounder } from './roles';

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
  /** Свежий snapshot из /auth/me — используется как fallback, если JWT
   *  ещё не перечитан после того, как FOUNDER расширил роль в realtime. */
  customRole?: {
    id?: string;
    name?: string;
    isActive?: boolean;
    permissions?: string[] | null;
  } | null;
};

/**
 * Показывать ли пользователю UI/раздел, требующий один из `required`
 * пермиссий. Task 4: смотрим оба источника:
 *   1. `user.permissions` — из JWT-payload (backend кладёт при validate).
 *   2. `user.customRole.permissions` — свежий snapshot из /auth/me.
 * Второй важен когда FOUNDER только что расширил роль в realtime — JWT
 * ещё старый, но после customRole:updated мы дёрнули /auth/me и
 * `user.customRole.permissions` уже содержит новые ключи. Backend RolesGuard
 * тоже читает permissions заново из БД, поэтому запрос пройдёт.
 * FOUNDER — неявный супер-доступ ко всему.
 */
export function hasPermission(user: UserWithPerms | undefined | null, ...required: string[]): boolean {
  if (!user) return false;
  if (isFounder(user as any)) return true;
  const fromJwt = user.permissions || [];
  const fromCustomRole =
    user.customRole && user.customRole.isActive !== false
      ? user.customRole.permissions || []
      : [];
  // Объединяем оба источника — достаточно чтобы permission был в любом.
  if (fromJwt.length === 0 && fromCustomRole.length === 0) return false;
  return required.some((p) => fromJwt.includes(p) || fromCustomRole.includes(p));
}

/** Есть ли у юзера ХОТЯ БЫ ОДИН permission из списка. */
export function hasAnyPermission(user: UserWithPerms | undefined | null, list: string[]): boolean {
  return hasPermission(user, ...list);
}

/** Действует ли у сотрудника роль — своя или роль должности (user.customRole из /auth/me). */
export function hasActiveRole(user: UserWithPerms | undefined | null): boolean {
  return !!user?.customRole && user.customRole.isActive !== false;
}

/**
 * Можно ли действие — зеркало backend roleAllows (auth/role-utils.ts):
 * основатель — всегда; сотрудник с ролью — только по галочке роли (любой
 * из перечисленных); без роли — по правилу его должности `base`, как было.
 * Каталог галочек — backend/src/auth/permissions.ts.
 */
export function roleCan(user: UserWithPerms | undefined | null, key: string | string[], base = true): boolean {
  if (!user) return false;
  if (isFounder(user as any)) return true;
  if (hasActiveRole(user)) return hasPermission(user, ...(Array.isArray(key) ? key : [key]));
  return base;
}

export type VisibilityKey =
  | 'visibility:client-money'
  | 'visibility:company-money'
  | 'visibility:staff-pay'
  | 'visibility:staff-personal';

/**
 * «Видимость данных» роли: без пункта сервер присылает данные скрытыми
 * (суммы null, телефоны с маской), здесь — чтобы не рисовать лишнего.
 * Сотрудник без роли видит всё, как раньше.
 */
export function canSeeData(user: UserWithPerms | undefined | null, key: VisibilityKey): boolean {
  if (!user) return false;
  if (isFounder(user as any) || !hasActiveRole(user)) return true;
  return hasPermission(user, key);
}

/** «••••» вместо скрытой суммы (сервер прислал null и moneyHidden). */
export const HIDDEN_MONEY = '•••• TJS';

/** Скрытая сумма в своей валюте: «•••• USD». */
export function hiddenAmount(currency?: string | null): string {
  return `•••• ${currency || 'TJS'}`;
}

/** Ключи «все, не только свои» — зеркало backend/src/auth/client-access.ts. */
export const PERMISSION_KEYS = {
  studentsAll: 'students:all',
  applicationsAll: 'applications:all',
  leadsAll: 'leads:all',
} as const;

/**
 * «Все, не только свои» — студенты / заявки / лиды. Зеркало
 * backend/src/auth/client-access.ts и applications/application-access.ts.
 *
 * Обычно менеджер видит и ведёт только тех, где он назначен менеджером.
 * Всех — руководство, а ещё те, чья действующая роль (своя или роль
 * должности, user.customRole из /auth/me) отмечает эти пункты. Лид — заявка
 * в статусе «Новый лид». Удаление и назначение менеджера этим не открываются.
 */
export type ClientScope = 'students' | 'applications' | 'leads';

export const SEE_ALL_PERMISSION: Record<ClientScope, string> = {
  students: PERMISSION_KEYS.studentsAll,
  applications: PERMISSION_KEYS.applicationsAll,
  leads: PERMISSION_KEYS.leadsAll,
};

type AccessUser = UserWithPerms & { id?: string };

function customRoleActive(user: AccessUser): boolean {
  return !!user.customRole && user.customRole.isActive !== false;
}

/** Выданы ли «все» этой области действующей ролью (руководство здесь не учитывается). */
export function hasSeeAllGrant(user: AccessUser | null | undefined, scope: ClientScope): boolean {
  if (!user) return false;
  return customRoleActive(user) && hasPermission(user, SEE_ALL_PERMISSION[scope]);
}

/**
 * Видит ли пользователь ВСЕ заявки по роли — как backend canSeeAllApplications:
 * основатель; под кастомной ролью — с «Заявки — назначение менеджера»; иначе
 * админ/бухгалтер. Только так можно удалять и возвращать чужие заявки.
 */
export function canSeeAllApplicationsByRole(user: AccessUser | null | undefined): boolean {
  if (!user) return false;
  if (isFounder(user as any)) return true;
  if (customRoleActive(user)) return hasPermission(user, 'applications:assign');
  return isElevated(user as any);
}

/**
 * Видит и ведёт всех: студентов / заявки (кроме лидов) / лиды. Лиды —
 * ещё и с «Лиды — назначение менеджера»: раздать лиды, видя только свои,
 * нельзя (backend canSeeAllLeads).
 */
export function canSeeAllClients(user: AccessUser | null | undefined, scope: ClientScope): boolean {
  if (!user) return false;
  if (scope === 'students') return isElevated(user as any) || hasSeeAllGrant(user, 'students');
  if (scope === 'leads' && customRoleActive(user) && hasPermission(user, 'leads:assign')) return true;
  return canSeeAllApplicationsByRole(user) || hasSeeAllGrant(user, scope);
}

/**
 * Право роли на действие с записью: пока она лид — «Лиды — …», дальше —
 * «Заявки — …» (backend applicationRightKey). Основатель и сотрудники без
 * роли — true: их ведут прежние правила.
 */
export function applicationRight(
  user: AccessUser | null | undefined,
  status: string | null | undefined,
  action: 'read' | 'update' | 'delete' | 'assign',
): boolean {
  return roleCan(user, `${isLeadStatus(status) ? 'leads' : 'applications'}:${action}`);
}

/** Лид — заявка в статусе «Новый лид» (NEW_LEAD; NEW — старое значение). */
export function isLeadStatus(status?: string | null): boolean {
  return status === 'NEW_LEAD' || status === 'NEW';
}

/** «Все» того вида, к которому относится заявка с этим статусом. */
export function canSeeAllOfApplication(user: AccessUser | null | undefined, status?: string | null): boolean {
  return canSeeAllClients(user, isLeadStatus(status) ? 'leads' : 'applications');
}


/**
 * Видит все группы и учеников академии — зеркало backend academy-access.ts
 * isAcademyManager: основатель, админ по должности; роль — «Все группы и
 * ученики, не только свои».
 */
export function isAcademyManager(user: AccessUser | null | undefined): boolean {
  if (!user) return false;
  if (isFounder(user as any)) return true;
  if (customRoleActive(user)) return hasPermission(user, 'academy:all');
  return hasRole(user as any, 'ADMIN');
}

/** Действие руководства академии: основатель, админ по должности; роль — её галочка. */
export function academyCan(user: AccessUser | null | undefined, key: string): boolean {
  if (!user) return false;
  if (isFounder(user as any)) return true;
  if (customRoleActive(user)) return hasPermission(user, key);
  return hasRole(user as any, 'ADMIN');
}
