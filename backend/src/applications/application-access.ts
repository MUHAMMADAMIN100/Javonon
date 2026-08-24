import { hasPermission, isElevated, isFounder, isStaff, UserWithRoles } from '../auth/role-utils';

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
  if (user.hasCustomRole) return hasPermission(user, 'applications:create');
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
  if (user.hasCustomRole) return hasPermission(user, 'applications:assign');
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
export function canReassignApplicationManager(user: UserWithRoles | undefined | null): boolean {
  if (!user) return false;
  if (isFounder(user)) return true;
  if (user.hasCustomRole) return hasPermission(user, 'applications:assign');
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
