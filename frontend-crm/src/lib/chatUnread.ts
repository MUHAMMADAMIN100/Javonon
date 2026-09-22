import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { chatUnread } from '../api/chat';
import { keys } from './queryKeys';
import { useRealtime, useRealtimeConnState } from '../realtime';
import { useAuth } from '../store/auth';

/**
 * Непрочитанные сообщения чата — одно место на всё приложение.
 *
 * Слушатель сокета подключён в оболочке (Layout), поэтому счётчик в меню
 * растёт на любой странице, а не только когда открыт чат. Страница чата
 * сообщает, какую комнату человек сейчас смотрит: её сообщения не считаются
 * непрочитанными (страница сама отметит их прочитанными).
 */
type Unread = Array<{ roomId: string; unread: number }>;

let viewingRoomId: string | null = null;

export function setViewingChatRoom(roomId: string | null) {
  viewingRoomId = roomId;
}

function isViewing(roomId: string) {
  return viewingRoomId === roomId && typeof document !== 'undefined' && !document.hidden;
}

function useUnreadQuery() {
  const me = useAuth((s) => s.user);
  return useQuery<Unread>({
    queryKey: keys.chat.unread(),
    queryFn: chatUnread,
    enabled: !!me,
    staleTime: 60_000,
  });
}

/** Подключается один раз (Layout): держит счётчики в актуальном состоянии. */
export function useChatUnreadSync() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const conn = useRealtimeConnState();
  useUnreadQuery();

  const setRoom = (roomId: string, fn: (n: number) => number) => {
    qc.setQueryData<Unread>(keys.chat.unread(), (cur) => {
      const list = cur ?? [];
      const found = list.find((u) => u.roomId === roomId);
      if (found) return list.map((u) => (u.roomId === roomId ? { ...u, unread: Math.max(0, fn(u.unread)) } : u));
      return [...list, { roomId, unread: Math.max(0, fn(0)) }];
    });
  };

  useRealtime({
    'chat:message': (d: any) => {
      if (!d?.message || !d.roomId) return;
      if (d.message.authorId === me?.id) return;
      if (isViewing(d.roomId)) return;
      setRoom(d.roomId, (n) => n + 1);
    },
    // Прочитал я (в этой вкладке или в другой) — обнуляем комнату.
    'chat:read': (d: any) => {
      if (d?.userId && d.userId === me?.id) setRoom(d.roomId, () => 0);
    },
    'chat:message:deleted': () => qc.invalidateQueries({ queryKey: keys.chat.unread() }),
    'chat:room': () => qc.invalidateQueries({ queryKey: keys.chat.unread() }),
  });

  // После переподключения сокета события могли потеряться — сверяемся с сервером.
  useEffect(() => {
    if (conn === 'connected' && me) qc.invalidateQueries({ queryKey: keys.chat.unread() });
  }, [conn, me, qc]);
}

/** Непрочитанные по комнате. */
export function useChatUnreadMap(): Record<string, number> {
  const q = useUnreadQuery();
  return Object.fromEntries((q.data ?? []).map((u) => [u.roomId, u.unread]));
}

/** Всего непрочитанных — для значка в меню. */
export function useChatUnreadTotal(): number {
  const q = useUnreadQuery();
  return (q.data ?? []).reduce((s, u) => s + u.unread, 0);
}
