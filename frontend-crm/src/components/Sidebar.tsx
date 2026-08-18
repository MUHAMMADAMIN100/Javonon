import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../store/auth';
import Icon from '../Icon';
import ChangePasswordModal from './ChangePasswordModal';
import { queryClient } from '../lib/queryClient';
import { keys } from '../lib/queryKeys';
import { listChatRooms, chatUnread } from '../api/chat';
import { listApplications } from '../api/applications';
import { listStudents, studentStats } from '../api/students';
import { listPrograms } from '../api/programs';
import { listTasks } from '../api/tasks';
import { listUsers } from '../api/users';
import { listCourses } from '../api/lms';
import { financeSummary, listTransactions } from '../api/finance';
import { listSalaries } from '../api/salary';
import { displayRoleLabel } from '../lib/roles';
import { resolveLandingBaseUrl } from '../lib/landingUrl';
import { LangSwitcher, useT } from '../lib/i18n';
import {
  buildNavCtx,
  visibleGroups,
  resolveRoute,
  groupHome,
  PROFILE_ITEM,
  type VisibleGroup,
} from './navGroups';

// Map route → prefetch fn. Срабатывает по hover/touchstart на nav-link
// и грузит данные ДО клика — экран открывается мгновенно с готовым кешем.
const PREFETCH_MAP: Record<string, () => Promise<void> | void> = {
  '/chat': () => {
    queryClient.prefetchQuery({ queryKey: keys.chat.rooms(), queryFn: () => listChatRooms() });
    queryClient.prefetchQuery({ queryKey: keys.chat.unread(), queryFn: () => chatUnread() });
  },
  '/applications': () => {
    queryClient.prefetchQuery({ queryKey: keys.applications.list({}), queryFn: () => listApplications() });
  },
  '/students': () => {
    queryClient.prefetchQuery({ queryKey: keys.students.list({}), queryFn: () => listStudents() });
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
    queryClient.prefetchQuery({ queryKey: keys.finance.transactions({}), queryFn: () => listTransactions() });
  },
  '/salary': () => {
    queryClient.prefetchQuery({ queryKey: keys.salary.list({}), queryFn: () => listSalaries() });
  },
};

// Дедупликация: если этот роут уже префетчили в текущем mount-цикле,
// игнорируем. Защита от spam-hover (mouseenter/mouseleave/mouseenter
// быстро подряд на одном линке создавал десятки запросов до React Query
// дедупа).
const prefetchedRoutes = new Set<string>();
const prefetchRoute = (route: string) => {
  if (prefetchedRoutes.has(route)) return;
  const fn = PREFETCH_MAP[route];
  if (!fn) return;
  prefetchedRoutes.add(route);
  try { fn(); } catch { /* silent */ }
  // Через 60 секунд разрешаем повторный prefetch (на случай если данные
  // могли устареть в кеше).
  setTimeout(() => { prefetchedRoutes.delete(route); }, 60_000);
};

/** Хендлеры префетча — один и тот же набор для пунктов и для иконок групп. */
const prefetchProps = (route: string) => ({
  onMouseEnter: () => prefetchRoute(route),
  onTouchStart: () => prefetchRoute(route),
  onFocus: () => prefetchRoute(route),
});

/**
 * Префетч ВСЕЙ группы, а не только её «домашнего» пункта.
 *
 * В двухуровневом меню в DOM лежат пункты только одной группы, поэтому
 * hover по самим ссылкам покрывал бы 3–5 роутов из 22. Наведение на
 * иконку rail'а — единственный момент, когда мы точно знаем, что
 * пользователь смотрит в сторону этой группы: греем все её роуты сразу.
 * Дёшево: prefetchRoute дедуплицирует и молча выходит для роутов, которых
 * нет в PREFETCH_MAP.
 */
const prefetchGroup = (g: VisibleGroup) => {
  g.items.forEach((i) => prefetchRoute(i.to));
};

/** Тот же брейкпоинт, что и у drawer-правил в index.css (<= 900px). */
const MOBILE_MQ = '(max-width: 900px)';

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_MQ).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export default function Sidebar({ mobileOpen = false, onClose }: SidebarProps = {}) {
  const user = useAuth((s) => s.user);
  const hydrated = useAuth((s) => s.hydrated);
  const logout = useAuth((s) => s.logout);
  const { t } = useT();
  const loc = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [pwdOpen, setPwdOpen] = useState(false);
  const initials = user?.fullName?.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

  // Двухшаговый drawer: 'groups' — 6 крупных кнопок, 'items' — пункты
  // выбранной группы. Держим здесь, а не в Layout, чтобы не менять
  // контракт mobileOpen/onClose.
  const [drawerGroup, setDrawerGroup] = useState<string | null>(null);

  // Десктоп: группа, которую rail показывает в панели «на просмотр» —
  // hover/focus по иконке подменяет содержимое панели БЕЗ навигации.
  // Без этого единственным способом увидеть пункты чужой группы был
  // переход на её первый пункт, т.е. лишняя загрузка страницы на каждый
  // межгрупповой переход.
  const [previewGroupKey, setPreviewGroupKey] = useState<string | null>(null);

  // Группы — только разрешённые, уже отфильтрованные по правам.
  const groups = useMemo(
    () => (hydrated ? visibleGroups(buildNavCtx(user)) : []),
    [hydrated, user],
  );

  // Активная группа выводится ИЗ ТЕКУЩЕГО РОУТА — прямая ссылка или
  // deep-link (/submissions/<id>) подсвечивает нужную иконку и открывает
  // нужную панель. Для /me группы нет — панель показывает первую доступную,
  // ни одна иконка не активна.
  const hit = resolveRoute(loc.pathname);
  const activeGroupKey = hit && groups.some((g) => g.key === hit.groupKey) ? hit.groupKey : null;
  // Просмотр (hover/focus по rail'у) временно перебивает группу роута.
  const previewGroup = previewGroupKey
    ? groups.find((g) => g.key === previewGroupKey)
    : undefined;
  const panelGroup: VisibleGroup | undefined =
    previewGroup || groups.find((g) => g.key === activeGroupKey) || groups[0];

  // После любой навигации панель обязана вернуться к группе текущего
  // роута: мышь может остаться висеть над rail'ом, mouseenter повторно не
  // придёт, и панель залипла бы на чужой группе.
  useEffect(() => {
    setPreviewGroupKey(null);
  }, [loc.pathname]);

  // Открытие drawer'а: если текущий роут принадлежит группе — сразу шаг 2
  // (пользователь скорее всего ходит внутри своего раздела), иначе шаг 1.
  useEffect(() => {
    if (mobileOpen) setDrawerGroup(activeGroupKey);
    // activeGroupKey намеренно вне зависимостей: шаг выбирается один раз
    // на открытие, иначе переход по ссылке дёргал бы drawer обратно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileOpen]);

  const drawerGroupObj = groups.find((g) => g.key === drawerGroup);

  // Bootstrap didn't finish /auth/me (Railway cold-start 5xx / timeout).
  // `user` may hold only a minimal JWT-claims stub — fullName='', no
  // permissions, no customRole, role defaulting to SALES_MANAGER. Computing
  // the menu off that stub silently downgrades a FOUNDER into the
  // SALES_MANAGER menu (loses /settings, /users, /finance, etc.) and
  // renders a custom-role user against the wrong base role. Show a
  // skeleton until the full user lands or logout is chosen — see
  // AuthState.hydrated doc in store/auth.ts.
  if (!hydrated) {
    return (
      <motion.aside
        className={`sidebar sidebar-2l${mobileOpen ? ' mobile-open' : ''}`}
        initial={{ x: -80, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="sidebar-logo">
          <img src="/javonon-logo.svg" alt="Javonon" className="sidebar-brand-img" />
        </div>
        <div className="sidebar-split" aria-busy="true" aria-label={t('common.loading')}>
          <div className="sidebar-rail">
            {Array.from({ length: 6 }).map((_, i) => (
              <motion.div
                key={i}
                className="rail-skeleton"
                animate={{ opacity: [0.35, 0.75, 0.35] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: i * 0.08 }}
              />
            ))}
          </div>
          <div className="sidebar-panel">
            <div className="sidebar-panel-nav">
              {Array.from({ length: 5 }).map((_, i) => (
                <motion.div
                  key={i}
                  className="panel-skeleton"
                  animate={{ opacity: [0.35, 0.75, 0.35] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: i * 0.08 }}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="sidebar-user">
          <div className="user-avatar" style={{ background: 'rgba(255,255,255,0.08)' }} />
          <div className="user-info">
            <motion.div
              animate={{ opacity: [0.35, 0.75, 0.35] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              style={{ height: 12, width: '70%', borderRadius: 4, background: 'rgba(255,255,255,0.1)' }}
            />
            <motion.div
              animate={{ opacity: [0.35, 0.75, 0.35] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
              style={{ marginTop: 6, height: 10, width: '45%', borderRadius: 4, background: 'rgba(255,255,255,0.08)' }}
            />
          </div>
          {/* Logout is still reachable so a user stuck behind a long backend
              outage can bail out — no menu-shape decisions needed for it. */}
          <button
            className="logout-btn"
            onClick={logout}
            title={t('auth.logout')}
          >
            <Icon name="logout" size={20} />
          </button>
        </div>
      </motion.aside>
    );
  }

  /** Наведение/фокус на иконку группы: показываем её пункты в панели и
   *  греем кеш всей группы. Никакой навигации — клик остаётся за
   *  пользователем, и кликнет он уже по нужному пункту. */
  const previewGroupOn = (g: VisibleGroup) => {
    setPreviewGroupKey(g.key);
    prefetchGroup(g);
  };

  /** Клик по иконке группы.
   *
   *  Мышь/клавиатура: панель уже показывает эту группу (hover/focus её
   *  открыл) — клик означает «веди в раздел», идём на ПЕРВЫЙ разрешённый
   *  пункт, пустой панели не бывает.
   *
   *  Тач на широком экране (планшет > 900px, где рендерится rail, а не
   *  drawer): hover'а нет, поэтому первый тап только раскрывает панель,
   *  второй — переходит. */
  const openGroup = (g: VisibleGroup) => {
    prefetchGroup(g);
    if (previewGroupKey === g.key || activeGroupKey === g.key) {
      navigate(groupHome(g));
      return;
    }
    setPreviewGroupKey(g.key);
  };

  const renderItems = (g: VisibleGroup) => (
    <>
      {g.items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          onClick={() => onClose?.()}
          {...prefetchProps(it.to)}
        >
          <span className="sidebar-nav-icon">
            <Icon name={it.icon} size={20} />
          </span>
          <span>{t(it.labelKey)}</span>
        </NavLink>
      ))}
    </>
  );

  // ===== Нижний блок: /me + База знаний + юзер, язык, пароль, выход =====
  const foot = (
    <div className="sidebar-foot">
      <div className="sidebar-quick">
        <NavLink to={PROFILE_ITEM.to} onClick={() => onClose?.()} {...prefetchProps(PROFILE_ITEM.to)}>
          <span className="sidebar-nav-icon">
            <Icon name={PROFILE_ITEM.icon} size={19} />
          </span>
          <span>{t(PROFILE_ITEM.labelKey)}</span>
        </NavLink>
        {/* База знаний — внешняя ссылка на лендинг (ТЗ §3.1
            "сайт используется ... сотрудниками как база знаний").
            QA-fix #8: базу берём из lib/landingUrl, не из inline-env. */}
        <a href={`${resolveLandingBaseUrl()}/knowledge`} target="_blank" rel="noreferrer">
          <span className="sidebar-nav-icon">
            <Icon name="library_books" size={19} />
          </span>
          <span>{t('sidebar.knowledge')}</span>
          <Icon name="open_in_new" size={13} style={{ marginLeft: 'auto', opacity: 0.45 }} />
        </a>
      </div>
      <motion.div
        className="sidebar-user"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.3 }}
      >
        <motion.div
          className="user-avatar"
          whileHover={{ scale: 1.1 }}
          transition={{ type: 'spring', stiffness: 300 }}
        >
          {initials}
        </motion.div>
        <div className="user-info">
          <div className="user-name">{user?.fullName}</div>
          <div className="user-role">{displayRoleLabel(user as any)}</div>
          <div style={{ marginTop: 6 }}>
            <LangSwitcher />
          </div>
        </div>
        <motion.button
          className="logout-btn"
          onClick={() => setPwdOpen(true)}
          title={t('auth.changePassword')}
          whileHover={{ scale: 1.15 }}
          whileTap={{ scale: 0.9 }}
        >
          <Icon name="lock_reset" size={20} />
        </motion.button>
        <motion.button
          className="logout-btn"
          onClick={logout}
          title={t('auth.logout')}
          whileHover={{ scale: 1.15, rotate: 15 }}
          whileTap={{ scale: 0.9 }}
        >
          <Icon name="logout" size={20} />
        </motion.button>
      </motion.div>
    </div>
  );

  return (
    <motion.aside
      className={`sidebar sidebar-2l${mobileOpen ? ' mobile-open' : ''}`}
      initial={{ x: -80, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="sidebar-logo"
        whileHover={{ scale: 1.03 }}
        transition={{ type: 'spring', stiffness: 300 }}
      >
        <img src="/javonon-logo.svg" alt="Javonon" className="sidebar-brand-img" />
      </motion.div>

      {isMobile ? (
        // ===== МОБИЛЬНЫЙ DRAWER: два шага =====
        <div className="sidebar-mobile">
          <AnimatePresence mode="wait" initial={false}>
            {!drawerGroupObj ? (
              <motion.div
                key="step-groups"
                className="m-step"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.18 }}
              >
                {groups.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    className={`m-group-btn${g.key === activeGroupKey ? ' active' : ''}`}
                    onClick={() => { prefetchGroup(g); setDrawerGroup(g.key); }}
                    onTouchStart={() => prefetchGroup(g)}
                    onMouseEnter={() => prefetchGroup(g)}
                    onFocus={() => prefetchGroup(g)}
                  >
                    <span className="sidebar-nav-icon"><Icon name={g.icon} size={22} /></span>
                    <span>{t(g.labelKey)}</span>
                    <Icon name="chevron_right" size={20} className="m-chev" />
                  </button>
                ))}
              </motion.div>
            ) : (
              <motion.div
                key="step-items"
                className="m-step"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ duration: 0.18 }}
              >
                <button
                  type="button"
                  className="m-back"
                  onClick={() => setDrawerGroup(null)}
                  aria-label={t('common.back')}
                >
                  <Icon name="arrow_back" size={18} />
                  <span>{t(drawerGroupObj.labelKey)}</span>
                </button>
                <nav className="sidebar-panel-nav">{renderItems(drawerGroupObj)}</nav>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        // ===== ДЕСКТОП: rail с 6 иконками + панель пунктов =====
        <div
          className="sidebar-split"
          // Курсор ушёл со всего блока (rail + панель) — снимаем просмотр.
          // Уход С RAIL'А не считается: пользователь как раз едет мышью в
          // панель, к пунктам просматриваемой группы.
          onMouseLeave={() => setPreviewGroupKey(null)}
          // То же для клавиатуры: фокус покинул сайдбар — просмотр снят.
          // Переход фокуса внутрь панели (по пунктам) просмотр сохраняет.
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setPreviewGroupKey(null);
            }
          }}
        >
          <nav className="sidebar-rail" aria-label={t('sidebar.menu')}>
            {groups.map((g) => (
              <motion.button
                key={g.key}
                type="button"
                className={`rail-btn${g.key === activeGroupKey ? ' active' : ''}${
                  previewGroup && previewGroup.key === g.key && g.key !== activeGroupKey ? ' preview' : ''
                }`}
                onClick={() => openGroup(g)}
                title={t(g.labelKey)}
                aria-label={t(g.labelKey)}
                aria-current={g.key === activeGroupKey ? 'true' : undefined}
                aria-expanded={panelGroup?.key === g.key}
                aria-controls="sidebar-panel-nav"
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.94 }}
                onMouseEnter={() => previewGroupOn(g)}
                onFocus={() => previewGroupOn(g)}
                onTouchStart={() => prefetchGroup(g)}
              >
                <Icon name={g.icon} size={22} />
              </motion.button>
            ))}
          </nav>
          <div className="sidebar-panel">
            <div className="sidebar-panel-title">{panelGroup ? t(panelGroup.labelKey) : ''}</div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.nav
                key={panelGroup?.key || 'empty'}
                id="sidebar-panel-nav"
                className="sidebar-panel-nav"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                // Панель теперь переключается по hover'у — при mode="wait"
                // задержка удваивается (exit + enter), поэтому короче.
                transition={{ duration: 0.1 }}
              >
                {panelGroup ? renderItems(panelGroup) : null}
              </motion.nav>
            </AnimatePresence>
          </div>
        </div>
      )}

      {foot}
      <ChangePasswordModal
        open={pwdOpen}
        mode={{ kind: 'self' }}
        onClose={() => setPwdOpen(false)}
      />
    </motion.aside>
  );
}
