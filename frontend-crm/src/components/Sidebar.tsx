import { useChatUnreadTotal } from '../lib/chatUnread';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
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
 * Меню CRM.
 *
 * Компьютер (> 900px) — как до редизайна (решение заказчика 10.11.2026), в
 * новом оформлении: слева узкая полоса значков групп, справа от неё поверх
 * страницы выезжает панель с пунктами группы. Открывают её наведение мыши,
 * нажатие на значок, фокус с клавиатуры и касание (планшет). Закрывают уход
 * мыши с меню, выбор пункта, Escape и касание мимо меню. Закрепления нет.
 * Внизу полосы — аватар с меню пользователя.
 *
 * Телефон (≤ 900px) — нижняя панель из четырёх главных разделов + «Ещё»;
 * «Ещё» открывает все разделы плитками и меню пользователя.
 *
 * Что показывать — только navGroups.ts.
 */

// Подогрев данных раздела при наведении/касании — экран открывается сразу.
const PREFETCH_MAP: Record<string, () => Promise<void> | void> = {
  '/chat': () => {
    queryClient.prefetchQuery({ queryKey: keys.chat.rooms(), queryFn: () => listChatRooms() });
    queryClient.prefetchQuery({ queryKey: keys.chat.unread(), queryFn: () => chatUnread() });
  },
  '/leads': () => {
    // Первая страница «Всех» без фильтров — тот же ключ, что у pages/Leads.tsx.
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
    // Журнал открывается за текущий месяц — греем ровно его.
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
/** Наведение на значок группы — греем все её разделы сразу. */
const prefetchGroup = (g: VisibleGroup) => g.items.forEach((i) => prefetchRoute(i.to));

/**
 * Брейкпоинт «телефон/планшет». В CSS ему соответствуют
 * `@media (max-width: 900px)` и ровно обратный `not all and (max-width: 900px)`
 * (не «min-width: 901px»: при дробной ширине окна не сработал бы ни один).
 */
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

/** Пауза перед закрытием: по дороге от значка к панели курсор на миг выходит из меню. */
const PANEL_CLOSE_DELAY_MS = 200;

/** Разделы нижней панели телефона — первые четыре доступных из этого списка. */
const TAB_PRIORITY = ['/dashboard', '/leads', '/submissions', '/finance', '/students', '/tasks', '/groups', '/schedule', '/academy/students', '/chat', '/workday'];

export default function Sidebar() {
  const user = useAuth((s) => s.user);
  const hydrated = useAuth((s) => s.hydrated);
  const logout = useAuth((s) => s.logout);
  const { t } = useT();
  const loc = useLocation();
  const isMobile = useMediaQuery(MOBILE_MQ);
  const reduceMotion = useReducedMotion();
  const chatBadge = useChatUnreadTotal();
  const [moreOpen, setMoreOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);

  const groups = useMemo(() => (hydrated ? visibleGroups(buildNavCtx(user)) : []), [hydrated, user]);
  const hit = resolveRoute(loc.pathname);
  const activeGroupKey = hit && groups.some((g) => g.key === hit.groupKey) ? hit.groupKey : null;

  const badgeFor = (to: string) => (to === '/chat' ? chatBadge.count : 0);
  const mentionFor = (to: string) => to === '/chat' && chatBadge.mention;
  const groupBadge = (g: VisibleGroup) => g.items.reduce((s, it) => s + badgeFor(it.to), 0);
  const groupMention = (g: VisibleGroup) => g.items.some((it) => mentionFor(it.to));
  const badgeText = (n: number, mention = false) => (mention ? '@' : n > 99 ? '99+' : String(n));
  const isActive = (to: string) => hit?.to === to || loc.pathname === to;
  // Вкладка телефона горит и на вложенных страницах раздела (/finance → /finance/settings).
  const tabActive = (to: string) => isActive(to) || loc.pathname.startsWith(to + '/');
  const initials = user?.fullName?.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

  // ═════════ Компьютер: раскрытая группа и всё, что её открывает/закрывает ═════════
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Roving tabindex: у полосы одна остановка Tab, между значками ходят ↑/↓,
  // а Tab со значка ведёт прямо в пункты его панели.
  const [railFocusKey, setRailFocusKey] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  useEffect(() => cancelClose, [cancelClose]);
  const railRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const regionRef = useRef<HTMLDivElement | null>(null);
  const panelNavRef = useRef<HTMLElement | null>(null);
  // Escape возвращает фокус на значок; этот focus() не должен снова открыть
  // панель. Событие фокуса может прийти и не сразу (окно браузера не в
  // фокусе), поэтому метка живёт, пока его не дождётся, но не дольше 300 мс.
  const suppressFocusOpen = useRef<string | null>(null);
  // Тип указателя последнего касания меню. После тапа пальцем Chrome шлёт
  // mouseleave — закрывать по уходу курсора можно только мышиное открытие.
  const lastPointerType = useRef<string>('mouse');

  const isKnownGroup = (key: string | null) => !!key && groups.some((g) => g.key === key);
  const visibleKey = isKnownGroup(openKey) ? openKey : null;
  const panelGroup = visibleKey ? groups.find((g) => g.key === visibleKey) : undefined;
  const railTabKey = (isKnownGroup(railFocusKey) ? railFocusKey : null) ?? activeGroupKey ?? groups[0]?.key ?? null;

  // Панель может ещё дорисовываться (или доигрывать закрытие после Escape) —
  // пробуем несколько кадров, пока первый пункт действительно не получит фокус.
  const focusPanelFirstItem = useCallback(() => {
    let tries = 0;
    const step = () => {
      const a = panelNavRef.current?.querySelector<HTMLAnchorElement>('a');
      if (a?.isConnected) {
        a.focus({ preventScroll: true });
        if (document.activeElement === a) return;
      }
      if (++tries < 20) requestAnimationFrame(step);
    };
    step();
  }, []);

  // Escape закрывает панель, открытую и мышью (фокус тогда на странице), и
  // клавиатурой. Слушаем document: при открытии наведением фокус не в меню.
  useEffect(() => {
    if (!visibleKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      cancelClose();
      setOpenKey(null);
      // Фокус возвращаем на значок, только если он и был в меню — из поля
      // ввода на странице его не выдёргиваем.
      const region = regionRef.current;
      const active = document.activeElement;
      if (!region || !(active instanceof Node) || !region.contains(active)) return;
      setRailFocusKey(visibleKey);
      const btn = railRefs.current[visibleKey];
      if (!btn || document.activeElement === btn) return;
      suppressFocusOpen.current = visibleKey;
      setTimeout(() => { suppressFocusOpen.current = null; }, 300);
      btn.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visibleKey, cancelClose]);

  // Касание мимо меню закрывает панель (палец не шлёт mouseleave).
  useEffect(() => {
    if (!visibleKey) return;
    const onDown = (e: PointerEvent) => {
      const region = regionRef.current;
      if (region && e.target instanceof Node && region.contains(e.target)) return;
      cancelClose();
      setOpenKey(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [visibleKey, cancelClose]);

  // Любой переход на другую страницу закрывает панель и «Ещё».
  useEffect(() => {
    cancelClose();
    setOpenKey(null);
    setMoreOpen(false);
  }, [loc.pathname, cancelClose]);

  // Перешли на телефонную ширину — раскрытая группа не должна «ожить» потом.
  useEffect(() => {
    if (!isMobile) return;
    cancelClose();
    setOpenKey(null);
  }, [isMobile, cancelClose]);

  // После перехода остановкой Tab становится значок текущего раздела.
  useEffect(() => { setRailFocusKey(activeGroupKey); }, [activeGroupKey]);

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
  const brand = (
    <div className="sidebar-logo" title="Javonon">
      <span className="rail-brand-mark" aria-hidden="true">J</span>
      <span className="sr-only">Javonon</span>
    </div>
  );

  // Профиль ещё не загружен (сервер просыпается) — меню по неполным правам не
  // строим: основатель на миг увидел бы меню менеджера. Выход доступен.
  if (!hydrated) {
    if (isMobile) return null;
    return (
      <aside className="sidebar sidebar-2l" data-testid="nav-sidebar">
        {brand}
        <div className="sidebar-split" aria-busy="true" aria-label={t('common.loading')}>
          <div className="sidebar-rail">
            {Array.from({ length: 7 }).map((_, i) => <div key={i} className="rail-skeleton" />)}
          </div>
        </div>
        <div className="sidebar-foot rail-foot user-menu-foot">
          <button className="logout-btn" onClick={logout} title={t('auth.logout')} aria-label={t('auth.logout')}>
            <Icon name="logout" size={20} />
          </button>
        </div>
      </aside>
    );
  }

  // ───────────── Телефон ─────────────
  if (isMobile) {
    const all: NavItem[] = groups.flatMap((g) => g.items);
    const tabs = TAB_PRIORITY.map((to) => all.find((i) => i.to === to)).filter((x): x is NavItem => !!x).slice(0, 4);
    const tabTos = new Set(tabs.map((x) => x.to));
    const moreActive = !!hit && !tabs.some((x) => tabActive(x.to));
    // Непрочитанное в чате, если чата нет среди вкладок, — на «Ещё».
    const moreBadge = tabTos.has('/chat') ? 0 : chatBadge.count;
    return (
      <>
        <nav className="mobile-tabbar" aria-label={t('sidebar.menu')} data-testid="mobile-tabbar">
          {tabs.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end
              className={`tab-link${tabActive(it.to) && !moreOpen ? ' active' : ''}`}
              aria-current={tabActive(it.to) ? 'page' : undefined}
              data-testid={`tab-${it.to.slice(1).replace('/', '-')}`}
              {...prefetchProps(it.to)}
            >
              <span className="tab-link-pill"><Icon name={it.icon} size={22} /></span>
              <span className="tab-link-label">{t(it.tabLabelKey ?? it.labelKey)}</span>
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
                <h2 className="more-group-title">{t(g.labelKey)}</h2>
                <div className="more-grid">
                  {g.items.map((it) => (
                    <NavLink
                      key={it.to}
                      to={it.to}
                      end
                      className={`more-tile${isActive(it.to) ? ' active' : ''}`}
                      onClick={() => setMoreOpen(false)}
                      {...prefetchProps(it.to)}
                    >
                      <Icon name={it.icon} size={22} />
                      <span>{t(it.labelKey)}</span>
                      {badgeFor(it.to) > 0 && (
                        <span className={`nav-badge${mentionFor(it.to) ? ' is-mention' : ''}`} data-testid={`nav-badge-${it.to.slice(1)}`}>
                          {badgeText(badgeFor(it.to), mentionFor(it.to))}
                        </span>
                      )}
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

  /** Мышь навелась на значок — панель открывается сразу. Палец/стилус — только нажатием. */
  const hoverGroupOn = (e: React.PointerEvent, g: VisibleGroup) => {
    if (e.pointerType !== 'mouse') return;
    cancelClose();
    setOpenKey(g.key);
    prefetchGroup(g);
  };
  /** Фокус с клавиатуры открывает панель на любом устройстве. */
  const focusGroupOn = (g: VisibleGroup) => {
    if (suppressFocusOpen.current === g.key) {
      suppressFocusOpen.current = null;
      return;
    }
    cancelClose();
    setOpenKey(g.key);
    setRailFocusKey(g.key);
    prefetchGroup(g);
  };
  /** Нажатие на значок только открывает панель (не переходит и не закрепляет). */
  const openGroup = (g: VisibleGroup) => {
    cancelClose();
    prefetchGroup(g);
    setOpenKey(g.key);
  };
  /** Мышь ушла с меню (полоса + панель) — закрываем с короткой паузой. */
  const scheduleClose = () => {
    if (lastPointerType.current !== 'mouse') return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpenKey(null);
    }, PANEL_CLOSE_DELAY_MS);
  };
  /** Выбрали пункт — панель прячется сразу. Ctrl/⌘-клик (новая вкладка) её не трогает. */
  const closeOnPick = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    cancelClose();
    setOpenKey(null);
  };
  const focusRailAt = (idx: number) => {
    if (groups.length === 0) return;
    const g = groups[(idx + groups.length) % groups.length];
    setRailFocusKey(g.key);
    railRefs.current[g.key]?.focus({ preventScroll: true });
  };
  /** ↑/↓/Home/End — между значками, → — в пункты раскрытой панели. */
  const onRailKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, g: VisibleGroup, idx: number) => {
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        cancelClose();
        // Панель рисуем сразу, чтобы фокус встал на первый пункт без задержки.
        flushSync(() => setOpenKey(g.key));
        focusPanelFirstItem();
        return;
      case 'ArrowDown': next = idx + 1; break;
      case 'ArrowUp': next = idx - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = groups.length - 1; break;
      default: return;
    }
    e.preventDefault();
    focusRailAt(next);
  };
  /** В панели: ← — обратно на значок, ↑/↓/Home/End — по пунктам. */
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLElement>, groupKey: string) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setRailFocusKey(groupKey);
      railRefs.current[groupKey]?.focus({ preventScroll: true });
      return;
    }
    const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>('a'));
    const cur = links.indexOf(document.activeElement as HTMLAnchorElement);
    let next: number;
    switch (e.key) {
      case 'ArrowDown': next = cur + 1; break;
      case 'ArrowUp': next = cur - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = links.length - 1; break;
      default: return;
    }
    if (links.length === 0) return;
    e.preventDefault();
    links[(next + links.length) % links.length].focus();
  };

  const itemVariants = { hidden: { opacity: 0, x: -8 }, show: { opacity: 1, x: 0 } };
  const renderItems = (g: VisibleGroup) =>
    g.items.map((it) => {
      const link = (
        <NavLink
          to={it.to}
          end
          onClick={closeOnPick}
          // Пункт подсвечен и на своих алиасах: карточка лида — /applications/:id.
          className={isActive(it.to) ? 'active' : undefined}
          aria-current={isActive(it.to) ? 'page' : undefined}
          {...prefetchProps(it.to)}
        >
          <span className="sidebar-nav-icon"><Icon name={it.icon} size={20} /></span>
          <span>{t(it.labelKey)}</span>
          {badgeFor(it.to) > 0 && (
            <span className={`nav-badge${mentionFor(it.to) ? ' is-mention' : ''}`} data-testid={`nav-badge-${it.to.slice(1)}`}>
              {badgeText(badgeFor(it.to), mentionFor(it.to))}
            </span>
          )}
        </NavLink>
      );
      if (reduceMotion) return <Fragment key={it.to}>{link}</Fragment>;
      return (
        <motion.div key={it.to} variants={itemVariants} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
          {link}
        </motion.div>
      );
    });

  return (
    <aside className="sidebar sidebar-2l" data-testid="nav-sidebar">
      {brand}
      {/* Полоса и панель — одна зона наведения: путь «значок → пункт» не закрывает панель. */}
      <div
        ref={regionRef}
        className="sidebar-split"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onPointerDown={(e) => { lastPointerType.current = e.pointerType; }}
        onPointerMove={(e) => { lastPointerType.current = e.pointerType; }}
        onBlur={(e) => {
          // Фокус ушёл из меню — панель закрывается.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            cancelClose();
            setOpenKey(null);
          }
        }}
      >
        <nav className="sidebar-rail" aria-label={t('sidebar.menu')}>
          {groups.map((g, idx) => (
            <button
              key={g.key}
              ref={(el) => { railRefs.current[g.key] = el; }}
              type="button"
              tabIndex={g.key === railTabKey ? 0 : -1}
              onKeyDown={(e) => onRailKeyDown(e, g, idx)}
              className={`rail-btn${g.key === activeGroupKey ? ' active' : ''}${panelGroup?.key === g.key ? ' is-open' : ''}`}
              onClick={(e) => {
                openGroup(g);
                // detail === 0 — нажали Enter/пробел: сразу в пункты.
                if (e.detail === 0) focusPanelFirstItem();
              }}
              aria-label={t(g.labelKey)}
              aria-current={g.key === activeGroupKey ? 'true' : undefined}
              aria-expanded={panelGroup?.key === g.key}
              aria-haspopup="true"
              aria-controls="sidebar-panel-nav"
              data-testid={`rail-${g.key}`}
              onPointerEnter={(e) => hoverGroupOn(e, g)}
              onFocus={() => focusGroupOn(g)}
              onTouchStart={() => prefetchGroup(g)}
            >
              <Icon name={g.icon} size={22} />
              {groupBadge(g) > 0 && (
                <span className={`rail-badge${groupMention(g) ? ' is-mention' : ''}`} data-testid={`rail-badge-${g.key}`}>
                  {badgeText(groupBadge(g), groupMention(g))}
                </span>
              )}
            </button>
          ))}
        </nav>
        <AnimatePresence initial={false}>
          {panelGroup && (
            <motion.div
              // Ключ один на все группы: при переходе между значками панель не
              // выезжает заново, меняется только содержимое.
              key="sidebar-panel"
              className="sidebar-panel"
              data-testid="sidebar-panel"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -24 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -18 }}
              transition={{ duration: reduceMotion ? 0.001 : 0.24, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="sidebar-panel-title">{t(panelGroup.labelKey)}</div>
              <motion.nav
                key={panelGroup.key}
                ref={panelNavRef}
                id="sidebar-panel-nav"
                className="sidebar-panel-nav"
                aria-label={t(panelGroup.labelKey)}
                onKeyDown={(e) => onPanelKeyDown(e, panelGroup.key)}
                variants={reduceMotion ? undefined : { hidden: {}, show: { transition: { staggerChildren: 0.025, delayChildren: 0.04 } } }}
                initial={reduceMotion ? false : 'hidden'}
                animate={reduceMotion ? { opacity: 1 } : 'show'}
              >
                {renderItems(panelGroup)}
              </motion.nav>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="sidebar-foot rail-foot user-menu-foot">
        <UserMenu variant="rail" {...userMenuProps} />
      </div>
      {pwdModal}
    </aside>
  );
}
