import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
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
import { hasRole } from '../lib/roles';
import { ROLE_LABEL, type Role } from '../api/types';

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

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export default function Sidebar({ mobileOpen = false, onClose }: SidebarProps = {}) {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const [pwdOpen, setPwdOpen] = useState(false);
  const initials = user?.fullName?.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

  // FOUNDER неявно везде. ADMIN/ACCOUNTANT — равные «elevated» по ТЗ.
  // Менеджеры (SALES_MANAGER/CLIENT_MANAGER) видят рабочие зоны (заявки,
  // студенты, KPI, отчёты), но не финансы/обучение/партнёров/активность.
  const elevated = hasRole(user, 'FOUNDER', 'ADMIN', 'ACCOUNTANT');
  const isFounder = hasRole(user, 'FOUNDER');
  const isWorkforce = hasRole(user, 'FOUNDER', 'ADMIN', 'SALES_MANAGER', 'CLIENT_MANAGER');

  // CRM core — для всех (Dashboard, Заявки, Студенты, Программы, Задачи, Время, KPI)
  const coreLinks = [
    { to: '/dashboard', icon: 'dashboard', label: 'Дашборд' },
    ...(isWorkforce ? [
      { to: '/applications', icon: 'assignment', label: 'Заявки' },
      { to: '/students', icon: 'school', label: 'Студенты' },
      { to: '/programs', icon: 'menu_book', label: 'Программы' },
      { to: '/tasks', icon: 'task_alt', label: 'Задачи' },
    ] : []),
    { to: '/chat', icon: 'forum', label: 'Чат' },
    ...(isWorkforce ? [{ to: '/inbox', icon: 'inbox', label: 'Входящие' }] : []),
    { to: '/time', icon: 'schedule', label: 'Время' },
    ...(isWorkforce ? [
      { to: '/reports', icon: 'description', label: 'Мои отчёты' },
      { to: '/calls', icon: 'call', label: 'Звонки' },
      { to: '/kpi', icon: 'leaderboard', label: 'KPI' },
    ] : []),
    { to: '/me', icon: 'person', label: 'Мой профиль' },
  ];

  // Finance — для FOUNDER/ADMIN/ACCOUNTANT
  const financeLinks = elevated ? [
    { to: '/finance', icon: 'payments', label: 'Финансы' },
    { to: '/salary', icon: 'paid', label: 'Зарплата' },
  ] : [];

  // Elevated-only (управление)
  const adminLinks = elevated ? [
    { to: '/pipelines', icon: 'route', label: 'Воронки' },
    { to: '/massmail', icon: 'campaign', label: 'Рассылки' },
    { to: '/offers', icon: 'description', label: 'Оферты' },
    { to: '/lms', icon: 'menu_book', label: 'Обучение' },
    { to: '/partners', icon: 'handshake', label: 'Партнёры' },
    { to: '/activity', icon: 'history', label: 'Активность' },
    { to: '/users', icon: 'group', label: 'Сотрудники' },
    ...(isFounder ? [
      { to: '/settings', icon: 'settings', label: 'Настройки системы' },
    ] : []),
  ] : [];

  const links = [...coreLinks, ...financeLinks, ...adminLinks];

  return (
    <motion.aside
      className={`sidebar${mobileOpen ? ' mobile-open' : ''}`}
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
      <motion.nav
        className="sidebar-nav"
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.07, delayChildren: 0.15 } },
        }}
      >
        {links.map((l) => (
          <motion.div
            key={l.to}
            variants={{
              hidden: { opacity: 0, x: -15 },
              show: { opacity: 1, x: 0, transition: { duration: 0.3 } },
            }}
          >
            <NavLink
              to={l.to}
              onClick={() => onClose?.()}
              onMouseEnter={() => prefetchRoute(l.to)}
              onTouchStart={() => prefetchRoute(l.to)}
              onFocus={() => prefetchRoute(l.to)}
            >
              <motion.span
                className="sidebar-nav-icon"
                whileHover={{ scale: 1.2, rotate: 8 }}
                transition={{ type: 'spring', stiffness: 400 }}
              >
                <Icon name={l.icon} size={22} />
              </motion.span>
              <span>{l.label}</span>
            </NavLink>
          </motion.div>
        ))}

        {/* База знаний — внешняя ссылка на лендинг (ТЗ §3.1
            "сайт используется ... сотрудниками как база знаний") */}
        <motion.div
          variants={{
            hidden: { opacity: 0, x: -15 },
            show: { opacity: 1, x: 0, transition: { duration: 0.3 } },
          }}
          style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.08)' }}
        >
          <a
            href={(() => {
              // QA-fix #8: javonon.vercel.app/knowledge → 404 (старый Vercel
              // project без SPA-rewrite). Актуальный landing — на
              // javonon-landing.vercel.app, его /knowledge работает.
              const base = (import.meta as any).env?.VITE_LANDING_URL || 'https://javonon-landing.vercel.app';
              return `${base}/knowledge`;
            })()}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '11px 14px',
              borderRadius: 8,
              color: 'rgba(255,255,255,0.7)',
              fontWeight: 500,
              fontSize: 14,
              textDecoration: 'none',
              transition: 'all .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-sidebar-hover)'; e.currentTarget.style.color = 'white'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
          >
            <span className="sidebar-nav-icon">
              <Icon name="library_books" size={22} />
            </span>
            <span>База знаний</span>
            <Icon name="open_in_new" size={14} style={{ marginLeft: 'auto', opacity: 0.5 }} />
          </a>
        </motion.div>
      </motion.nav>
      <motion.div
        className="sidebar-user"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.3 }}
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
          <div className="user-role">{ROLE_LABEL[(user?.role as Role) || 'SALES_MANAGER'] || '—'}</div>
        </div>
        <motion.button
          className="logout-btn"
          onClick={() => setPwdOpen(true)}
          title="Сменить пароль"
          whileHover={{ scale: 1.15 }}
          whileTap={{ scale: 0.9 }}
        >
          <Icon name="lock_reset" size={20} />
        </motion.button>
        <motion.button
          className="logout-btn"
          onClick={logout}
          title="Выйти"
          whileHover={{ scale: 1.15, rotate: 15 }}
          whileTap={{ scale: 0.9 }}
        >
          <Icon name="logout" size={20} />
        </motion.button>
      </motion.div>
      <ChangePasswordModal
        open={pwdOpen}
        mode={{ kind: 'self' }}
        onClose={() => setPwdOpen(false)}
      />
    </motion.aside>
  );
}
