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

const TITLES: Record<string, { eyebrow: string; pre: string; em: string }> = {
  '/dashboard': { eyebrow: 'OVERVIEW · 01', pre: 'Картина', em: 'дня.' },
  '/applications': { eyebrow: 'INBOUND · 02', pre: 'Заявки', em: 'студентов.' },
  '/students': { eyebrow: 'PIPELINE · 03', pre: 'Студенты', em: 'в работе.' },
  '/programs': { eyebrow: 'CATALOG · 04', pre: 'Программы', em: 'и гранты.' },
  '/tasks': { eyebrow: 'WORK · 05', pre: 'Задачи', em: 'команды.' },
  '/activity': { eyebrow: 'AUDIT · 06', pre: 'Хронология', em: 'действий.' },
  '/users': { eyebrow: 'TEAM · 07', pre: 'Сотрудники', em: 'Javonon.' },
  '/time': { eyebrow: 'HR · 04', pre: 'Учёт', em: 'времени.' },
  '/finance': { eyebrow: 'FINANCE · 08', pre: 'Деньги', em: 'компании.' },
  '/salary': { eyebrow: 'PAYROLL · 09', pre: 'Зарплата', em: 'команды.' },
  '/kpi': { eyebrow: 'KPI · 10', pre: 'Эффективность', em: 'каждого.' },
  '/reports': { eyebrow: 'DAILY · 11', pre: 'Мой', em: 'отчёт.' },
  '/calls': { eyebrow: 'CALLS · 12', pre: 'Журнал', em: 'звонков.' },
  '/chat': { eyebrow: 'CHAT · 13', pre: 'Внутренний', em: 'чат.' },
  '/lms': { eyebrow: 'LMS · 14', pre: 'Курсы', em: 'и материалы.' },
  '/partners': { eyebrow: 'PARTNERS · 15', pre: 'Партнёрская', em: 'программа.' },
  '/me': { eyebrow: 'PROFILE · 16', pre: 'Мой', em: 'кабинет.' },
};

export default function Layout() {
  const loc = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { toast } = useUI();
  const logout = useAuth((s) => s.logout);
  const meta = Object.entries(TITLES).find(([k]) => loc.pathname.startsWith(k))?.[1]
    || { eyebrow: 'JAVONON · CRM', pre: 'Панель', em: 'управления.' };

  // По ТЗ §2: «права передаются основателем». Когда FOUNDER меняет
  // мои роли через RolesEditor, бэкенд шлёт `user:roles-updated` в мою
  // личную комнату. JWT в localStorage уже устарел — backend RolesGuard
  // читает старые роли. Логаут даёт сразу взять новый JWT с актуальными
  // правами при следующем логине.
  useRealtimeEvent('user:roles-updated', () => {
    toast('Ваши права были изменены администратором. Пожалуйста, войдите заново.', 'info');
    setTimeout(() => logout(), 4000);
  });

  // Аккаунт удалён администратором — кикаем сразу. JWT в localStorage
  // продолжал бы работать ~7 дней до истечения, что давало «удалённому»
  // сотруднику фактический доступ к системе.
  useRealtimeEvent('user:deleted', () => {
    toast('Ваш аккаунт был удалён администратором.', 'error');
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
            aria-label="Меню"
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
                {meta.pre} <em>{meta.em}</em>
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
