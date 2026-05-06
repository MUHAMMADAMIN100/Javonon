import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from './Sidebar';
import NotificationBell from './NotificationBell';
import RealtimeStatusBanner from './RealtimeStatusBanner';

const TITLES: Record<string, string> = {
  '/dashboard': 'Дашборд',
  '/applications': 'Заявки',
  '/students': 'Студенты',
  '/users': 'Пользователи',
};

export default function Layout() {
  const loc = useLocation();
  const title = Object.entries(TITLES).find(([k]) => loc.pathname.startsWith(k))?.[1] || 'Javonon CRM';

  return (
    <div className="app-layout">
      <RealtimeStatusBanner />
      <Sidebar />
      <div className="main">
        <motion.div
          className="topbar"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={title}
              className="topbar-title"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
            >
              {title}
            </motion.div>
          </AnimatePresence>
          <div className="topbar-actions">
            <NotificationBell />
          </div>
        </motion.div>
        <div className="content">
          <AnimatePresence mode="wait">
            <motion.div
              key={loc.pathname}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
