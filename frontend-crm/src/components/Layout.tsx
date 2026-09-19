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
import { me as apiMe } from '../api/auth';
import { useT } from '../lib/i18n';

/**
 * Заголовок страницы — ОДИН, и живёт он здесь.
 *
 * Раньше каждая страница дополнительно рисовала свой <h2> с тем же самым
 * названием, и пользователь видел «Дашборд» дважды подряд. Теперь шапка —
 * единственное место, где страница называется; внутри остаются только
 * подзаголовки СЕКЦИЙ («Финансы», «Распределение»), то есть то, что от
 * названия страницы отличается.
 *
 * Отсюда же следует: новый маршрут обязан появиться в этом списке, иначе в
 * шапке будет стоять дежурное «Javonon» и страница окажется безымянной.
 *
 * eyebrowKey — ключ словаря, а не готовая строка: подпись над заголовком
 * тоже читают, и на таджикском она обязана быть таджикской. Номер рядом —
 * часть оформления, его не переводим.
 */
const TITLE_ROUTES: Array<{ path: string; eyebrowKey: string; num: string; titleKey: string }> = [
  { path: '/dashboard',    eyebrowKey: 'eyebrow.overview',       num: '01', titleKey: 'dashboard.title' },
  { path: '/applications', eyebrowKey: 'eyebrow.inbound',        num: '02', titleKey: 'app.title' },
  { path: '/students',     eyebrowKey: 'eyebrow.pipeline',       num: '03', titleKey: 'students.title' },
  { path: '/programs',     eyebrowKey: 'eyebrow.catalog',        num: '04', titleKey: 'programs.title' },
  { path: '/tasks',        eyebrowKey: 'eyebrow.work',           num: '05', titleKey: 'tasks.title' },
  { path: '/activity',     eyebrowKey: 'eyebrow.audit',          num: '06', titleKey: 'activity.title' },
  { path: '/users',        eyebrowKey: 'eyebrow.team',           num: '07', titleKey: 'users.title' },
  { path: '/finance',      eyebrowKey: 'eyebrow.finance',        num: '08', titleKey: 'finance.title' },
  { path: '/salary',       eyebrowKey: 'eyebrow.payroll',        num: '09', titleKey: 'salary.title' },
  { path: '/kpi',          eyebrowKey: 'eyebrow.kpi',            num: '10', titleKey: 'kpi.title' },
  { path: '/reports',      eyebrowKey: 'eyebrow.daily',          num: '11', titleKey: 'reports.title' },
  { path: '/calls',        eyebrowKey: 'eyebrow.calls',          num: '12', titleKey: 'calls.title' },
  { path: '/chat',         eyebrowKey: 'eyebrow.chat',           num: '13', titleKey: 'chat.title' },
  { path: '/lms',          eyebrowKey: 'eyebrow.lms',            num: '14', titleKey: 'lms.title' },
  { path: '/partners',     eyebrowKey: 'eyebrow.partners',       num: '15', titleKey: 'partners.title' },
  { path: '/me',           eyebrowKey: 'eyebrow.profile',        num: '16', titleKey: 'profile.title' },
  { path: '/leads',        eyebrowKey: 'eyebrow.inbound',        num: '17', titleKey: 'leads.title' },
  { path: '/submissions',  eyebrowKey: 'eyebrow.sales',          num: '18', titleKey: 'submissions.title' },
  { path: '/pipelines',    eyebrowKey: 'eyebrow.salesPipelines', num: '19', titleKey: 'pipelines.title' },
  { path: '/massmail',     eyebrowKey: 'eyebrow.campaigns',      num: '20', titleKey: 'massmail.title' },
  { path: '/inbox',        eyebrowKey: 'eyebrow.unifiedInbox',   num: '21', titleKey: 'inbox.title' },
  { path: '/offers',       eyebrowKey: 'eyebrow.legal',          num: '22', titleKey: 'offers.title' },
  { path: '/groups',       eyebrowKey: 'eyebrow.catalog',        num: '23', titleKey: 'groups.title' },
  { path: '/schedule',     eyebrowKey: 'eyebrow.catalog',        num: '24', titleKey: 'classes.title' },
  { path: '/settings',     eyebrowKey: 'eyebrow.system',         num: '25', titleKey: 'settings.title' },
  // Четыре маршрута одной страницы «Рабочий день» (вкладки табеля,
  // посещаемости и отгулов) — заголовок у них общий.
  { path: '/workday',      eyebrowKey: 'eyebrow.hr',             num: '26', titleKey: 'workday.title' },
  { path: '/time',         eyebrowKey: 'eyebrow.hr',             num: '26', titleKey: 'workday.title' },
  { path: '/attendance',   eyebrowKey: 'eyebrow.hr',             num: '26', titleKey: 'workday.title' },
  { path: '/excuses',      eyebrowKey: 'eyebrow.hr',             num: '26', titleKey: 'workday.title' },
];

export default function Layout() {
  const loc = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { toast } = useUI();
  const { t } = useT();
  const logout = useAuth((s) => s.logout);
  const me = useAuth((s) => s.user);
  const route = TITLE_ROUTES.find((r) => loc.pathname.startsWith(r.path));
  const meta = route
    ? { eyebrow: `${t(route.eyebrowKey)} · ${route.num}`, title: t(route.titleKey) }
    : { eyebrow: t('eyebrow.javononCrm'), title: 'Javonon' };

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

  // Task 4: FOUNDER расширил permissions моей кастомной роли — backend шлёт
  // `customRole:updated` в staff-room. Здесь (в Layout — работает на любой
  // странице, а не только на /settings) подтягиваем свежий /auth/me, чтобы
  // Sidebar/ProtectedRoute перечитали `user.permissions` и открытые разделы
  // появились без релогина. Логика: если payload.id совпадает с моей
  // customRole.id — обновляемся; иначе игнорируем событие (это чужая роль).
  useRealtimeEvent('customRole:updated', async (payload: { id?: string; userId?: string }) => {
    const affectsMe =
      (payload?.id && me?.customRole?.id === payload.id) ||
      (payload?.userId && me?.id === payload.userId);
    if (!affectsMe) return;
    try {
      const fresh = await apiMe();
      useAuth.setState({ user: fresh });
    } catch {
      // Тихо игнорируем — cold-start Railway/network. Следующая навигация
      // подтянет /auth/me, а RolesGuard на бэке уже видит новые permissions.
    }
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
