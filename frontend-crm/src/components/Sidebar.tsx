import { useChatUnreadTotal } from '../lib/chatUnread';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../store/auth';
import Icon from '../Icon';
import ChangePasswordModal from './ChangePasswordModal';
import { queryClient } from '../lib/queryClient';
import { keys } from '../lib/queryKeys';
import { listChatRooms, chatUnread } from '../api/chat';
import { listApplicationsPage } from '../api/applications';
import { listStudents, studentStats } from '../api/students';
import { listPrograms } from '../api/programs';
import { listTasks } from '../api/tasks';
import { listUsers } from '../api/users';
import { listCourses } from '../api/lms';
import { financeSummary, loadAllTransactions } from '../api/finance';
import { listSalaries } from '../api/salary';
import { displayRoleLabel } from '../lib/roles';
import { tjMonthRange } from '../lib/tjTime';
import { resolveLandingBaseUrl } from '../lib/landingUrl';
import { useT } from '../lib/i18n';
import UserMenu from './UserMenu';
import { buildNavCtx, visibleGroups, resolveRoute, PROFILE_ITEM, type VisibleGroup, type NavItem } from './navGroups';

/**
 * Меню CRM (редизайн, макет утверждён 09.11.2026).
 *
 * Компьютер (> 900px): боковое меню с подписями и группами. Группы
 * сворачиваются, всё меню — в узкую полосу значков (выбор запоминается в
 * браузере). Внизу — меню пользователя (профиль, база знаний, язык, пароль,
 * выход) и кнопка «Свернуть меню».
 * Телефон (≤ 900px): нижняя панель из четырёх главных разделов + «Ещё»; «Ещё»
 * открывает все разделы плитками и меню пользователя.
 *
 * Что показывать — только navGroups.ts (права перенесены 1:1).
 */

// Подогрев данных раздела при наведении/касании — экран открывается сразу.
const PREFETCH_MAP: Record<string, () => Promise<void> | void> = {
  '/chat': () => {
    queryClient.prefetchQuery({ queryKey: keys.chat.rooms(), queryFn: () => listChatRooms() });
    queryClient.prefetchQuery({ queryKey: keys.chat.unread(), queryFn: () => chatUnread() });
  },
  '/leads': () => {
    const first = { page: 1, pageSize: 25 };
    queryClient.prefetchQuery({ queryKey: keys.applications.list(first), queryFn: () => listApplicationsPage(first) });
  },
  '/students': () => {
    queryClient.prefetchQuery({ queryKey: keys.students.list({ paid: true }), queryFn: () => listStudents({ paid: true }) });
    queryClient.prefetchQuery({ queryKey: keys.students.stats(), queryFn: () => studentStats() });
  },
  '/programs': () => {
    queryClient.prefetchQuery({ queryKey: keys.programs.list(), queryFn: () => listPrograms() });
  },
  '/tasks': () => {
    queryClient.prefetchQuery({ queryKey: keys.tasks.list({}), queryFn: () => listTasks() });
  },
  '/users': () => {
    queryClient.prefetchQuery({ queryKey: keys.users.list(), queryFn: () => listUsers() });
  },
  '/lms': () => {
    queryClient.prefetchQuery({ queryKey: keys.lms.courses(), queryFn: () => listCourses() });
  },
  '/finance': () => {
    queryClient.prefetchQuery({ queryKey: keys.finance.summary({}), queryFn: () => financeSummary() });
    const month = tjMonthRange(0);
    queryClient.prefetchQuery({ queryKey: keys.finance.transactions(month), queryFn: () => loadAllTransactions(month) });
  },
  '/salary': () => {
    queryClient.prefetchQuery({ queryKey: keys.salary.list({}), queryFn: () => listSalaries() });
  },
};
const prefetched = new Set<string>();
const prefetchRoute = (route: string) => {
  if (prefetched.has(route)) return;
  const fn = PREFETCH_MAP[route];
  if (!fn) return;
  prefetched.add(route);
  try { fn(); } catch { /* сеть — не страшно, экран загрузит сам */ }
  setTimeout(() => prefetched.delete(route), 60_000);
};
const prefetchProps = (route: string) => ({
  onMouseEnter: () => prefetchRoute(route),
  onTouchStart: () => prefetchRoute(route),
  onFocus: () => prefetchRoute(route),
});

/** Брейкпоинт «телефон/планшет» — тот же, что в index.css и theme.css. */
const MOBILE_MQ = '(max-width: 900px)';
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Состояние, которое переживает перезагрузку (свёрнутое меню, свёрнутые группы). */
function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* приватный режим */ }
  };
  return [v, set];
}

/** Разделы нижней панели телефона — первые четыре доступных из этого списка. */
const TAB_PRIORITY = ['/dashboard', '/leads', '/submissions', '/finance', '/students', '/tasks', '/groups', '/schedule', '/academy/students', '/chat', '/workday'];

export default function Sidebar() {
  const user = useAuth((s) => s.user);
  const hydrated = useAuth((s) => s.hydrated);
  const logout = useAuth((s) => s.logout);
  const { t } = useT();
  const loc = useLocation();
  const isMobile = useMediaQuery(MOBILE_MQ);
  const chatBadge = useChatUnreadTotal();
  const [collapsed, setCollapsed] = useStored<boolean>('javonon_nav_collapsed', false);
  const [closedGroups, setClosedGroups] = useStored<Record<string, boolean>>('javonon_nav_closed', {});
  const [moreOpen, setMoreOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);

  const groups = useMemo(() => (hydrated ? visibleGroups(buildNavCtx(user)) : []), [hydrated, user]);
  const hit = resolveRoute(loc.pathname);

  // Перешли в другой раздел — «Ещё» закрываем.
  useEffect(() => { setMoreOpen(false); }, [loc.pathname]);
  // «Ещё» открыт — страница под ним не листается, Escape закрывает.
  useEffect(() => {
    if (!moreOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const badgeFor = (to: string) => (to === '/chat' ? chatBadge.count : 0);
  const mentionFor = (to: string) => to === '/chat' && chatBadge.mention;
  const badgeText = (n: number, mention = false) => (mention ? '@' : n > 99 ? '99+' : String(n));
  const isActive = (to: string) => hit?.to === to || loc.pathname === to;
  const initials = user?.fullName?.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

  const userMenuProps = {
    initials,
    fullName: user?.fullName ?? '',
    roleLabel: displayRoleLabel(user as any),
    profileTo: PROFILE_ITEM.to,
    profileLabel: t(PROFILE_ITEM.labelKey),
    profileLinkProps: prefetchProps(PROFILE_ITEM.to),
    knowledgeHref: `${resolveLandingBaseUrl()}/knowledge`,
    onChangePassword: () => setPwdOpen(true),
    onLogout: logout,
  };
  const pwdModal = <ChangePasswordModal open={pwdOpen} mode={{ kind: 'self' }} onClose={() => setPwdOpen(false)} />;

  const badge = (to: string, extraClass = '') =>
    badgeFor(to) > 0 ? (
      <span className={`nav-badge${mentionFor(to) ? ' is-mention' : ''}${extraClass}`} data-testid={`nav-badge-${to.slice(1)}`}>
        {badgeText(badgeFor(to), mentionFor(to))}
      </span>
    ) : null;

  if (!hydrated) {
    return isMobile ? null : <aside className="nav-sidebar" aria-busy="true" aria-label={t('common.loading')} />;
  }

  // ───────────── Телефон ─────────────
  if (isMobile) {
    const all: NavItem[] = groups.flatMap((g) => g.items);
    const tabs = TAB_PRIORITY.map((to) => all.find((i) => i.to === to)).filter((x): x is NavItem => !!x).slice(0, 4);
    const tabTos = new Set(tabs.map((x) => x.to));
    const moreActive = !!hit && !tabTos.has(hit.to);
    // Непрочитанное в чате, если чата нет среди вкладок, — на «Ещё».
    const moreBadge = tabTos.has('/chat') ? 0 : chatBadge.count;
    return (
      <>
        <nav className="mobile-tabbar" aria-label={t('sidebar.menu')} data-testid="mobile-tabbar">
          {tabs.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              className={`tab-link${isActive(it.to) && !moreOpen ? ' active' : ''}`}
              aria-current={isActive(it.to) ? 'page' : undefined}
              data-testid={`tab-${it.to.slice(1).replace('/', '-')}`}
              {...prefetchProps(it.to)}
            >
              <span className="tab-link-pill"><Icon name={it.icon} size={22} /></span>
              <span className="tab-link-label">{t(it.labelKey)}</span>
              {badgeFor(it.to) > 0 && <span className="tab-badge">{badgeText(badgeFor(it.to), mentionFor(it.to))}</span>}
            </NavLink>
          ))}
          <button
            type="button"
            className={`tab-link${moreOpen || moreActive ? ' active' : ''}`}
            aria-expanded={moreOpen}
            aria-controls="more-sheet"
            onClick={() => setMoreOpen((v) => !v)}
            data-testid="tab-more"
          >
            <span className="tab-link-pill"><Icon name={moreOpen ? 'close' : 'menu'} size={22} /></span>
            <span className="tab-link-label">{t('nav.v2.more')}</span>
            {moreBadge > 0 && !moreOpen && <span className="tab-badge">{badgeText(moreBadge, chatBadge.mention)}</span>}
          </button>
        </nav>
        {moreOpen && (
          <div id="more-sheet" className="more-sheet" role="dialog" aria-modal="true" aria-label={t('nav.v2.allSections')} data-testid="more-sheet">
            <div className="more-sheet-head">
              <span className="more-sheet-title">{t('nav.v2.allSections')}</span>
              <button type="button" className="more-sheet-close" onClick={() => setMoreOpen(false)} aria-label={t('common.close')}>
                <Icon name="close" size={22} />
              </button>
            </div>
            <div className="user-menu-foot is-mobile">
              <UserMenu variant="mobile" {...userMenuProps} />
            </div>
            {groups.map((g) => (
              <section key={g.key} data-testid={`more-group-${g.key}`}>
                {g.key !== 'main' && <h2 className="more-group-title">{t(g.labelKey)}</h2>}
                <div className="more-grid">
                  {g.items.map((it) => (
                    <NavLink
                      key={it.to}
                      to={it.to}
                      className={`more-tile${isActive(it.to) ? ' active' : ''}`}
                      onClick={() => setMoreOpen(false)}
                      {...prefetchProps(it.to)}
                    >
                      <Icon name={it.icon} size={22} />
                      <span>{t(it.labelKey)}</span>
                      {badge(it.to)}
                    </NavLink>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        {pwdModal}
      </>
    );
  }

  // ───────────── Компьютер ─────────────
  const mainGroups = groups.filter((g) => g.key !== 'system');
  const systemGroup = groups.find((g) => g.key === 'system');
  const renderLink = (it: NavItem) => (
    <NavLink
      key={it.to}
      to={it.to}
      className={`nav-link${isActive(it.to) ? ' active' : ''}`}
      aria-current={isActive(it.to) ? 'page' : undefined}
      title={collapsed ? t(it.labelKey) : undefined}
      data-testid={`nav-link-${it.to.slice(1).replace('/', '-')}`}
      {...prefetchProps(it.to)}
    >
      <Icon name={it.icon} size={20} />
      <span className="nav-link-label">{t(it.labelKey)}</span>
      {badge(it.to)}
    </NavLink>
  );
  const renderGroup = (g: VisibleGroup) => {
    // Группа с открытым разделом не сворачивается — иначе не видно, где ты.
    const open = collapsed || !closedGroups[g.key] || g.items.some((i) => isActive(i.to));
    const listId = `nav-group-${g.key}-list`;
    return (
      <div key={g.key} className="nav-group" data-testid={`nav-group-${g.key}`}>
        {g.key !== 'main' && (
          <button
            type="button"
            className="nav-group-head"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setClosedGroups({ ...closedGroups, [g.key]: open })}
          >
            <span>{t(g.labelKey)}</span>
            <Icon name="expand_more" size={18} />
          </button>
        )}
        {open && <div id={listId} className="nav-group-list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{g.items.map(renderLink)}</div>}
      </div>
    );
  };

  return (
    <aside className={`nav-sidebar${collapsed ? ' is-collapsed' : ''}`} data-testid="nav-sidebar">
      <div className="nav-brand">
        <span className="nav-brand-mark" aria-hidden="true">J</span>
        <span className="nav-brand-text">
          <span className="nav-brand-name">Javonon</span>
          <span className="nav-brand-sub">{t('nav.v2.brandSub')}</span>
        </span>
      </div>
      <nav className="nav-scroll" aria-label={t('sidebar.menu')}>
        {mainGroups.map(renderGroup)}
      </nav>
      <div className="nav-foot">
        {systemGroup && systemGroup.items.map(renderLink)}
        <button
          type="button"
          className="nav-collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
          aria-pressed={collapsed}
          title={collapsed ? t('nav.v2.expand') : undefined}
          data-testid="nav-collapse"
        >
          <Icon name={collapsed ? 'left_panel_open' : 'left_panel_close'} size={20} />
          <span>{t('nav.v2.collapse')}</span>
        </button>
        <div className="user-menu-foot">
          <UserMenu variant={collapsed ? 'rail' : 'mobile'} {...userMenuProps} />
        </div>
      </div>
      {pwdModal}
    </aside>
  );
}
