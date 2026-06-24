import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from './Sidebar';
import NotificationBell from './NotificationBell';
import RealtimeStatusBanner from './RealtimeStatusBanner';
import Dialpad from './Dialpad';
import Icon from '../Icon';
import { useRealtimeEvent } from '../realtime';
import { useUI } from '../ui/Dialogs';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';

const TITLE_ROUTES: Array<{ path: string; eyebrow: string; titleKey: string }> = [
  { path: '/dashboard',    eyebrow: 'OVERVIEW · 01', titleKey: 'dashboard.title' },
  { path: '/applications', eyebrow: 'INBOUND · 02',  titleKey: 'app.title' },
  { path: '/students',     eyebrow: 'PIPELINE · 03', titleKey: 'students.title' },
  { path: '/programs',     eyebrow: 'CATALOG · 04',  titleKey: 'programs.title' },
  { path: '/tasks',        eyebrow: 'WORK · 05',     titleKey: 'tasks.title' },
  { path: '/activity',     eyebrow: 'AUDIT · 06',    titleKey: 'activity.title' },
  { path: '/users',        eyebrow: 'TEAM · 07',     titleKey: 'users.title' },
  { path: '/workday',      eyebrow: 'HR · 04',       titleKey: 'workday.title' },
  { path: '/time',         eyebrow: 'HR · 04',       titleKey: 'workday.title' },
  { path: '/finance',      eyebrow: 'FINANCE · 08',  titleKey: 'finance.title' },
  { path: '/salary',       eyebrow: 'PAYROLL · 09',  titleKey: 'salary.title' },
  { path: '/kpi',          eyebrow: 'KPI · 10',      titleKey: 'kpi.title' },
  { path: '/reports',      eyebrow: 'DAILY · 11',    titleKey: 'reports.title' },
  { path: '/calls',        eyebrow: 'CALLS · 12',    titleKey: 'calls.title' },
  { path: '/chat',         eyebrow: 'CHAT · 13',     titleKey: 'chat.title' },
  { path: '/lms',          eyebrow: 'LMS · 14',      titleKey: 'lms.title' },
  { path: '/partners',     eyebrow: 'PARTNERS · 15', titleKey: 'partners.title' },
  { path: '/me',           eyebrow: 'PROFILE · 16',  titleKey: 'profile.title' },
];

export default function Layout() {
  const loc = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { toast } = useUI();
  const { t } = useT();
  const logout = useAuth((s) => s.logout);
  const route = TITLE_ROUTES.find((r) => loc.pathname.startsWith(r.path));
  const meta = route
    ? { eyebrow: route.eyebrow, title: t(route.titleKey) }
    : { eyebrow: 'JAVONON · CRM', title: 'Javonon' };

  // По ТЗ §2: «права передаются основателем». Когда FOUNDER меняет
  // мои роли через RolesEditor, бэкенд шлёт `user:roles-updated` в мою
  // личную комнату. JWT в localStorage уже устарел — backend RolesGuard
  // читает старые роли. Логаут даёт сразу взять новый JWT с актуальными
  // правами при следующем логине.
  useRealtimeEvent('user:roles-updated', () => {
    toast(t('layout.rolesUpdated'), 'info');
    setTimeout(() => logout(), 4000);
  });

  useRealtimeEvent('user:deleted', () => {
    toast(t('layout.accountDeleted'), 'error');
    setTimeout(() => logout(), 3000);
  });

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileNavOpen(false);
  }, [loc.pathname]);

  // Lock body scroll when drawer open
  useEffect(() => {
    if (mobileNavOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [mobileNavOpen]);

  // Escape key closes drawer (для планшетов с клавиатурой)
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  return (
    <div className={`app-layout${mobileNavOpen ? ' nav-open' : ''}`}>
      <RealtimeStatusBanner />
      <Dialpad />
      <Sidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <AnimatePresence>
        {mobileNavOpen && (
          <motion.div
            className="sidebar-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setMobileNavOpen(false)}
          />
        )}
      </AnimatePresence>
      <div className="main">
        <motion.div
          className="topbar"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          <button
            type="button"
            className="topbar-burger"
            onClick={() => setMobileNavOpen((v) => !v)}
            aria-label={t('sidebar.menu')}
          >
            <Icon name={mobileNavOpen ? 'close' : 'menu'} size={24} />
          </button>
          <AnimatePresence mode="wait">
            <motion.div
              key={meta.eyebrow}
              className="topbar-title-block"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
            >
              <div className="topbar-eyebrow">{meta.eyebrow}</div>
              <div className="topbar-title">
                {meta.title}
              </div>
            </motion.div>
          </AnimatePresence>
          <div className="topbar-actions">
            <NotificationBell />
          </div>
        </motion.div>
        <div className="content">
          <motion.div
            key={loc.pathname}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <Outlet />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
