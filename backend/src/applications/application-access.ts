import { ApplicationStatus, Prisma } from '@prisma/client';
import { hasPermission, isElevated, isFounder, isStaff, roleAllows, UserWithRoles } from '../auth/role-utils';
import { hasSeeAllGrant } from '../auth/client-access';
import { NEW_LEAD_APPLICATION_STATUSES } from '../common/application-status';

/**
 * Гейты доступа к операциям над заявками, ЕДИНЫЕ для контроллера и сервиса.
 *
 * Зачем отдельный модуль, а не isElevated()/RolesGuard:
 *
 * 1. RolesGuard на ApplicationsController исторически не висел вообще
 *    (глобально зарегистрирован только UserThrottlerGuard, см. app.module.ts),
 *    поэтому единственной реальной авторизацией были ручные проверки внутри
 *    сервиса. Новые эндпоинты закрыты и гвардом, и проверкой здесь.
 *
 * 2. Неявная проверка в RolesGuard (permissionsForRequest) матчит ЛЮБОЙ
 *    write-пермишен раздела по префиксу URL: у 'applications' это
 *    create | update | delete | assign с одним и тем же prefix
 *    '/applications'. То есть роль с одним лишь «Заявки — удаление» прошла
 *    бы гвард на POST-создание. Требование «без applications:create эндпоинт
 *    обязан отказать» этим гвардом в одиночку НЕ выполняется — отсюда явная
 *    проверка ключа здесь, вторым рубежом.
 *
 * 3. isElevated() читает только user.role/user.roles[] и слеп к
 *    hasCustomRole. Для носителя кастомной роли base role — техническая
 *    «подложка» (RolesGuard.skipBaseRole), она не даёт прав ни на одной
 *    поверхности. Поэтому для таких юзеров решает ТОЛЬКО пермишен —
 *    тот же fail-closed принцип, что уже применён в
 *    canSeePartnerAttribution (auth/role-utils.ts).
 */

/**
 * Может ли пользователь завести заявку руками из CRM
 * (POST /applications/staff).
 *
 *  • FOUNDER — неявно всё.
 *  • Кастомная роль (например «Квалификатор лидов») — только по ЯВНОМУ
 *    'applications:create'. Никакие другие applications:* сюда не пускают.
 *  • Базовые роли — сотрудники продаж и админ-зона: они и раньше заводили
 *    клиентов руками через POST /students.
 *
 * Публичный эндпоинт лендинга (POST /applications/public) этой проверки
 * не касается и остаётся анонимным.
 */
export function canCreateApplication(user: UserWithRoles | undefined | null): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  // Ручной ввод создаёт ЛИД (статус «Новый лид») — с 19.10.2026 это своё
  // право «Лиды — создание»; «Заявки — создание» — заявка студенту.
  if (user.hasCustomRole) return hasPermission(user, 'leads:create');
  return isStaff(user);
}

/**
 * Может ли пользователь ВООБЩЕ трогать назначение менеджера
 * (PATCH /applications/:id/manager).
 *
 * Для кастомной роли — только по явному 'applications:assign'. Для базовых
 * ролей поведение прежнее: любой сотрудник доходит до эндпоинта, а объём
 * его прав внутри решает canReassignApplicationManager ниже.
 */
export function canTouchApplicationManager(user: UserWithRoles | undefined | null): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  // Лидам и заявкам менеджера назначают разные права; какое нужно этой
  // записи — проверяет roleAllowsApplication(…, 'assign') в сервисе.
  if (user.hasCustomRole) return hasPermission(user, 'leads:assign', 'applications:assign');
  return isStaff(user);
}

/**
 * Может ли пользователь назначить лид ЛЮБОМУ сотруднику (а не только взять
 * себе / снять с себя).
 *
 * Раньше здесь стоял голый isElevated(user), и это ломало ровно тот сценарий,
 * ради которого экран /leads и делается: квалификатор с
 * 'applications:assign', но с технической подложкой SALES_MANAGER, попадал
 * в ветку «не-elevated» и мог взять лид только на себя — то есть не мог
 * распределить ни одного лида. Пермишен «Заявки — назначение менеджера»
 * при этом не значил ничего.
 *
 * Правило теперь: активная кастомная роль решает по пермишену, базовые
 * роли — по-прежнему по isElevated (ТЗ §7: переназначение между
 * сотрудниками — только ADMIN/ACCOUNTANT/FOUNDER).
 */
export function canReassignApplicationManager(
  user: UserWithRoles | undefined | null,
  status?: ApplicationStatus | string | null,
): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  if (user.hasCustomRole) {
    return status
      ? hasPermission(user, applicationRightKey(status, 'assign'))
      : hasPermission(user, 'leads:assign', 'applications:assign');
  }
  return isElevated(user);
}

/**
 * Видит ли пользователь ВЕСЬ раздел заявок, а не только назначенные на него.
 *
 * Базовые роли — как раньше: FOUNDER/ADMIN/ACCOUNTANT видят всё,
 * SALES_MANAGER/CLIENT_MANAGER — только свои (isElevated в findAll).
 *
 * Для активной кастомной роли база слепа (см. шапку файла), поэтому решает
 * пермишен, и ровно один — 'applications:assign'. Почему именно он:
 * распределять лиды между сотрудниками, видя только назначенные на себя,
 * физически невозможно, а лид, заведённый вручную, специально создаётся
 * БЕЗ менеджера — то есть весь экран /leads у квалификатора был бы пустым.
 * 'applications:read'/'create' сюда НЕ засчитываются намеренно: это не
 * расширяет видимость уже существующим кастомным ролям (SMM, таргетолог),
 * которым раздел открыт для их собственных строк.
 */
export function canSeeAllApplications(user: UserWithRoles | undefined | null): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  if (user.hasCustomRole) return hasPermission(user, 'applications:assign');
  return isElevated(user);
}

/**
 * «Все лиды» / «Все заявки» (auth/client-access.ts) — поверх правила выше.
 * Лид — заявка в статусе «Новый лид» (NEW_LEAD; NEW — легаси-хвост), всё
 * остальное — заявка. Ушёл лид дальше по статусу — к нему применяется доступ
 * «все заявки».
 *
 * canSeeAllApplications() сам по себе НЕ меняется: на нём держатся комната
 * сокета 'apps-all' и адресаты уведомлений, а ещё право удалять чужие заявки
 * (applications.service ensureCanDelete) — «все» удаления не дают.
 */
export function isLeadStatus(status: ApplicationStatus | string | null | undefined): boolean {
  return !!status && (NEW_LEAD_APPLICATION_STATUSES as string[]).includes(status);
}

/**
 * Комната сокета для чужих заявок этого вида (realtime.gateway): туда входят
 * те, кому выданы «все лиды» / «все заявки». Руководство — в 'apps-all'.
 */
export function clientRoomForStatus(status: ApplicationStatus | string | null | undefined): 'leads-all' | 'applications-all' {
  return isLeadStatus(status) ? 'leads-all' : 'applications-all';
}

/**
 * Видит и ведёт все лиды, а не только свои. «Лиды — назначение менеджера»
 * тоже открывает все: раздать лиды, видя только свои, невозможно (ручной
 * лид создаётся без менеджера).
 */
export function canSeeAllLeads(user: UserWithRoles | undefined | null): boolean {
  return canSeeAllApplications(user) || hasSeeAllGrant(user, 'leads')
    || (!!user?.hasCustomRole && hasPermission(user, 'leads:assign'));
}

/** Видит и ведёт все заявки (кроме лидов), а не только свои. */
export function canSeeAllNonLeadApplications(user: UserWithRoles | undefined | null): boolean {
  return canSeeAllApplications(user) || hasSeeAllGrant(user, 'applications');
}

/**
 * Открыть и вести эту заявку: своя (менеджер TJ или CN) или «все» её вида.
 * Сотруднику с ролью ещё нужен просмотр её вида: лид — «Лиды — просмотр»,
 * заявка — «Заявки — просмотр».
 */
export function canAccessApplication(
  user: (UserWithRoles & { id: string }) | undefined | null,
  app: { managerId: string | null; chinaManagerId?: string | null; status: ApplicationStatus | string },
): boolean {
  if (!user) return false;
  if (!roleAllowsApplication(user, app.status, 'read')) return false;
  if (app.managerId === user.id || app.chinaManagerId === user.id) return true;
  return isLeadStatus(app.status) ? canSeeAllLeads(user) : canSeeAllNonLeadApplications(user);
}

export type ApplicationAction = 'read' | 'update' | 'delete' | 'assign';

/**
 * Корзина: что можно вернуть. Сотрудник без роли — как раньше (руководство
 * — все, остальные — свои). Роли — свои и чужие того вида, где у неё есть
 * назначение менеджера, и только вида, который она может удалять.
 */
export function applicationTrashWhere(user: UserWithRoles & { id: string }): Prisma.ApplicationWhereInput | null {
  const own: Prisma.ApplicationWhereInput = { OR: [{ managerId: user.id }, { chinaManagerId: user.id }] };
  if (!user.hasCustomRole || isFounder(user)) return canSeeAllApplications(user) ? null : own;
  const kinds: Prisma.ApplicationWhereInput[] = [];
  for (const lead of [true, false]) {
    const status = lead ? { in: NEW_LEAD_APPLICATION_STATUSES } : { notIn: NEW_LEAD_APPLICATION_STATUSES };
    const prefix = lead ? 'leads' : 'applications';
    if (!hasPermission(user, `${prefix}:delete`)) continue;
    kinds.push(hasPermission(user, `${prefix}:assign`) ? { status } : { AND: [{ status }, own] });
  }
  return kinds.length ? { OR: kinds } : { id: '__none__' };
}

/** Право роли на действие с записью: пока она лид — «Лиды — …», дальше — «Заявки — …». */
export function applicationRightKey(
  status: ApplicationStatus | string | null | undefined,
  action: ApplicationAction,
): string {
  return `${isLeadStatus(status) ? 'leads' : 'applications'}:${action}`;
}

/** Есть ли у роли право на действие с записью этого статуса (основателя и должности не касается). */
export function roleAllowsApplication(
  user: UserWithRoles | undefined | null,
  status: ApplicationStatus | string | null | undefined,
  action: ApplicationAction,
): boolean {
  return roleAllows(user, applicationRightKey(status, action));
}

/**
 * Какие записи вообще открыты роли: только лиды («Лиды — просмотр»), только
 * заявки («Заявки — просмотр») или всё. null — без ограничения (основатель,
 * сотрудник без роли, роль с обоими правами).
 */
export function applicationKindWhere(user: UserWithRoles | undefined | null): Prisma.ApplicationWhereInput | null {
  if (!user?.hasCustomRole || isFounder(user)) return null;
  const leads = hasPermission(user, 'leads:read');
  const apps = hasPermission(user, 'applications:read');
  if (leads && apps) return null;
  if (leads) return { status: { in: NEW_LEAD_APPLICATION_STATUSES } };
  if (apps) return { status: { notIn: NEW_LEAD_APPLICATION_STATUSES } };
  return { id: '__none__' };
}

/**
 * Условие видимости заявок для списков и счётчиков; null — видны все.
 * Свои — всегда; «все лиды» добавляют чужие лиды, «все заявки» — чужие
 * заявки остальных статусов.
 */
export function applicationVisibilityWhere(
  user: UserWithRoles & { id: string },
): Prisma.ApplicationWhereInput | null {
  const kind = applicationKindWhere(user);
  const leads = canSeeAllLeads(user);
  const apps = canSeeAllNonLeadApplications(user);
  if (leads && apps) return kind;
  const or: Prisma.ApplicationWhereInput[] = [{ managerId: user.id }, { chinaManagerId: user.id }];
  if (leads) or.push({ status: { in: NEW_LEAD_APPLICATION_STATUSES } });
  if (apps) or.push({ status: { notIn: NEW_LEAD_APPLICATION_STATUSES } });
  return kind ? { AND: [{ OR: or }, kind] } : { OR: or };
}
