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
  // Пермиссии из CustomRole. Заполняются JwtStrategy при validate.
  permissions?: string[] | null;
  // true, если у юзера привязана АКТИВНАЯ CustomRole (ставит JwtStrategy).
  // Означает: base role в БД — техническая «подложка», она НЕ даёт прав
  // сама по себе (см. RolesGuard.skipBaseRole).
  hasCustomRole?: boolean;
};

/** Проверка наличия пермиссии у юзера (через CustomRole). */
export function hasPermission(user: UserWithRoles | undefined | null, ...required: string[]): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;  // FOUNDER — неявно всё
  const list = user.permissions || [];
  if (list.length === 0) return false;
  return required.some((p) => list.includes(p));
}

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

/**
 * Единственный канонический гейт на блок «Партнёр» (partnerAttribution:
 * ФИО партнёра, referralCode, referralUrl, сумма и дата комиссии).
 * Используется в students/applications/submissions — НЕ вызывать здесь
 * isElevated() напрямую.
 *
 * Почему отдельный хелпер, а не isElevated():
 * isElevated() читает только user.role/user.roles[] и ничего не знает про
 * активную кастомную роль. А RolesGuard (roles.guard.ts, skipBaseRole)
 * устанавливает противоположное правило: активная CustomRole ЗАМЕНЯЕТ
 * базовую роль для целей авторизации — base role в БД это «подложка»,
 * она не даёт доступа. Без учёта этого флага «Таргетолог»/«SMM» с
 * подложкой ADMIN/ACCOUNTANT проходил бы isElevated() и вычитывал
 * партнёрский блок из JSON, хотя на всех остальных поверхностях
 * авторизации его база не даёт ровно ничего. Эндпоинты
 * GET /students/:id и GET /applications/:id висят под одним лишь
 * JwtAuthGuard (RolesGuard не глобальный), так что промежуточного
 * рубежа там нет — гейт здесь и есть единственный.
 *
 * Fail-closed: носителю кастомной роли партнёрские данные видны только
 * по ЯВНОМУ гранту 'partners:read' в CustomRole.permissions.
 *
 * Ровно одно задокументированное исключение — превью формы создания сделки,
 * см. canPreviewDealFormPartner ниже. Оно тоже fail-closed для кастомных
 * ролей и НЕ является поводом заводить новые послабления.
 */
export function canSeePartnerAttribution(
  user: UserWithRoles | undefined | null,
): boolean {
  if (!user) return false;
  if (isFounder(user)) return true; // FOUNDER — неявно всё
  if (user.hasCustomRole) return hasPermission(user, 'partners:read');
  return isElevated(user);
}

/** Любой менеджер по продажам или клиентский менеджер. */
export function isManager(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'SALES_MANAGER', 'CLIENT_MANAGER');
}

/**
 * ЕДИНСТВЕННОЕ исключение из canSeePartnerAttribution — превью формы создания
 * сделки (GET /submissions/partner-preview, SubmissionsService.
 * previewPartnerForClient). Больше нигде не применять: на любой другой
 * поверхности гейт — canSeePartnerAttribution.
 *
 * Почему исключение вообще есть: связь клиента с партнёром проставляет
 * СЕРВЕР, и менеджер, который прямо сейчас вводит номер, обязан видеть, что
 * именно система нашла, — иначе решение «партнёру заплатят» принимается
 * невидимо для единственного человека, способного заметить ошибку. Поэтому
 * SALES_MANAGER/CLIENT_MANAGER сюда допущены, хотя во всех остальных местах
 * партнёрский блок им закрыт. Ответ при этом сужен до трёх полей по одному
 * вводимому клиенту (см. previewPartnerForClient).
 *
 * Почему носитель кастомной роли — НЕТ:
 * исключение выдано базовым ролям продаж, а не «всем, кто прошёл RolesGuard».
 * У носителя активной CustomRole base role — техническая «подложка»
 * (RolesGuard.skipBaseRole), она не даёт прав ни на одной поверхности, и
 * @Roles(...) на этом эндпоинте его НЕ останавливает: implicit-проверка в
 * RolesGuard матчит любой submissions:* по префиксу '/submissions', а на GET
 * проходит и read-only submissions:read. То есть роль вида «Таргетолог»/«SMM»
 * с одним лишь «Продажи — просмотр» дошла бы до превью, не имея при этом
 * права создать сделку (POST /submissions её отсекает — read-only пермиссия
 * на write не засчитывается). Обоснование исключения — «показываем тому, кто
 * эту связь своим действием и создаёт» — на неё не распространяется.
 * Fail-closed: кастомной роли партнёрские данные видны только по ЯВНОМУ
 * гранту 'partners:read', то есть через canSeePartnerAttribution ниже.
 */
export function canPreviewDealFormPartner(
  user: UserWithRoles | undefined | null,
): boolean {
  if (!user) return false;
  // FOUNDER/ADMIN/ACCOUNTANT, а также кастомная роль с явным partners:read.
  if (canSeePartnerAttribution(user)) return true;
  // Кастомная роль без partners:read — стоп (см. блок выше).
  if (user.hasCustomRole) return false;
  return isManager(user);
}

/** Любой сотрудник компании (кроме студентов/партнёров). */
export function isStaff(user: UserWithRoles | undefined | null): boolean {
  return hasRole(user, 'FOUNDER', 'ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER');
}
