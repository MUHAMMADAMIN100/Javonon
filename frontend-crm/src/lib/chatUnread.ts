import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { chatUnread } from '../api/chat';
import { keys } from './queryKeys';
import { useRealtime, useRealtimeConnState } from '../realtime';
import { useAuth } from '../store/auth';
import { playChatSound } from './chatSound';

/**
 * Непрочитанные сообщения чата — одно место на всё приложение.
 *
 * Слушатель сокета подключён в оболочке (Layout), поэтому счётчик в меню
 * растёт на любой странице, а не только когда открыт чат. Страница чата
 * сообщает, какую комнату человек сейчас смотрит: её сообщения не считаются
 * непрочитанными (страница сама отметит их прочитанными).
 *
 * mentions — сколько из непрочитанных упоминают этого человека: по ним
 * рисуется значок «@» (в списке чатов и в меню).
 *
 * Звук: новое сообщение, которое попало в непрочитанные (вкладка не активна
 * или открыт другой чат/другая страница).
 */
type Unread = Array<{ roomId: string; unread: number; mentions?: number }>;
export type RoomUnread = { unread: number; mentions: number };

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

  const setRoom = (roomId: string, fn: (r: RoomUnread) => RoomUnread) => {
    qc.setQueryData<Unread>(keys.chat.unread(), (cur) => {
      const list = cur ?? [];
      const found = list.find((u) => u.roomId === roomId);
      const next = fn({ unread: found?.unread ?? 0, mentions: found?.mentions ?? 0 });
      const row = { roomId, unread: Math.max(0, next.unread), mentions: Math.max(0, next.mentions) };
      return found ? list.map((u) => (u.roomId === roomId ? row : u)) : [...list, row];
    });
  };

  useRealtime({
    'chat:message': (d: any) => {
      if (!d?.message || !d.roomId) return;
      if (d.message.authorId === me?.id) return;
      if (isViewing(d.roomId)) return;
      const mentioned = !!me?.id && Array.isArray(d.message.mentionsIds) && d.message.mentionsIds.includes(me.id);
      setRoom(d.roomId, (r) => ({ unread: r.unread + 1, mentions: r.mentions + (mentioned ? 1 : 0) }));
      playChatSound();
    },
    // Прочитал я (в этой вкладке или в другой) — обнуляем комнату вместе с «@».
    'chat:read': (d: any) => {
      if (d?.userId && d.userId === me?.id) setRoom(d.roomId, () => ({ unread: 0, mentions: 0 }));
    },
    'chat:message:deleted': () => qc.invalidateQueries({ queryKey: keys.chat.unread() }),
    'chat:room': () => qc.invalidateQueries({ queryKey: keys.chat.unread() }),
    // Чат удалили (у меня или у всех) / я вышел из команды — его счётчик больше не нужен.
    'chat:room:removed': (d: any) => {
      if (d?.roomId) qc.setQueryData<Unread>(keys.chat.unread(), (cur) => (cur ?? []).filter((u) => u.roomId !== d.roomId));
    },
  });

  // После переподключения сокета события могли потеряться — сверяемся с сервером.
  useEffect(() => {
    if (conn === 'connected' && me) qc.invalidateQueries({ queryKey: keys.chat.unread() });
  }, [conn, me, qc]);
}

/** Непрочитанные и упоминания по комнате. */
export function useChatUnreadMap(): Record<string, RoomUnread> {
  const q = useUnreadQuery();
  return Object.fromEntries((q.data ?? []).map((u) => [u.roomId, { unread: u.unread, mentions: u.mentions ?? 0 }]));
}

/** Всего непрочитанных и есть ли среди них упоминание меня — для значка в меню. */
export function useChatUnreadTotal(): { count: number; mention: boolean } {
  const q = useUnreadQuery();
  const list = q.data ?? [];
  return {
    count: list.reduce((s, u) => s + u.unread, 0),
    mention: list.some((u) => (u.mentions ?? 0) > 0),
  };
}
