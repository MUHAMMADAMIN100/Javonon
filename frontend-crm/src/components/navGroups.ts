import { hasRole, isFounder as isFounderFn } from '../lib/roles';
import { hasPermission } from '../lib/permissions';

/**
 * ЕДИНСТВЕННЫЙ источник правды о структуре навигации CRM.
 *
 * Двухуровневое меню: слева узкий rail с 6 иконками-группами, рядом —
 * панель с пунктами активной группы. Раньше 23 ссылки лежали тремя
 * плоскими массивами прямо в Sidebar.tsx; здесь та же 23-ка разложена
 * по группам, УСЛОВИЯ ВИДИМОСТИ ПЕРЕНЕСЕНЫ 1:1 (никакой пересборки
 * прав «по памяти» — кто что видел, то и видит).
 *
 * Два пункта вне групп и живут в нижнем блоке сайдбара рядом с именем
 * пользователя: «Мой профиль» (/me) и «База знаний» (внешняя ссылка).
 */

/** Контекст ролей/прав — считается ОДИН раз на рендер сайдбара. */
export interface NavCtx {
  /** FOUNDER / ADMIN / ACCOUNTANT */
  elevated: boolean;
  isFounder: boolean;
  /** FOUNDER / ADMIN / SALES_MANAGER / CLIENT_MANAGER (ACCOUNTANT — нет) */
  isWorkforce: boolean;
  hasCustomRole: boolean;
  /** Хотя бы один из перечисленных permission'ов (OR). */
  can: (...perms: string[]) => boolean;
  /**
   * Показывать ли пункт: если у юзера есть custom-роль — решает ТОЛЬКО
   * permission (базовая ролевая проверка подавляется), иначе — ТОЛЬКО
   * базовая роль. Это XOR, а не OR — перенесено дословно из старого
   * Sidebar.tsx.
   *
   * `perms` — один ключ либо массив синонимов (канонический + legacy),
   * любого из них достаточно.
   */
  show: (perms: string | string[], baseCond: boolean) => boolean;
}

export interface NavItem {
  to: string;
  icon: string;
  /** Ключ i18n. Все ключи уже существуют — новых для пунктов не заводим. */
  labelKey: string;
  /**
   * Дополнительные префиксы роутов, которые принадлежат этому пункту
   * (алиасы вроде /time → /workday). Детальные роуты (/students/:id)
   * ловятся автоматически по префиксу `to`.
   */
  aliases?: string[];
  visible: (c: NavCtx) => boolean;
}

export interface NavGroup {
  key: string;
  /** Иконка rail'а. Намеренно НЕ совпадает ни с одной иконкой пункта. */
  icon: string;
  labelKey: string;
  items: NavItem[];
}

const always = () => true;

/** Канонический ключ рассылок + legacy-алиас с дефисом (см. PERMISSION_CATALOG). */
const MASSMAIL_WRITE = ['massmail:write', 'mass-mail:write'];

/** 6 групп, порядок и состав утверждены основателем. */
export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'dashboard',
    icon: 'space_dashboard',
    labelKey: 'nav.group.dashboard',
    items: [
      { to: '/dashboard', icon: 'dashboard', labelKey: 'sidebar.dashboard', visible: always },
      { to: '/kpi', icon: 'leaderboard', labelKey: 'sidebar.kpi', visible: (c) => c.show('kpi:read', c.isWorkforce) },
      { to: '/reports', icon: 'description', labelKey: 'sidebar.reports', visible: (c) => c.show('reports:read', c.isWorkforce) },
    ],
  },
  {
    key: 'sales',
    icon: 'sell',
    labelKey: 'nav.group.sales',
    items: [
      { to: '/applications', icon: 'assignment', labelKey: 'sidebar.applications', visible: (c) => c.show('applications:read', c.isWorkforce) },
      { to: '/students', icon: 'school', labelKey: 'sidebar.students', visible: (c) => c.show('students:read', c.isWorkforce) },
      // «Сделки» — менеджеры оформляют закрытых студентов; FOUNDER одобряет.
      { to: '/submissions', icon: 'handshake', labelKey: 'sidebar.submissions', visible: always },
      { to: '/pipelines', icon: 'route', labelKey: 'sidebar.pipelines', visible: (c) => c.show('pipelines:write', c.elevated) },
      { to: '/partners', icon: 'diversity_3', labelKey: 'sidebar.partners', visible: (c) => c.show('partners:read', c.elevated) },
    ],
  },
  {
    key: 'comms',
    icon: 'chat_bubble',
    labelKey: 'nav.group.comms',
    items: [
      // База-условие здесь буквально `true` — чат доступен и ACCOUNTANT'у.
      { to: '/chat', icon: 'forum', labelKey: 'sidebar.chat', visible: (c) => c.show('chat:read', true) },
      { to: '/inbox', icon: 'inbox', labelKey: 'sidebar.inbox', visible: (c) => c.show('inbox:read', c.isWorkforce) },
      { to: '/calls', icon: 'call', labelKey: 'sidebar.calls', visible: (c) => c.show('calls:read', c.isWorkforce) },
      // В PERMISSION_CATALOG живут ОБА ключа: канонический massmail:write
      // ('Рассылки — редактирование', его и тикают в конструкторе ролей) и
      // legacy mass-mail:write ('Рассылки (устар.)') — оставлен ради старых
      // записей в БД. Backend авторизует и тот и другой, поэтому сайдбар
      // тоже обязан принимать оба, иначе страница недостижима.
      { to: '/massmail', icon: 'campaign', labelKey: 'sidebar.massmail', visible: (c) => c.show(MASSMAIL_WRITE, c.elevated) },
    ],
  },
  {
    key: 'finance',
    icon: 'account_balance_wallet',
    labelKey: 'nav.group.finance',
    items: [
      { to: '/finance', icon: 'payments', labelKey: 'sidebar.finance', visible: (c) => c.show('finance:read', c.elevated) },
      { to: '/salary', icon: 'paid', labelKey: 'sidebar.salary', visible: (c) => c.show('salary:read', c.elevated) },
    ],
  },
  {
    key: 'staff',
    icon: 'groups',
    labelKey: 'nav.group.staff',
    items: [
      // /profile/:id — тот же UserDetail, что и /users/:id (см. App.tsx).
      { to: '/users', icon: 'group', labelKey: 'sidebar.users', aliases: ['/profile'], visible: (c) => c.show('users:read', c.elevated) },
      { to: '/tasks', icon: 'task_alt', labelKey: 'sidebar.tasks', visible: (c) => c.show('tasks:read', c.isWorkforce) },
      // «Время / Посещаемость / Причины» схлопнуты в /workday со вкладками,
      // но старые роуты живы в App.tsx и рендерят тот же Workday.
      { to: '/workday', icon: 'schedule', labelKey: 'sidebar.workday', aliases: ['/time', '/attendance', '/excuses'], visible: always },
      // Аудит-лог — единолично у FOUNDER (Activity.tsx блокирует остальных).
      { to: '/activity', icon: 'history', labelKey: 'sidebar.activity', visible: (c) => c.show('activity:read', c.isFounder) },
    ],
  },
  {
    key: 'settings',
    icon: 'tune',
    labelKey: 'nav.group.settings',
    items: [
      { to: '/programs', icon: 'menu_book', labelKey: 'sidebar.programs', visible: (c) => c.show('programs:read', c.isWorkforce) },
      // Учебный блок: группы и календарь занятий стоят рядом с «Программами»
      // и LMS — это тот же контур обучения, а не продажи и не HR. Условие
      // видимости в стиле соседа-«Программ»: permission у кастомной роли,
      // иначе базовая роль (isWorkforce). Бэкенд пускает к /study-groups весь
      // штат, но не-руководство видит только СВОИ группы (скоуп в сервисе),
      // поэтому пункт безопасно показывать всей рабочей группе.
      { to: '/groups', icon: 'diversity_2', labelKey: 'sidebar.groups', visible: (c) => c.show('groups:read', c.isWorkforce) },
      { to: '/schedule', icon: 'calendar_month', labelKey: 'sidebar.schedule', visible: (c) => c.show('groups:read', c.isWorkforce) },
      { to: '/lms', icon: 'auto_stories', labelKey: 'sidebar.lms', visible: (c) => c.show('lms:read', c.elevated) },
      // Осознанно НЕ через show(): custom-роль не открывает оферты никаким
      // permission'ом — так было и в старом сайдбаре.
      { to: '/offers', icon: 'description', labelKey: 'sidebar.offers', visible: (c) => !c.hasCustomRole && c.elevated },
      { to: '/settings', icon: 'settings', labelKey: 'sidebar.settings', visible: (c) => c.isFounder },
    ],
  },
];

/** Пункт вне групп — рендерится в нижнем блоке сайдбара. */
export const PROFILE_ITEM = { to: '/me', icon: 'person', labelKey: 'sidebar.profile' };

/** Собирает контекст прав из текущего пользователя. */
export function buildNavCtx(user: unknown): NavCtx {
  const elevated = hasRole(user as any, 'FOUNDER', 'ADMIN', 'ACCOUNTANT');
  const isFounder = isFounderFn(user as any);
  const isWorkforce = hasRole(user as any, 'FOUNDER', 'ADMIN', 'SALES_MANAGER', 'CLIENT_MANAGER');
  const hasCustomRole = !!(user as any)?.customRoleId;
  const can = (...perms: string[]) => hasPermission(user as any, ...perms);
  const show = (perms: string | string[], baseCond: boolean) =>
    hasCustomRole ? can(...(Array.isArray(perms) ? perms : [perms])) : baseCond;
  return { elevated, isFounder, isWorkforce, hasCustomRole, can, show };
}

export type VisibleGroup = NavGroup;

/**
 * Группы, в которых остался хотя бы один разрешённый пункт, уже
 * отфильтрованные. Группа без пунктов не рендерится вовсе — мёртвых
 * кнопок в rail'е быть не должно.
 */
export function visibleGroups(ctx: NavCtx): VisibleGroup[] {
  return NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => i.visible(ctx)) }))
    .filter((g) => g.items.length > 0);
}

/** Все префиксы (роут пункта + алиасы), отсортированные по длине убыв. */
const ROUTE_INDEX: Array<{ prefix: string; groupKey: string; to: string }> = NAV_GROUPS
  .flatMap((g) => g.items.flatMap((i) => [i.to, ...(i.aliases || [])].map((prefix) => ({ prefix, groupKey: g.key, to: i.to }))))
  .sort((a, b) => b.prefix.length - a.prefix.length);

const matchesPrefix = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(prefix + '/');

/**
 * Роут → { группа, пункт }. Longest-prefix, поэтому любой новый детальный
 * роут под существующим префиксом (/students/:id/documents и т.п.)
 * подхватывается сам, без правки этого файла.
 * Для /me и неизвестных путей вернёт null.
 */
export function resolveRoute(pathname: string): { groupKey: string; to: string } | null {
  const hit = ROUTE_INDEX.find((r) => matchesPrefix(pathname, r.prefix));
  return hit ? { groupKey: hit.groupKey, to: hit.to } : null;
}

/** Куда вести клик по иконке группы — первый РАЗРЕШЁННЫЙ пункт. */
export function groupHome(g: VisibleGroup): string {
  return g.items[0].to;
}
