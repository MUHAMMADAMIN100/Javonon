import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import Icon from '../Icon';
import ChangePasswordModal from './ChangePasswordModal';

export default function Sidebar() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const [pwdOpen, setPwdOpen] = useState(false);
  const initials = user?.fullName?.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

  const isAdmin = user?.role === 'ADMIN';
  const isAccountant = user?.role === 'ACCOUNTANT';
  const isEmployee = user?.role === 'EMPLOYEE';

  // CRM core — для всех (Dashboard, Заявки, Студенты, Программы, Задачи, Время, KPI)
  const coreLinks = [
    { to: '/dashboard', icon: 'dashboard', label: 'Дашборд' },
    ...(isAdmin || isEmployee ? [
      { to: '/applications', icon: 'assignment', label: 'Заявки' },
      { to: '/students', icon: 'school', label: 'Студенты' },
      { to: '/programs', icon: 'menu_book', label: 'Программы' },
      { to: '/tasks', icon: 'task_alt', label: 'Задачи' },
    ] : []),
    { to: '/time', icon: 'schedule', label: 'Время' },
    ...(isAdmin || isEmployee ? [
      { to: '/kpi', icon: 'leaderboard', label: 'KPI' },
    ] : []),
  ];

  // Finance — для ADMIN и ACCOUNTANT
  const financeLinks = (isAdmin || isAccountant) ? [
    { to: '/finance', icon: 'payments', label: 'Финансы' },
    { to: '/salary', icon: 'paid', label: 'Зарплата' },
  ] : [];

  // Admin-only
  const adminLinks = isAdmin ? [
    { to: '/activity', icon: 'history', label: 'Активность' },
    { to: '/users', icon: 'group', label: 'Сотрудники' },
  ] : [];

  const links = [...coreLinks, ...financeLinks, ...adminLinks];

  return (
    <motion.aside
      className="sidebar"
      initial={{ x: -80, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="sidebar-logo"
        whileHover={{ scale: 1.03 }}
        transition={{ type: 'spring', stiffness: 300 }}
      >
        <span className="logo-mark">J</span>
        <span className="logo-text">Javonon</span>
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
            <NavLink to={l.to}>
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
          <div className="user-role">{user?.role === 'ADMIN' ? 'Администратор' : 'Сотрудник'}</div>
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
