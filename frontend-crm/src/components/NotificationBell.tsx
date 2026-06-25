import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listNotifications, markAllRead, markRead, unreadCount } from '../api/notifications';
import type { Notification } from '../api/types';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useOptimisticMutation } from '../lib/optimistic';
import { useT } from '../lib/i18n';

function notificationHref(n: Notification): string | null {
  const p = n.payload || {};
  // QA-fix: chat-уведомления → /chat?room=<id> (Chat.tsx прочитает query)
  if (n.type === 'CHAT_MESSAGE' || n.type === 'CHAT_MENTION') {
    return p.roomId ? `/chat?room=${p.roomId}` : '/chat';
  }
  if (p.applicationId) return `/applications/${p.applicationId}`;
  if (p.studentId) return `/students/${p.studentId}`;
  if (p.taskId) return '/tasks';
  if (n.type === 'TASK_ASSIGNED') return '/tasks';
  if (n.type === 'APPLICATION_NEW') return '/applications';
  return null;
}

/** Запрашиваем разрешение на desktop-нотификации один раз. */
function ensureNotifPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

/** Показываем браузерную нотификацию (если разрешено). */
function showBrowserNotif(title: string, body: string, onClick?: () => void) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  // Не показываем если вкладка активна — пользователь и так увидит.
  if (typeof document !== 'undefined' && !document.hidden) return;
  try {
    const n = new Notification(title, { body, icon: '/javonon-logo.svg', tag: 'javonon-chat' });
    if (onClick) n.onclick = () => { window.focus(); onClick(); n.close(); };
  } catch { /* ignore */ }
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const countQuery = useQuery<number>({
    queryKey: keys.notifications.unread(),
    queryFn: () => unreadCount(),
    refetchInterval: 30_000,
  });
  const count = countQuery.data ?? 0;

  // Список грузится только когда панель открыта.
  const listKey = keys.notifications.list();
  const listQuery = useQuery<Notification[]>({
    queryKey: listKey,
    queryFn: () => listNotifications(),
    enabled: open,
  });
  const items = listQuery.data ?? [];

  const filtered = items.filter((n) => {
    if (onlyUnread && n.read) return false;
    const t = new Date(n.createdAt).getTime();
    if (from) {
      const f = new Date(from).getTime();
      if (t < f) return false;
    }
    if (to) {
      const tt = new Date(to + 'T23:59:59').getTime();
      if (t > tt) return false;
    }
    return true;
  });

  // Разрешение на desktop-уведомления — спрашиваем один раз при монтировании.
  useEffect(() => { ensureNotifPermission(); }, []);

  useRealtime({
    'notification:new': (data: any) => {
      qc.invalidateQueries({ queryKey: keys.notifications.all });
      // QA-fix: показываем browser-notification (только если вкладка не активна).
      if (data?.title) {
        showBrowserNotif(data.title, data.message || '', () => {
          const href = notificationHref({ ...data, payload: data?.payload || {} } as any);
          if (href) navigate(href);
        });
      }
    },
  });

  // Закрытие по клику вне панели/кнопки
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Optimistic mark single as read.
  const markReadMut = useOptimisticMutation<unknown, string, Notification[]>({
    mutationFn: markRead,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.updateById(cur, id, { read: true } as Partial<Notification>),
    invalidateAlso: [keys.notifications.unread()],
  });

  const markAllMut = useOptimisticMutation<unknown, void, Notification[]>({
    mutationFn: () => markAllRead(),
    queryKey: listKey,
    applyOptimistic: (cur) => (cur ?? []).map((n) => ({ ...n, read: true })),
    invalidateAlso: [keys.notifications.unread()],
  });

  const onItemClick = (n: Notification) => {
    if (!n.read) {
      // markReadMut уже инвалидирует unread-count (invalidateAlso),
      // оптимистично помечает item как read в listKey. Раньше тут был
      // ещё ручной декремент qc.setQueryData(unread), но при быстрых
      // двойных кликах по одному элементу счётчик расходился с реальностью.
      // Полагаемся на серверный refetch после мутации.
      markReadMut.mutate(n.id);
    }
    const href = notificationHref(n);
    if (href) {
      setOpen(false);
      navigate(href);
    }
  };

  const onMarkAll = () => {
    markAllMut.mutate();
    qc.setQueryData<number>(keys.notifications.unread(), 0);
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <motion.button
        className="notif-button"
        onClick={() => setOpen(!open)}
        title={t('notif.title')}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        animate={count > 0 ? { rotate: [0, -12, 12, -8, 8, 0] } : {}}
        transition={count > 0 ? { duration: 0.6, repeat: Infinity, repeatDelay: 3 } : {}}
      >
        <Icon name="notifications" size={22} />
        <AnimatePresence>
          {count > 0 && (
            <motion.span
              className="notif-badge"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 20 }}
              key={count}
            >
              {count > 99 ? '99+' : count}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="notif-panel"
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="notif-panel-header">
              <span>{t('notif.title')}</span>
              {items.some((i) => !i.read) && (
                <motion.button
                  className="btn btn-sm btn-secondary"
                  onClick={onMarkAll}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  {t('notif.markAll')}
                </motion.button>
              )}
            </div>

            <div className="notif-filters">
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder={t('common.from')}
              />
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder={t('common.until')}
              />
              <label className="notif-only-unread">
                <input
                  type="checkbox"
                  checked={onlyUnread}
                  onChange={(e) => setOnlyUnread(e.target.checked)}
                />
                <span>{t('notif.onlyUnread')}</span>
              </label>
            </div>

            {filtered.length === 0 ? (
              <div className="notif-empty">
                {t('common.empty')}
              </div>
            ) : (
              <motion.div
                initial="hidden"
                animate="show"
                variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
              >
                {filtered.map((n) => (
                  <motion.div
                    key={n.id}
                    className={`notif-item${n.read ? '' : ' unread'}`}
                    variants={{
                      hidden: { opacity: 0, x: -10 },
                      show: { opacity: 1, x: 0 },
                    }}
                    whileHover={{ x: 4 }}
                  >
                    <div className="notif-item-body" onClick={() => onItemClick(n)}>
                      <div className="notif-item-title">
                        {!n.read && <span className="notif-dot" />}
                        {n.title}
                      </div>
                      <div className="notif-item-msg">{n.message}</div>
                      <div className="notif-item-time">{new Date(n.createdAt).toLocaleString('ru-RU')}</div>
                    </div>
                    {!n.read && (
                      <button
                        className="notif-item-read"
                        title={t('notif.markRead')}
                        onClick={(e) => {
                          e.stopPropagation();
                          // invalidateAlso в markReadMut обновит счётчик.
                          markReadMut.mutate(n.id);
                        }}
                      >
                        <Icon name="done" size={16} />
                      </button>
                    )}
                  </motion.div>
                ))}
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
