import { fmtDateText, tjDateInput, TJ_TZ } from '../lib/tjTime';
import { absFileUrl, useFileToken } from '../lib/fileUrl';
import { setViewingChatRoom, useChatUnreadMap } from '../lib/chatUnread';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUI } from '../ui/Dialogs';
import {
  ChatRoom,
  ChatMessage,
  ChatAttachment,
  listChatRooms,
  getChatRoom,
  sendChatMessage,
  createDirectRoom,
  createTeamRoom,
  reactToMessage,
  deleteChatMessage,
  pinChatMessage,
  forwardChatMessage,
  sendChatMessageLive,
  sendTyping,
  markRoomRead,
  getChatRoomMembers,
  searchChatMessages,
  deleteChatRoom,
  leaveChatRoom,
  deleteChatMessages,
  editChatMessage,
  getMessageReads,
  type ChatRoomMember,
  type ChatSearchHit,
} from '../api/chat';
import { listUsers } from '../api/users';
import { listNotifications, markRead } from '../api/notifications';
import { useAuth } from '../store/auth';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation, tempId } from '../lib/optimistic';
import { isFounder, displayRoleLabel } from '../lib/roles';
import { useT } from '../lib/i18n';
import { ROLE_LABEL, type Role } from '../api/types';

// Базовый URL для статических attachments (chat-uploads).
const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TJ_TZ });
}
/** Цвет аватара и имени автора — постоянный для человека (как в Telegram). */
const AVATAR_COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#1f6fd1'];
function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
const FIVE_MIN = 5 * 60 * 1000;
function fmtDate(iso: string) {
  return fmtDateText(iso, { day: '2-digit', month: 'short', timeZone: TJ_TZ });
}
function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}
/** Черновик ещё не подтверждён сервером (или не ушёл). */
const isDraft = (m: ChatMessage) => m.id.startsWith('tmp-');
/** Сообщение, которое не удалось отправить: показываем «Повторить». */
type Draft = ChatMessage & { failed?: boolean };

/**
 * «был(а) …» — как в Telegram: только что / N мин назад / сегодня в 14:05 /
 * вчера в 14:05 / дата.
 */
function lastSeenLabel(iso: string | null | undefined, t: (k: string) => string) {
  if (!iso) return t('chat.seen.long');
  const at = new Date(iso).getTime();
  const diff = Date.now() - at;
  if (diff < 60_000) return t('chat.seen.justNow');
  if (diff < 60 * 60_000) return t('chat.seen.minutes').replace('{n}', String(Math.floor(diff / 60_000)));
  const day = tjDateInput(iso);
  if (day === tjDateInput(new Date())) return t('chat.seen.today').replace('{t}', fmtTime(iso));
  if (day === tjDateInput(new Date(Date.now() - 86_400_000))) return t('chat.seen.yesterday').replace('{t}', fmtTime(iso));
  return t('chat.seen.date').replace('{d}', fmtDateText(iso, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TJ_TZ }));
}

export default function Chat() {
  const { t } = useT();
  // Ссылки на картинки и файлы строятся с файловым токеном: перерисовываемся, когда он приходит.
  useFileToken();
  const unreadMap = useChatUnreadMap();
  const { toast, confirm } = useUI();
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeId, setActiveId] = useState<string | null>(searchParams.get('room'));
  // Mobile: показываем либо список комнат, либо тред. На десктопе — оба сразу
  // (CSS-grid). По умолчанию список — пользователь сам выбирает.
  const [mobileShowList, setMobileShowList] = useState(true);
  // Telegram-style папки чатов — какие свёрнуты (по типу комнаты).
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState('');
  const [showNewDirect, setShowNewDirect] = useState(false);
  const [showNewTeam, setShowNewTeam] = useState(false);
  // Состояние mention-picker'а: query — текст после '@' (или '' если только '@'),
  // start — позиция в input где начинается '@'. null = picker скрыт.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // Telegram-style features:
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; msg: ChatMessage } | null>(null);
  // (emojiPickerFor зарезервирован для будущего полного picker'а — пока quick-react через context-menu достаточно)
  // Что пересылаем: одно сообщение из меню или несколько выбранных.
  const [forwardSource, setForwardSource] = useState<ChatMessage[] | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Правка своего сообщения — поле ввода превращается в редактор.
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  // Выбор нескольких сообщений: null — режим выключен.
  const [selected, setSelected] = useState<string[] | null>(null);
  // Меню чата в списке (правая кнопка / удержание 1 с) и окно «Удалить чат».
  const [roomMenu, setRoomMenu] = useState<{ x: number; y: number; room: ChatRoom } | null>(null);
  const [deleteDirect, setDeleteDirect] = useState<ChatRoom | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  // Поиск: по списку чатов и по переписке открытого чата.
  const [roomSearch, setRoomSearch] = useState('');
  const [msgSearch, setMsgSearch] = useState<{ q: string; hits: ChatSearchHit[]; idx: number; loading: boolean } | null>(null);
  // Кнопка «вниз»: видна, когда читаешь историю; счётчик — новые сообщения ниже.
  const [showDown, setShowDown] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // Подсветка сообщения, к которому перешли (поиск, цитата).
  const [flashId, setFlashId] = useState<string | null>(null);
  // Есть ли в комнате более старые сообщения (подгружаются при прокрутке вверх).
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const loadingOlderRef = useRef(false);
  const atBottomRef = useRef(true);
  const scrollRestoreRef = useRef<{ height: number; top: number } | null>(null);
  const lastSeenRef = useRef<{ roomId: string | null; lastId: string | null; lastAt: string }>({ roomId: null, lastId: null, lastAt: '' });
  // Что нужно для повторной отправки черновика, который не ушёл.
  const draftsRef = useRef(new Map<string, { roomId: string; text: string; files: File[]; replyToId?: string }>());
  // Настоящий id сообщения → id его черновика: строка не пересоздаётся, когда
  // сервер подтвердил отправку (иначе пузырь «моргал» бы второй раз).
  const stableKeyRef = useRef(new Map<string, string>());
  const dragDepthRef = useRef(0);
  const longPressRef = useRef<{ timer: number | null; fired: boolean; touch: boolean }>({ timer: null, fired: false, touch: false });
  // Typing indicator: roomId → Map<userId, { name, expiresAt }>.
  // Auto-expire: если событие не приходило 5 сек — убираем из списка.
  const [typingByRoom, setTypingByRoom] = useState<Record<string, Record<string, { name: string; expiresAt: number }>>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Debounce-state для отправки typing-pings: помним когда последний раз
  // отправили ping (чтобы не спамить — раз в 3 сек) и когда было последнее
  // нажатие (чтобы через 3 сек тишины послать typing:false).
  const typingPingRef = useRef<{ lastPingAt: number; idleTimer: number | null }>({ lastPingAt: 0, idleTimer: null });

  const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '🔥', '🎉', '😢'];

  const roomsKey = keys.chat.rooms();
  const roomsQuery = useQuery<ChatRoom[]>({
    queryKey: roomsKey,
    queryFn: () => listChatRooms(),
  });
  const rooms = roomsQuery.data ?? [];

  // Auto-select первую комнату при первой загрузке.
  useEffect(() => {
    if (!activeId && rooms.length) setActiveId(rooms[0].id);
  }, [rooms, activeId]);

  // QA-fix: при открытии комнаты помечаем chat-уведомления для этой комнаты
  // как прочитанные, чтобы badge сбросился сразу.
  useEffect(() => {
    if (!activeId) return;
    (async () => {
      try {
        const all = await listNotifications();
        const unreadForRoom = all.filter(
          (n) => !n.read && n.payload && (n.payload as any).roomId === activeId,
        );
        if (unreadForRoom.length) {
          await Promise.all(unreadForRoom.map((n) => markRead(n.id).catch(() => undefined)));
          qc.invalidateQueries({ queryKey: keys.notifications.all });
        }
      } catch { /* ignore */ }
    })();
    // Синхронизируем URL: ?room=<id> — чтобы при F5 был тот же чат + чтобы
    // ссылки из notifications вели туда же.
    const cur = searchParams.get('room');
    if (cur !== activeId) {
      setSearchParams({ room: activeId }, { replace: true });
    }
  }, [activeId]);

  // Открытый чат не копит непрочитанные (см. lib/chatUnread).
  useEffect(() => {
    setViewingChatRoom(activeId);
    return () => setViewingChatRoom(null);
  }, [activeId]);

  // Если URL изменился (открыли через notification) — переключаем room.
  useEffect(() => {
    const fromUrl = searchParams.get('room');
    if (fromUrl && fromUrl !== activeId) setActiveId(fromUrl);
  }, [searchParams]);

  const messagesKey = activeId ? keys.chat.room(activeId) : ['chat', 'room', null];
  const messagesQuery = useQuery({
    queryKey: messagesKey,
    // Перечитывание не теряет ни подгруженную историю, ни черновики, которые ещё в пути.
    queryFn: async () => {
      const roomId = activeId!;
      const d = await getChatRoom(roomId);
      setHasMore((h) => ({ ...h, [roomId]: d.hasMore }));
      const cur = qc.getQueryData<ChatMessage[]>(keys.chat.room(roomId)) ?? [];
      const first = d.messages[0]?.createdAt;
      const older = first ? cur.filter((m) => !isDraft(m) && m.createdAt < first) : [];
      const drafts = cur.filter((m) => isDraft(m));
      if (older.length) setHasMore((h) => ({ ...h, [roomId]: true }));
      return [...older, ...d.messages, ...drafts];
    },
    enabled: !!activeId,
  });
  // Удалённые не показываем вовсе (сервер их и не отдаёт; это — на случай старого кеша).
  const messages = ((messagesQuery.data ?? []) as Draft[]).filter((m) => !m.deletedAt);

  /** Подгрузить более старые сообщения (прокрутка вверх). Возвращает, было ли что. */
  const loadOlder = async (keepScroll = true): Promise<boolean> => {
    const roomId = activeId;
    if (!roomId || loadingOlderRef.current || hasMore[roomId] === false) return false;
    const cur = qc.getQueryData<ChatMessage[]>(keys.chat.room(roomId)) ?? [];
    const oldest = cur.find((m) => !isDraft(m));
    if (!oldest) return false;
    loadingOlderRef.current = true;
    try {
      const d = await getChatRoom(roomId, oldest.createdAt);
      setHasMore((h) => ({ ...h, [roomId]: d.hasMore }));
      if (!d.messages.length) return false;
      const el = scrollRef.current;
      if (keepScroll && el) scrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
      qc.setQueryData<ChatMessage[]>(keys.chat.room(roomId), (list) => {
        const have = new Set((list ?? []).map((m) => m.id));
        return [...d.messages.filter((m) => !have.has(m.id)), ...(list ?? [])];
      });
      return true;
    } finally {
      loadingOlderRef.current = false;
    }
  };

  /**
   * Перейти к сообщению (поиск, цитата): если его ещё нет на экране —
   * подгружаем историю, пока не найдётся; затем прокручиваем и подсвечиваем.
   */
  const jumpTo = async (messageId: string) => {
    const roomId = activeId;
    if (!roomId) return;
    for (let i = 0; i < 40; i++) {
      const cur = qc.getQueryData<ChatMessage[]>(keys.chat.room(roomId)) ?? [];
      if (cur.some((m) => m.id === messageId)) break;
      if (!(await loadOlder(false))) break;
    }
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;
      if (!el) {
        toast(t('chat.jumpMissing'), 'info');
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlashId(messageId);
      window.setTimeout(() => setFlashId((cur) => (cur === messageId ? null : cur)), 1800);
    });
  };

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
  });
  const users = usersQuery.data ?? [];

  // Telegram-style realtime — все через setQueryData (ноль HTTP round-trip).
  useRealtimeEvent('chat:reaction', (data: any) => {
    // data: { roomId, messageId, userId, emoji, action: 'added'|'removed' }
    qc.setQueryData<ChatMessage[]>(keys.chat.room(data.roomId), (cur) => {
      if (!cur) return cur;
      return cur.map((m) => {
        if (m.id !== data.messageId) return m;
        const reactions = m.reactions || [];
        if (data.action === 'added') {
          // Не добавлять дубль, если уже есть (мы могли локально добавить в optimistic).
          if (reactions.some((r) => r.userId === data.userId && r.emoji === data.emoji)) return m;
          return {
            ...m,
            reactions: [...reactions, {
              id: `tmp-react-${data.userId}-${data.emoji}`,
              userId: data.userId,
              emoji: data.emoji,
            }],
          };
        }
        // removed
        return {
          ...m,
          reactions: reactions.filter((r) => !(r.userId === data.userId && r.emoji === data.emoji)),
        };
      });
    });
  });
  // Удалили одно или несколько сообщений (messageIds), у всех сразу.
  // Удалённые исчезают у всех совсем, без строки «сообщение удалено» (как в Telegram).
  const markDeleted = (roomId: string, ids: string[]) => {
    const gone = new Set(ids);
    qc.setQueryData<ChatMessage[]>(keys.chat.room(roomId), (cur) => cur?.filter((m) => !gone.has(m.id)));
    // Удалили последнее — в списке чатов должно стать видно предыдущее.
    const rooms_ = qc.getQueryData<ChatRoom[]>(keys.chat.rooms());
    if (rooms_?.some((r) => r.id === roomId && r.messages?.[0] && gone.has(r.messages[0].id))) {
      qc.invalidateQueries({ queryKey: keys.chat.rooms() });
    }
    setSelected((sel) => (sel ? sel.filter((id) => !gone.has(id)) : sel));
    // Открыто меню у сообщения, которое только что удалили, — закрываем.
    setContextMenu((cm) => (cm && gone.has(cm.msg.id) ? null : cm));
  };
  useRealtimeEvent('chat:message:deleted', (data: any) => {
    markDeleted(data.roomId, Array.isArray(data.messageIds) ? data.messageIds : [data.messageId]);
  });
  // Автор изменил сообщение — у всех обновляется текст и пометка «изменено».
  const applyEdit = (roomId: string, messageId: string, patchMsg: Partial<ChatMessage>) => {
    qc.setQueryData<ChatMessage[]>(keys.chat.room(roomId), (cur) => cur?.map((m) => (m.id === messageId ? { ...m, ...patchMsg } : m)));
    qc.setQueryData<ChatRoom[]>(keys.chat.rooms(), (cur) => cur?.map((r) => r.id === roomId && r.messages?.[0]?.id === messageId
      ? { ...r, messages: [{ ...r.messages[0], ...patchMsg }] }
      : r));
  };
  useRealtimeEvent('chat:message:edited', (data: any) => {
    applyEdit(data.roomId, data.messageId, { text: data.text, editedAt: data.editedAt, mentionsIds: data.mentionsIds });
  });
  // Чат удалили (у меня или у всех) или я вышел из команды — убираем из списка.
  const dropRoom = (roomId: string) => {
    qc.setQueryData<ChatRoom[]>(keys.chat.rooms(), (cur) => cur?.filter((r) => r.id !== roomId));
    qc.removeQueries({ queryKey: keys.chat.room(roomId) });
    if (activeId === roomId) {
      setActiveId(null);
      setSelected(null);
      setEditing(null);
      setMsgSearch(null);
      setShowMembers(false);
      setMobileShowList(true);
    }
  };
  useRealtimeEvent('chat:room:removed', (data: any) => {
    if (data?.roomId) dropRoom(data.roomId);
  });
  // «В сети / был(а) …» в списке участников и в шапке личного чата.
  useRealtimeEvent('chat:presence', (data: any) => {
    qc.setQueriesData<ChatRoomMember[]>({ queryKey: ['chat', 'members'] }, (cur) => cur?.map((u) => (u.id === data.userId
      ? { ...u, online: !!data.online, lastSeenAt: data.lastSeenAt ?? u.lastSeenAt }
      : u)));
  });
  useRealtimeEvent('chat:message:pin', (data: any) => {
    qc.setQueryData<ChatMessage[]>(keys.chat.room(data.roomId), (cur) => {
      if (!cur) return cur;
      return cur.map((m) => m.id === data.messageId ? { ...m, isPinned: data.isPinned } : m);
    });
  });
  useRealtimeEvent('chat:read', (data: any) => {
    // data: { roomId, userId, lastReadAt } — обновляем member в roomsKey.
    // Открыто меню «Прочитали» — список обновится сразу.
    qc.invalidateQueries({ queryKey: ['chat', 'reads'] });
    qc.setQueryData<ChatRoom[]>(roomsKey, (cur) => {
      if (!cur) return cur;
      return cur.map((r) => {
        if (r.id !== data.roomId) return r;
        return {
          ...r,
          members: (r.members || []).map((m) =>
            m.userId === data.userId ? { ...m, lastReadAt: data.lastReadAt } : m,
          ),
        };
      });
    });
  });
  useRealtimeEvent('chat:typing', (data: any) => {
    // Игнорируем своё собственное событие. Двойная защита:
    // 1) по userId (основной фильтр)
    // 2) по userName (если userId mismatch из-за token-refresh, всё ещё
    //    не покажем "Я печатаю" в собственном окне)
    if (data.userId === me?.id) return;
    if (me?.fullName && data.userName === me.fullName) return;
    setTypingByRoom((cur) => {
      const room = { ...(cur[data.roomId] || {}) };
      if (data.typing) {
        room[data.userId] = { name: data.userName || t('chat.someone'), expiresAt: Date.now() + 5000 };
      } else {
        delete room[data.userId];
      }
      return { ...cur, [data.roomId]: room };
    });
  });

  // При возврате tab'а в фокус — помечаем активную комнату прочитанной.
  useEffect(() => {
    const onFocus = () => {
      if (activeId && typeof document !== 'undefined' && !document.hidden) {
        markRoomRead(activeId).catch(() => undefined);
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [activeId]);

  // Auto-expire: каждые 1.5 сек выкидываем устаревшие записи.
  useEffect(() => {
    const tid = window.setInterval(() => {
      setTypingByRoom((cur) => {
        const now = Date.now();
        let changed = false;
        const next: typeof cur = {};
        for (const [rid, users] of Object.entries(cur)) {
          const filteredEntries = Object.entries(users).filter(([, u]) => u.expiresAt > now);
          if (filteredEntries.length !== Object.keys(users).length) changed = true;
          if (filteredEntries.length) next[rid] = Object.fromEntries(filteredEntries);
        }
        return changed ? next : cur;
      });
    }, 1500);
    return () => window.clearInterval(tid);
  }, []);

  // Когда от собеседника пришло сообщение — он точно перестал печатать.
  // И если этот чат сейчас активен — сразу шлём read-ack (для ✓✓).
  useRealtimeEvent('chat:message', (data: any) => {
    if (data?.message?.authorId) {
      setTypingByRoom((cur) => {
        const room = cur[data.roomId];
        if (!room || !room[data.message.authorId]) return cur;
        const next = { ...room };
        delete next[data.message.authorId];
        return { ...cur, [data.roomId]: next };
      });
    }
    if (
      activeId &&
      data?.roomId === activeId &&
      data?.message?.authorId !== me?.id &&
      typeof document !== 'undefined' && !document.hidden
    ) {
      markRoomRead(activeId).catch(() => undefined);
    }
  });

  // QA-fix #5: Realtime + optimistic дублировали сообщения.
  // Поток ДО: 1) optimistic.append(tempMsg) 2) сервер вернул real msg
  //          3) socket 'chat:message' тоже вернул real msg → доп.копия
  //          4) invalidate refetch — finally чистит, но user видит дубль.
  // Поток ПОСЛЕ:
  //   - Если приходит чужое сообщение — append.
  //   - Если приходит МОЁ — заменяем последний tmp-сообщение того же текста
  //     на серверную версию (или просто игнорируем, если нет tmp-копии).
  //   - Дополнительно фильтруем по id, чтобы не было точных дублей.
  useRealtimeEvent('chat:message', (data: any) => {
    // QA-fix: обновляем кеш для ЛЮБОЙ комнаты, не только активной — чтобы
    // при переключении не было лишнего запроса к серверу. И через setQueryData
    // вместо invalidate — мгновенно, без HTTP round-trip.
    const targetKey = keys.chat.room(data.roomId);
    qc.setQueryData<ChatMessage[]>(targetKey, (cur) => {
      const list = cur ?? [];
      if (list.some((m) => m.id === data.message.id)) return list;
      // Моё сообщение — заменяем черновик: по метке clientId, иначе по тексту.
      if (me?.id && data.message.authorId === me.id) {
        const tmpIdx = data.clientId
          ? list.findIndex((m) => m.id === data.clientId)
          : list.findIndex((m) => m.id.startsWith('tmp-') && m.text === data.message.text);
        if (tmpIdx >= 0) {
          stableKeyRef.current.set(data.message.id, list[tmpIdx].id);
          draftsRef.current.delete(list[tmpIdx].id);
          const next = list.slice();
          next[tmpIdx] = data.message;
          return next;
        }
      }
      return [...list, data.message];
    });
    // Чата нет в списке (он был «удалён у себя» или новый) — перечитываем список.
    const known = qc.getQueryData<ChatRoom[]>(roomsKey);
    if (known && !known.some((r) => r.id === data.roomId)) qc.invalidateQueries({ queryKey: roomsKey });
    // Bump room в roomsKey локально (без refetch) — чтобы preview обновился.
    qc.setQueryData<ChatRoom[]>(roomsKey, (cur) => {
      if (!cur) return cur;
      return cur.map((r) => r.id === data.roomId
        ? { ...r, updatedAt: data.message.createdAt, messages: [data.message, ...(r.messages || []).slice(0, 0)] }
        : r,
      );
    });
    // Непрочитанные считает lib/chatUnread (одно место на всё приложение).
  });

  // Новый чат (создал собеседник) — появляется в списке сразу.
  useRealtimeEvent('chat:room', () => {
    qc.invalidateQueries({ queryKey: roomsKey });
  });

  /**
   * Прокрутка как в Telegram:
   *  - открыл чат — сразу внизу;
   *  - подгрузилась история сверху — экран не прыгает;
   *  - пришло новое: я внизу или это моё — едем вниз, иначе растёт счётчик
   *    на кнопке «вниз» (читающего историю не дёргаем).
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const seen = lastSeenRef.current;
    const last = messages[messages.length - 1];
    if (seen.roomId !== activeId) {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setNewBelow(0);
      setShowDown(false);
    } else if (scrollRestoreRef.current) {
      const { height, top } = scrollRestoreRef.current;
      el.scrollTop = top + (el.scrollHeight - height);
      scrollRestoreRef.current = null;
    } else if (last && last.id !== seen.lastId && last.createdAt >= seen.lastAt) {
      // (последнее удалили — внизу стало более старое: это не «новое»)
      const mineLast = last.authorId === me?.id && !last.mentionsIds?.includes('__BOT__');
      if (atBottomRef.current || mineLast) {
        el.scrollTop = el.scrollHeight;
        setNewBelow(0);
      } else if (!(seen.lastId && isDraft(last))) {
        setNewBelow((n) => n + 1);
      }
    }
    lastSeenRef.current = { roomId: activeId, lastId: last?.id ?? null, lastAt: last?.createdAt ?? '' };
  }, [messages, activeId]);

  // Поле ввода растёт вместе с текстом (до ~6 строк), как в Telegram.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [input]);

  const onThreadScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = fromBottom < 80;
    setShowDown(fromBottom > 300);
    if (fromBottom < 80) setNewBelow(0);
    if (el.scrollTop < 150) void loadOlder();
  };
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setNewBelow(0);
  };

  // Появился пузырь «печатает…» — показываем его, если человек и так внизу
  // переписки (читающего историю выше не дёргаем).
  const typingCount = activeId ? Object.keys(typingByRoom[activeId] || {}).length : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !typingCount) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [typingCount]);

  // SEND — оптимистично добавляем сообщение мгновенно с tempId.
  // На invalidate реальное сообщение из сервера приедет с настоящим id.
  // Текст — через сокет (мгновенно у собеседника), файлы — обычной загрузкой.
  // Ответ сервера сразу заменяет черновик: у автора галочка появляется без
  // перечитывания чата.
  const sendMut = useMutation({
    mutationFn: ({ roomId, text, files, replyToId, clientId }: {
      roomId: string; text: string; files?: File[]; replyToId?: string; clientId: string;
    }) => (files && files.length
      ? sendChatMessage(roomId, text, { files, replyToId, clientId })
      : sendChatMessageLive(roomId, text, { replyToId, clientId })),
    onSuccess: (msg, vars) => {
      draftsRef.current.delete(vars.clientId);
      stableKeyRef.current.set(msg.id, vars.clientId);
      qc.setQueryData<ChatMessage[]>(keys.chat.room(vars.roomId), (cur) => {
        const list = cur ?? [];
        if (list.some((m) => m.id === msg.id)) return list.filter((m) => m.id !== vars.clientId);
        return list.map((m) => (m.id === vars.clientId ? msg : m));
      });
    },
    // Не ушло — сообщение остаётся в переписке с красной пометкой и «Повторить»
    // (как в Telegram), текст не теряется.
    onError: (e: any, vars) => {
      qc.setQueryData<Draft[]>(keys.chat.room(vars.roomId), (cur) => (cur ?? []).map((m) => (m.id === vars.clientId ? { ...m, failed: true } : m)));
      toast(e?.response?.data?.message || e?.userMessage || t('chat.sendError'), 'error');
    },
  });
  const retrySend = (m: Draft) => {
    const d = draftsRef.current.get(m.id);
    if (!d) return;
    qc.setQueryData<Draft[]>(keys.chat.room(d.roomId), (cur) => (cur ?? []).map((x) => (x.id === m.id ? { ...x, failed: false } : x)));
    sendMut.mutate({ roomId: d.roomId, text: d.text, files: d.files, replyToId: d.replyToId, clientId: m.id });
  };
  const dropDraft = (m: Draft) => {
    draftsRef.current.delete(m.id);
    qc.setQueryData<Draft[]>(keys.chat.room(m.roomId), (cur) => (cur ?? []).filter((x) => x.id !== m.id));
  };

  // QA-fix: реакции — полностью оптимистичные. При клике сразу меняем
  // m.reactions в кеше (toggle по userId+emoji), сервер вызываем в фоне.
  // При ошибке — откатываем (server emit chat:reaction исправит state).
  const reactMut = useOptimisticMutation<unknown, { messageId: string; emoji: string }, ChatMessage[]>({
    mutationFn: ({ messageId, emoji }) => reactToMessage(messageId, emoji),
    queryKey: messagesKey,
    applyOptimistic: (cur, { messageId, emoji }) => {
      if (!cur || !me?.id) return cur;
      return cur.map((m) => {
        if (m.id !== messageId) return m;
        const reactions = m.reactions || [];
        const myExisting = reactions.find((r) => r.userId === me.id && r.emoji === emoji);
        if (myExisting) {
          // toggle off — убираем мою реакцию
          return { ...m, reactions: reactions.filter((r) => !(r.userId === me.id && r.emoji === emoji)) };
        }
        // toggle on
        return {
          ...m,
          reactions: [...reactions, { id: `tmp-react-${me.id}-${emoji}`, userId: me.id, emoji }],
        };
      });
    },
    // Не invalidate — socket-event chat:reaction уже обновит state
    // у всех остальных, а у нас локально уже применено.
  });

  // Удаление (одно или несколько) — сразу у себя, сервер разошлёт остальным.
  const deleteMut = useOptimisticMutation<unknown, { ids: string[] }, ChatMessage[]>({
    mutationFn: ({ ids }) => (ids.length === 1 ? deleteChatMessage(ids[0]) : deleteChatMessages(ids)),
    onError: (e: any) => toast(e?.response?.data?.message || t('chat.room.deleteError'), 'error'),
    queryKey: messagesKey,
    applyOptimistic: (cur, { ids }) => {
      if (!cur) return cur;
      const gone = new Set(ids);
      return cur.filter((m) => !gone.has(m.id));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.chat.rooms() }),
  });
  // Правка — сразу у себя, пометка «изменено».
  const editMut = useOptimisticMutation<unknown, { messageId: string; text: string }, ChatMessage[]>({
    mutationFn: ({ messageId, text }) => editChatMessage(messageId, text),
    queryKey: messagesKey,
    applyOptimistic: (cur, { messageId, text }) => cur?.map((m) => (m.id === messageId
      ? { ...m, text, editedAt: new Date().toISOString() }
      : m)),
  });

  /** Админ этого чата: основатель — везде, в команде — ещё её создатель. */
  const isChatAdmin = (room?: ChatRoom | null) =>
    !!room && (isFounder(me) || (room.type === 'TEAM' && !!room.createdById && room.createdById === me?.id));
  /** Своё — удаляет каждый, чужое — только админ чата. */
  const canDelete = (m: Draft, room?: ChatRoom | null) =>
    !m.deletedAt && !isDraft(m) && (m.authorId === me?.id || isChatAdmin(room));
  const canEdit = (m: Draft) =>
    !m.deletedAt && !isDraft(m) && m.authorId === me?.id && !m.mentionsIds?.includes('__BOT__');
  const canPin = (room?: ChatRoom | null) => !!room && (room.type === 'DIRECT' || isChatAdmin(room));

  const askDelete = async (ids: string[]) => {
    if (!ids.length) return;
    const ok = await confirm({
      title: ids.length === 1 ? t('chat.del.oneTitle') : t('chat.del.manyTitle').replace('{n}', String(ids.length)),
      message: t('chat.del.text'),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate({ ids });
    setSelected(null);
  };

  const startEdit = (m: ChatMessage) => {
    setReplyTo(null);
    setPendingFiles([]);
    setEditing(m);
    setInput(m.text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  };
  const cancelEdit = () => {
    setEditing(null);
    setInput('');
  };

  // QA-fix: pin/unpin — оптимистично переключаем флаг сразу.
  const pinMut = useOptimisticMutation<unknown, { messageId: string }, ChatMessage[]>({
    mutationFn: ({ messageId }) => pinChatMessage(messageId),
    queryKey: messagesKey,
    applyOptimistic: (cur, { messageId }) => {
      if (!cur) return cur;
      return cur.map((m) => m.id === messageId ? { ...m, isPinned: !m.isPinned } : m);
    },
  });

  // Forward — без оптимистики (сообщение появляется в ДРУГОЙ комнате,
  // которую обработает socket chat:message event). Просто шлём на сервер.
  // Несколько выбранных — по очереди, в порядке переписки.
  const forwardMut = useInvalidatingMutation({
    mutationFn: async ({ messageIds, targetRoomId }: { messageIds: string[]; targetRoomId: string }) => {
      for (const id of messageIds) await forwardChatMessage(id, targetRoomId);
    },
    invalidate: [keys.chat.all],
    onSuccess: () => toast(t('chat.forwarded'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('chat.forwardError'), 'error'),
  });

  const send = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (mention) return; // если открыт picker — Enter выбирает, а не отправляет
    if (!activeId) return;
    const text = input.trim();
    if (editing) {
      // Правка: пусто можно только у сообщения с вложениями; без изменений — просто выходим.
      if (!text && !editing.attachments?.length) return;
      if (text !== editing.text) editMut.mutate({ messageId: editing.id, text });
      cancelEdit();
      return;
    }
    if (!text && pendingFiles.length === 0) return;
    // 1) optimistic add — для текста и attachments-превью
    const optimisticAttachments: ChatAttachment[] = pendingFiles.map((f) => ({
      url: URL.createObjectURL(f),
      filename: f.name,
      originalName: f.name,
      mimeType: f.type || 'application/octet-stream',
      size: f.size,
    }));
    const clientId = tempId();
    const optimisticMsg: ChatMessage = {
      id: clientId,
      roomId: activeId,
      authorId: me?.id || '',
      author: me ? { id: me.id, fullName: me.fullName, role: me.role } : undefined,
      text,
      mentionsIds: [],
      createdAt: new Date().toISOString(),
      editedAt: null,
      attachments: optimisticAttachments.length ? optimisticAttachments : null,
      replyToId: replyTo?.id || null,
      replyTo: replyTo
        ? { id: replyTo.id, text: replyTo.text, authorId: replyTo.authorId, attachments: replyTo.attachments, author: replyTo.author }
        : null,
      reactions: [],
    };
    qc.setQueryData<ChatMessage[]>(messagesKey, (cur) => optimistic.append(cur, optimisticMsg));
    const filesCopy = pendingFiles.slice();
    const replyId = replyTo?.id;
    draftsRef.current.set(clientId, { roomId: activeId, text, files: filesCopy, replyToId: replyId });
    setInput('');
    setMention(null);
    setPendingFiles([]);
    setReplyTo(null);
    // 2) actually send
    sendMut.mutate({ roomId: activeId, text, files: filesCopy, replyToId: replyId, clientId });
    // 3) сразу шлём typing:false чтобы у собеседника убрался индикатор
    if (typingPingRef.current.idleTimer) {
      window.clearTimeout(typingPingRef.current.idleTimer);
      typingPingRef.current.idleTimer = null;
    }
    typingPingRef.current.lastPingAt = 0;
    sendTyping(activeId, false);
  };

  const addFiles = (files: File[]) => {
    if (!files.length || editing) return;
    setPendingFiles((prev) => [...prev, ...files].slice(0, 10));
  };
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []));
    e.target.value = '';
  };
  // Скриншот из буфера (Ctrl+V) — во вложения, как в Telegram.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    // У вставленного скриншота имя «image.png» — даём понятное.
    addFiles(files.map((f) => (f.name === 'image.png' && f.type.startsWith('image/')
      ? new File([f], `screenshot-${Date.now()}.png`, { type: f.type })
      : f)));
  };
  // Перетаскивание файлов мышью в переписку.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e) || editing) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (!dragDepthRef.current) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    addFiles(Array.from(e.dataTransfer.files || []));
    inputRef.current?.focus();
  };

  // ============ МЕНЮ ЧАТА В СПИСКЕ ============
  // Компьютер — правая кнопка мыши; телефон/планшет — удержание 1 секунду.
  const openRoomMenu = (x: number, y: number, room: ChatRoom) => {
    setContextMenu(null);
    setRoomMenu({ x, y, room });
  };
  const onRoomPointerDown = (e: React.PointerEvent, room: ChatRoom) => {
    const lp = longPressRef.current;
    lp.touch = e.pointerType !== 'mouse';
    lp.fired = false;
    if (!lp.touch) return;
    const { clientX, clientY } = e;
    if (lp.timer) window.clearTimeout(lp.timer);
    lp.timer = window.setTimeout(() => {
      lp.fired = true;
      lp.timer = null;
      if (navigator.vibrate) navigator.vibrate(30);
      openRoomMenu(clientX, clientY, room);
    }, 1000);
  };
  const cancelLongPress = () => {
    const lp = longPressRef.current;
    if (lp.timer) { window.clearTimeout(lp.timer); lp.timer = null; }
  };
  const onRoomContextMenu = (e: React.MouseEvent, room: ChatRoom) => {
    e.preventDefault();
    // На сенсорном экране браузер сам шлёт contextmenu через ~0.5 с —
    // ждём своей секунды (таймер выше).
    if (longPressRef.current.touch) return;
    openRoomMenu(e.clientX, e.clientY, room);
  };
  useEffect(() => {
    if (!roomMenu) return;
    const close = () => setRoomMenu(null);
    window.addEventListener('click', close);
    // Закрываем, когда человек сам крутит (колесо/палец). На 'scroll' — нельзя:
    // пришло новое сообщение, лента сама съехала вниз — и меню бы закрылось.
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('touchmove', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('touchmove', close);
      window.removeEventListener('resize', close);
    };
  }, [roomMenu]);

  const roomDeleteMut = useMutation({
    mutationFn: ({ room, forAll }: { room: ChatRoom; forAll: boolean }) => deleteChatRoom(room.id, forAll),
    onMutate: ({ room }) => dropRoom(room.id),
    onSuccess: (_d, { room }) => toast(room.type === 'TEAM' ? t('chat.room.teamDeleted') : t('chat.room.deleted'), 'success'),
    onError: (e: any) => {
      toast(e?.response?.data?.message || t('chat.room.deleteError'), 'error');
      qc.invalidateQueries({ queryKey: roomsKey });
    },
  });
  const roomLeaveMut = useMutation({
    mutationFn: (room: ChatRoom) => leaveChatRoom(room.id),
    onMutate: (room) => dropRoom(room.id),
    onSuccess: () => toast(t('chat.room.left'), 'success'),
    onError: (e: any) => {
      toast(e?.response?.data?.message || t('chat.room.deleteError'), 'error');
      qc.invalidateQueries({ queryKey: roomsKey });
    },
  });
  const askDeleteTeam = async (room: ChatRoom) => {
    const ok = await confirm({
      title: t('chat.room.deleteTeamTitle'),
      message: t('chat.room.deleteTeamText').replace('{name}', room.title || t('chat.team')),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (ok) roomDeleteMut.mutate({ room, forAll: true });
  };
  const askLeaveTeam = async (room: ChatRoom) => {
    const ok = await confirm({
      title: t('chat.room.leaveTitle'),
      message: t('chat.room.leaveText').replace('{name}', room.title || t('chat.team')),
      confirmText: t('chat.room.leave'),
      danger: true,
    });
    if (ok) roomLeaveMut.mutate(room);
  };

  // ============ ПОИСК ПО ПЕРЕПИСКЕ ============
  useEffect(() => {
    if (!msgSearch || !activeId) return;
    const q = msgSearch.q.trim();
    if (q.length < 2) {
      if (msgSearch.hits.length || msgSearch.loading) setMsgSearch((s) => (s ? { ...s, hits: [], idx: 0, loading: false } : s));
      return;
    }
    const roomId = activeId;
    const tid = window.setTimeout(() => {
      setMsgSearch((s) => (s ? { ...s, loading: true } : s));
      searchChatMessages(roomId, q)
        .then((hits) => {
          setMsgSearch((s) => (s && s.q.trim() === q ? { ...s, hits, idx: 0, loading: false } : s));
          if (hits[0]) void jumpTo(hits[0].id);
        })
        .catch(() => setMsgSearch((s) => (s ? { ...s, loading: false } : s)));
    }, 350);
    return () => window.clearTimeout(tid);
  }, [msgSearch?.q, activeId]);
  const stepSearch = (dir: 1 | -1) => {
    if (!msgSearch?.hits.length) return;
    const idx = (msgSearch.idx + dir + msgSearch.hits.length) % msgSearch.hits.length;
    setMsgSearch({ ...msgSearch, idx });
    void jumpTo(msgSearch.hits[idx].id);
  };

  // Сменили чат — выходим из выбора, правки и поиска.
  useEffect(() => {
    setSelected(null);
    setEditing(null);
    setMsgSearch(null);
    setShowMembers(false);
  }, [activeId]);

  // Esc: сначала меню и окна, потом выбор / правка / поиск.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (contextMenu) setContextMenu(null);
      else if (roomMenu) setRoomMenu(null);
      else if (showMembers) setShowMembers(false);
      else if (selected) setSelected(null);
      else if (editing) cancelEdit();
      else if (msgSearch) setMsgSearch(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextMenu, roomMenu, showMembers, selected, editing, msgSearch]);

  const toggleSelect = (id: string) =>
    setSelected((sel) => (sel ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id]));
  const removePendingFile = (i: number) => {
    setPendingFiles((prev) => prev.filter((_, idx) => idx !== i));
  };

  const copyText = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const onContextMenu = (e: React.MouseEvent, msg: ChatMessage) => {
    e.preventDefault();
    // В режиме выбора правая кнопка / удержание просто отмечает сообщение.
    if (selected) {
      if (!isDraft(msg)) toggleSelect(msg.id);
      return;
    }
    setRoomMenu(null);
    setContextMenu({ x: e.clientX, y: e.clientY, msg });
  };
  // Закрытие context-menu по клику вне
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    // Закрываем, когда человек сам крутит (колесо/палец). На 'scroll' — нельзя:
    // пришло новое сообщение, лента сама съехала вниз — и меню бы закрылось.
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('touchmove', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('touchmove', close);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  // ============ MENTION PICKER ============
  // Отслеживаем '@' в input, открываем dropdown с участниками комнаты.
  // Кандидаты — members активной комнаты (без меня), либо все users если их нет.
  const activeRoom = rooms.find((r) => r.id === activeId);
  // Участники открытого чата и кто в сети (обновляется событием chat:presence).
  const membersQuery = useQuery({
    queryKey: activeId ? keys.chat.members(activeId) : ['chat', 'members', null],
    queryFn: () => getChatRoomMembers(activeId!),
    enabled: !!activeId,
    staleTime: 60_000,
  });
  const roomMembers = membersQuery.data ?? [];
  const directPeer = activeRoom?.type === 'DIRECT' ? roomMembers.find((u) => u.id !== me?.id) : undefined;
  const onlineCount = activeRoom?.type !== 'DIRECT' ? roomMembers.filter((u) => u.online).length : 0;
  // «был(а) N мин назад» стареет — перерисовываемся раз в минуту.
  const [, setMinuteTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setMinuteTick((x) => x + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const mentionCandidates = (() => {
    if (!mention) return [];
    const memberUsers = activeRoom?.members
      ?.map((m) => m.user)
      .filter((u): u is NonNullable<typeof u> => !!u && u.id !== me?.id) ?? [];
    const pool = memberUsers.length ? memberUsers : users.filter((u: any) => u.id !== me?.id);
    const q = mention.query.toLowerCase();
    if (!q) return pool.slice(0, 8);
    return pool
      .filter((u: any) => u.fullName?.toLowerCase().includes(q) || u.email?.toLowerCase().startsWith(q))
      .slice(0, 8);
  })();

  // Throttled typing-ping: при каждом нажатии шлём не чаще раза в 3 сек.
  // При паузе > 3 сек — отправляем typing:false.
  const triggerTyping = (text: string) => {
    if (!activeId) return;
    const now = Date.now();
    if (text && now - typingPingRef.current.lastPingAt > 3000) {
      typingPingRef.current.lastPingAt = now;
      sendTyping(activeId, true);
    }
    if (typingPingRef.current.idleTimer) {
      window.clearTimeout(typingPingRef.current.idleTimer);
    }
    if (!text) {
      // input пустой — сразу шлём false
      typingPingRef.current.lastPingAt = 0;
      sendTyping(activeId, false);
      return;
    }
    typingPingRef.current.idleTimer = window.setTimeout(() => {
      if (activeId) sendTyping(activeId, false);
      typingPingRef.current.lastPingAt = 0;
    }, 3500);
  };

  // При изменении input ищем '@' непосредственно перед курсором.
  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setInput(v);
    triggerTyping(v);
    const pos = e.target.selectionStart ?? v.length;
    // Ищем последний '@' до курсора, который начинает «слово».
    const before = v.slice(0, pos);
    const m = before.match(/(?:^|\s)@([\wа-яА-ЯёЁ.\-]*)$/);
    if (m) {
      setMention({ query: m[1], start: pos - m[1].length - 1 }); // позиция '@'
      setMentionIdx(0);
    } else {
      setMention(null);
    }
  };

  const insertMention = (user: { id: string; fullName: string }) => {
    if (!mention || !inputRef.current) return;
    // Заменяем '@<query>' на '@firstname-lastname '
    const handle = '@' + user.fullName.toLowerCase().replace(/\s+/g, '-');
    const before = input.slice(0, mention.start);
    const afterStart = mention.start + 1 + mention.query.length;
    const after = input.slice(afterStart);
    const newVal = before + handle + ' ' + after;
    setInput(newVal);
    setMention(null);
    // Возвращаем фокус и курсор после вставленного handle.
    queueMicrotask(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        const caret = before.length + handle.length + 1;
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mention || mentionCandidates.length === 0) {
      // Enter — отправить, Shift+Enter — новая строка (как в Telegram).
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send();
      } else if (e.key === 'Escape' && editing) {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === 'ArrowUp' && !input && !editing) {
        // ↑ в пустом поле — править своё последнее сообщение.
        const mineLast = [...messages].reverse().find((m) => canEdit(m) && m.text);
        if (mineLast) { e.preventDefault(); startEdit(mineLast); }
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMentionIdx((i) => (i + 1) % mentionCandidates.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMentionIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertMention(mentionCandidates[mentionIdx] as any);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setMention(null);
    }
  };

  const directMut = useInvalidatingMutation({
    mutationFn: createDirectRoom,
    invalidate: [keys.chat.rooms()],
    onSuccess: (room: any) => {
      setShowNewDirect(false);
      setActiveId(room.id);
    },
  });
  const startDirect = (userId: string) => directMut.mutate(userId);

  return (
    <>
      {/* Размер — в CSS (.chat-card): чат занимает всё место под шапкой. */}
      <div className={`card chat-card${mobileShowList ? ' show-list' : ' show-thread'}`}>
        {/* Sidebar — список чатов */}
        <div className="chat-rooms-pane" style={{
          borderRight: '1px solid var(--border-soft)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '20px 18px',
            borderBottom: '1px solid var(--border-soft)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.12em',
              color: 'var(--text-soft)',
              textTransform: 'uppercase',
            }}>{t('chat.title')}</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => { setShowNewTeam(false); setShowNewDirect((v) => !v); }}
                title={t('chat.newDirect')}
              >
                <Icon name="person_add" size={14} />
              </button>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => { setShowNewDirect(false); setShowNewTeam((v) => !v); }}
                title={t('chat.newTeam')}
              >
                <Icon name="groups" size={14} />
              </button>
            </div>
          </div>

          <div className="chat-rooms-search">
            <Icon name="search" size={16} />
            <input
              value={roomSearch}
              onChange={(e) => setRoomSearch(e.target.value)}
              placeholder={t('chat.searchChats')}
              data-testid="chat-rooms-search"
            />
            {roomSearch && (
              <button type="button" onClick={() => setRoomSearch('')} aria-label={t('common.clear')}>
                <Icon name="close" size={14} />
              </button>
            )}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {/* Telegram-style: чаты сгруппированы по папкам — Общий,
                Команды, Личные. Каждая папка сворачивается. */}
            {(() => {
              const roomTitle = (r: typeof rooms[number]) => {
                const otherMember = r.type === 'DIRECT'
                  ? r.members.find((m) =>
                      (me?.id ? m.userId !== me.id : true)
                      && (me?.fullName ? m.user.fullName !== me.fullName : true),
                    )
                  : null;
                return r.type === 'GENERAL'
                  ? t('chat.general')
                  : r.type === 'DIRECT'
                    ? otherMember?.user.fullName || r.title || t('chat.title')
                    : r.title || t('chat.team');
              };

              const roomPreview = (r: typeof rooms[number]) => {
                const typing = typingByRoom[r.id] && Object.values(typingByRoom[r.id]);
                if (typing && typing.length) {
                  return <span className="chat-room-typing">{t('chat.typingShort')}</span>;
                }
                const last = r.messages?.[0];
                if (!last) return <span className="chat-room-empty">{t('chat.empty')}</span>;
                const body = last.deletedAt
                  ? t('chat.messageDeleted')
                  : last.text || (last.attachments?.length ? `📎 ${t('chat.attachment')}` : '');
                const who = last.authorId === me?.id
                  ? t('chat.you')
                  : r.type !== 'DIRECT'
                    ? last.author?.fullName?.split(' ')[0]
                    : '';
                return (
                  <>
                    {who && <span className="chat-room-who">{who}: </span>}
                    {body}
                  </>
                );
              };
              const roomTime = (iso?: string) => {
                if (!iso) return '';
                return tjDateInput(iso) === tjDateInput(new Date()) ? fmtTime(iso) : fmtDateText(iso, { day: '2-digit', month: '2-digit', timeZone: TJ_TZ });
              };

              const renderRoom = (r: typeof rooms[number]) => {
                const isActive = r.id === activeId;
                const lastMsg = r.messages?.[0];
                const title = roomTitle(r);
                const unread = isActive ? 0 : unreadMap[r.id]?.unread || 0;
                const mentions = isActive ? 0 : unreadMap[r.id]?.mentions || 0;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`chat-room-item${isActive ? ' active' : ''}${unread ? ' has-unread' : ''}`}
                    data-testid="chat-room"
                    data-room-id={r.id}
                    onClick={() => {
                      // Удержание открыло меню — это не выбор чата.
                      if (longPressRef.current.fired) { longPressRef.current.fired = false; return; }
                      setActiveId(r.id);
                      setMobileShowList(false);
                    }}
                    onContextMenu={(e) => onRoomContextMenu(e, r)}
                    onPointerDown={(e) => onRoomPointerDown(e, r)}
                    onPointerUp={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    onPointerMove={(e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) cancelLongPress(); }}
                  >
                    <span
                      className="chat-avatar chat-avatar-lg"
                      style={{ background: r.type === 'GENERAL' ? 'var(--text)' : avatarColor(r.id) }}
                    >
                      {r.type === 'GENERAL' ? '#' : initials(title)}
                    </span>
                    <span className="chat-room-main">
                      <span className="chat-room-top">
                        <span className="chat-room-title">{title}</span>
                        <span className="chat-room-time">{roomTime(lastMsg?.createdAt)}</span>
                      </span>
                      <span className="chat-room-bottom">
                        <span className="chat-room-preview">{roomPreview(r)}</span>
                        {/* Упомянули меня — «@» рядом со счётчиком, как в Telegram. */}
                        {mentions > 0 && (
                          <span className="chat-mention-badge" data-testid="chat-room-mention" title={t('chat.mentionedYou')}>@</span>
                        )}
                        {unread > 0 && (
                          <span className="chat-unread-badge" data-testid="chat-room-unread">{unread > 99 ? '99+' : unread}</span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              };
              // Свежие переписки — сверху (время последнего сообщения).
              const byLast = (a: typeof rooms[number], b: typeof rooms[number]) =>
                new Date(b.messages?.[0]?.createdAt || b.updatedAt).getTime() - new Date(a.messages?.[0]?.createdAt || a.updatedAt).getTime();

              // Поиск по списку — плоский список найденных, без папок.
              const q = roomSearch.trim().toLowerCase();
              if (q) {
                const found = rooms
                  .filter((r) => roomTitle(r).toLowerCase().includes(q))
                  .sort(byLast);
                return found.length
                  ? found.map(renderRoom)
                  : <div className="empty" style={{ padding: 24 }}>{t('chat.searchNothing')}</div>;
              }

              const general = rooms.filter((r) => r.type === 'GENERAL');
              const teams = rooms.filter((r) => r.type === 'TEAM').sort(byLast);
              const directs = rooms.filter((r) => r.type === 'DIRECT').sort(byLast);

              const folders: Array<{ key: string; icon: string; label: string; list: typeof rooms }> = [
                { key: 'GENERAL', icon: 'campaign', label: t('chat.tab.general'), list: general },
                { key: 'TEAM', icon: 'groups', label: t('chat.tab.teams'), list: teams },
                { key: 'DIRECT', icon: 'person', label: t('chat.tab.direct'), list: directs },
              ];

              return folders.map((f) => {
                if (f.list.length === 0) return null;
                const collapsed = collapsedFolders[f.key];
                return (
                  <div key={f.key}>
                    <button
                      onClick={() => setCollapsedFolders((c) => ({ ...c, [f.key]: !c[f.key] }))}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        width: '100%', padding: '10px 18px',
                        background: 'var(--bg-soft)', border: 'none',
                        borderBottom: '1px solid var(--border-soft)',
                        cursor: 'pointer', textAlign: 'left',
                        fontFamily: 'var(--font-mono)', fontSize: 10,
                        letterSpacing: '0.12em', textTransform: 'uppercase',
                        color: 'var(--text-soft)',
                      }}
                    >
                      <Icon name={f.icon} size={14} />
                      <span style={{ flex: 1 }}>{f.label}</span>
                      {(() => {
                        const n = f.list.reduce((sum, r) => sum + (r.id === activeId ? 0 : unreadMap[r.id]?.unread || 0), 0);
                        return n > 0
                          ? <span className="chat-unread-badge">{n > 99 ? '99+' : n}</span>
                          : <span style={{ fontWeight: 700 }}>{f.list.length}</span>;
                      })()}
                      <Icon name={collapsed ? 'expand_more' : 'expand_less'} size={16} />
                    </button>
                    {!collapsed && f.list.map(renderRoom)}
                  </div>
                );
              });
            })()}
          </div>
        </div>

        {/* Messages */}
        <div className="chat-thread-pane" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {activeRoom && (() => {
            const other = activeRoom.type === 'DIRECT'
              ? activeRoom.members.find((m) =>
                  (me?.id ? m.userId !== me.id : true)
                  && (me?.fullName ? m.user.fullName !== me.fullName : true),
                )
              : null;
            const title = activeRoom.type === 'GENERAL'
              ? t('chat.general')
              : activeRoom.type === 'DIRECT'
                ? other?.user.fullName || activeRoom.title || t('chat.title')
                : activeRoom.title || t('chat.team');
            const typers = Object.values(typingByRoom[activeRoom.id] || {}).map((u) => u.name);
            const subtitle = typers.length
              ? (typers.length === 1
                  ? t('chat.typing.one').replace('{a}', activeRoom.type === 'DIRECT' ? '' : typers[0]).trim()
                  : typers.length === 2
                    ? t('chat.typing.two').replace('{a}', typers[0]).replace('{b}', typers[1])
                    : t('chat.typing.many').replace('{n}', String(typers.length)))
              : activeRoom.type === 'DIRECT'
                ? (directPeer
                    ? (directPeer.online ? t('chat.online') : lastSeenLabel(directPeer.lastSeenAt, t))
                    : t('chat.directChat'))
                : `${activeRoom.members.length} ${t('chat.membersCount')}${onlineCount ? `, ${onlineCount} ${t('chat.onlineCount')}` : ''}`;
            // Выбор нескольких сообщений — вместо шапки панель действий.
            if (selected) {
              // Уже удалённые и черновики в пути не мешают кнопке «Удалить».
              const picked = messages.filter((m) => selected.includes(m.id) && !m.deletedAt && !isDraft(m));
              const deletable = picked.length > 0 && picked.every((m) => canDelete(m, activeRoom));
              const forwardable = picked.filter((m) => !m.deletedAt && !isDraft(m));
              return (
                <div className="chat-thread-header chat-select-bar" data-testid="chat-select-bar">
                  <button type="button" className="chat-icon-btn" onClick={() => setSelected(null)} aria-label={t('common.cancel')}>
                    <Icon name="close" size={20} />
                  </button>
                  <div className="chat-select-count" data-testid="chat-select-count">
                    {t('chat.select.count').replace('{n}', String(selected.length))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    disabled={!forwardable.length}
                    onClick={() => setForwardSource(forwardable)}
                    data-testid="chat-select-forward"
                  >
                    <Icon name="forward" size={16} /> {t('chat.menu.forward')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={!deletable}
                    title={!deletable && picked.length ? t('chat.select.cantDelete') : undefined}
                    onClick={() => askDelete(picked.map((m) => m.id))}
                    data-testid="chat-select-delete"
                  >
                    <Icon name="delete" size={16} /> {t('common.delete')}
                  </button>
                </div>
              );
            }
            return (
              <div className="chat-thread-header">
                {/* Mobile: back-кнопка чтобы вернуться к списку чатов */}
                <button
                  type="button"
                  className="chat-back-btn"
                  onClick={() => setMobileShowList(true)}
                  aria-label={t('chat.backToList')}
                >
                  <Icon name="arrow_back" size={22} />
                </button>
                {/* Клик по шапке — участники чата и кто в сети. */}
                <button
                  type="button"
                  className="chat-thread-who"
                  onClick={() => setShowMembers(true)}
                  data-testid="chat-thread-who"
                  title={t('chat.members.open')}
                >
                  <span
                    className={`chat-avatar chat-avatar-lg${directPeer?.online ? ' is-online' : ''}`}
                    style={{ background: activeRoom.type === 'GENERAL' ? 'var(--text)' : avatarColor(activeRoom.id) }}
                  >
                    {activeRoom.type === 'GENERAL' ? '#' : initials(title)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="chat-thread-title">{title}</span>
                    <span
                      className={`chat-thread-sub${typers.length ? ' typing' : ''}${!typers.length && directPeer?.online ? ' online' : ''}`}
                      data-testid="chat-thread-sub"
                    >
                      {typers.length > 0 && (
                        <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
                      )}
                      {subtitle}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="chat-icon-btn"
                  onClick={() => setMsgSearch((s) => (s ? null : { q: '', hits: [], idx: 0, loading: false }))}
                  aria-label={t('chat.searchInChat')}
                  title={t('chat.searchInChat')}
                  data-testid="chat-search-toggle"
                >
                  <Icon name="search" size={20} />
                </button>
              </div>
            );
          })()}

          {activeRoom && msgSearch && (
            <div className="chat-search-bar" data-testid="chat-search-bar">
              <Icon name="search" size={16} />
              <input
                autoFocus
                value={msgSearch.q}
                onChange={(e) => setMsgSearch({ ...msgSearch, q: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
                }}
                placeholder={t('chat.searchInChat')}
                data-testid="chat-search-input"
              />
              <span className="chat-search-count" data-testid="chat-search-count">
                {msgSearch.loading
                  ? '…'
                  : msgSearch.q.trim().length >= 2
                    ? (msgSearch.hits.length
                        ? t('chat.search.pos').replace('{i}', String(msgSearch.idx + 1)).replace('{n}', String(msgSearch.hits.length))
                        : t('chat.searchNothing'))
                    : ''}
              </span>
              {/* Результаты — от новых к старым: «вверх» — к более старому. */}
              <button type="button" className="chat-icon-btn" onClick={() => stepSearch(1)} disabled={!msgSearch.hits.length} aria-label={t('chat.search.older')}>
                <Icon name="keyboard_arrow_up" size={20} />
              </button>
              <button type="button" className="chat-icon-btn" onClick={() => stepSearch(-1)} disabled={!msgSearch.hits.length} aria-label={t('chat.search.newer')}>
                <Icon name="keyboard_arrow_down" size={20} />
              </button>
              <button type="button" className="chat-icon-btn" onClick={() => setMsgSearch(null)} aria-label={t('common.close')}>
                <Icon name="close" size={18} />
              </button>
            </div>
          )}

          <div
            className="chat-thread-wrap"
            onDragEnter={onDragEnter}
            onDragOver={(e) => { if (hasFiles(e) && !editing) e.preventDefault(); }}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
          {dragOver && (
            <div className="chat-drop-overlay" data-testid="chat-drop-overlay">
              <Icon name="upload_file" size={36} />
              <span>{t('chat.dropHere')}</span>
            </div>
          )}
          <div ref={scrollRef} className="chat-thread-body" data-testid="chat-thread-body" onScroll={onThreadScroll}>
            {activeId && hasMore[activeId] && messages.length > 0 && (
              <div className="chat-history-more">{t('chat.loadingOlder')}</div>
            )}
            {messages.length === 0 && (
              <div className="empty" style={{ marginTop: 80 }}>{t('chat.empty')}</div>
            )}
            {messages.map((m, i) => {
              // Bot (__BOT__) — всегда слева; иначе своё — по authorId.
              const isBot = m.mentionsIds?.includes('__BOT__');
              const isMine = !isBot && !!me?.id && m.authorId === me.id;
              const prev = messages[i - 1];
              const next = messages[i + 1];
              const day = tjDateInput(m.createdAt);
              const newDay = !prev || tjDateInput(prev.createdAt) !== day;
              // Подряд идущие сообщения одного автора (в пределах 5 минут и
              // одного дня) — одной группой: имя сверху, аватар и «хвостик» снизу.
              const sameAsPrev = !newDay && !!prev && prev.authorId === m.authorId
                && !!prev.mentionsIds?.includes('__BOT__') === !!isBot
                && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < FIVE_MIN;
              const sameAsNext = !!next && tjDateInput(next.createdAt) === day && next.authorId === m.authorId
                && !!next.mentionsIds?.includes('__BOT__') === !!isBot
                && new Date(next.createdAt).getTime() - new Date(m.createdAt).getTime() < FIVE_MIN;
              const isGroupChat = activeRoom?.type !== 'DIRECT';
              const showName = !isMine && (isGroupChat || isBot) && !sameAsPrev;
              const showAvatarSlot = !isMine && isGroupChat;
              const isMentionedMe = !!me?.id && m.mentionsIds?.includes(me.id);
              const isSelected = !!selected?.includes(m.id);
              const color = isBot ? 'var(--primary)' : avatarColor(m.authorId);
              const dayLabel = day === tjDateInput(new Date())
                ? t('common.today')
                : day === tjDateInput(new Date(Date.now() - 86_400_000))
                  ? t('common.yesterday')
                  : fmtDateText(m.createdAt, {
                      day: 'numeric', month: 'long', timeZone: TJ_TZ,
                      ...(day.slice(0, 4) !== tjDateInput(new Date()).slice(0, 4) ? { year: 'numeric' } : {}),
                    });
              // Галочки: ✓ — отправлено (сразу, без «часиков»), ✓✓ — прочитал хоть кто-то.
              // Не ушло — красный значок, по нему «Повторить».
              const receipt = isMine && !isBot ? (() => {
                if (m.failed) {
                  return (
                    <button
                      type="button"
                      className="chat-receipt failed"
                      title={t('chat.retry')}
                      data-testid="chat-receipt-failed"
                      onClick={(e) => { e.stopPropagation(); retrySend(m); }}
                    >
                      <Icon name="error" size={15} />
                    </button>
                  );
                }
                if (isDraft(m)) {
                  return (
                    <span className="chat-receipt" title={t('chat.delivered')} data-testid="chat-receipt" data-state="sent">
                      <Icon name="done" size={14} />
                    </span>
                  );
                }
                const created = new Date(m.createdAt).getTime();
                const isRead = (activeRoom?.members || []).some((mm) =>
                  mm.userId !== me?.id && mm.lastReadAt && new Date(mm.lastReadAt).getTime() >= created);
                return (
                  <span className={`chat-receipt${isRead ? ' read' : ''}`} title={isRead ? t('chat.read') : t('chat.delivered')} data-testid="chat-receipt" data-state={isRead ? 'read' : 'sent'}>
                    <Icon name={isRead ? 'done_all' : 'done'} size={14} />
                  </span>
                );
              })() : null;
              return (
                <Fragment key={stableKeyRef.current.get(m.id) ?? m.id}>
                  {newDay && <div className="chat-day-sep"><span>{dayLabel}</span></div>}
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.12 }}
                    className={`chat-row${isMine ? ' mine' : ''}${sameAsNext ? ' grouped' : ''}${selected ? ' selecting' : ''}${isSelected ? ' selected' : ''}${flashId === m.id ? ' flash' : ''}`}
                    data-testid="chat-msg"
                    data-msg-id={m.id}
                    data-mine={isMine ? '1' : '0'}
                    onClick={selected && !isDraft(m) ? () => toggleSelect(m.id) : undefined}
                  >
                    {selected && (
                      <span className={`chat-check${isSelected ? ' on' : ''}`} aria-hidden="true">
                        {isSelected && <Icon name="check" size={14} />}
                      </span>
                    )}
                    {showAvatarSlot && (
                      sameAsNext
                        ? <span className="chat-avatar-space" />
                        : <span className="chat-avatar" style={{ background: isBot ? 'linear-gradient(135deg, var(--primary), var(--text))' : color }}>
                            {isBot ? '🤖' : initials(m.author?.fullName || '?')}
                          </span>
                    )}
                    <div className="chat-bubble-wrap">
                      <div
                        onContextMenu={(e) => onContextMenu(e, m)}
                        className={`chat-bubble${isMine ? ' mine' : ''}${isBot ? ' bot' : ''}${m.deletedAt ? ' deleted' : ''}${isMentionedMe && !isMine ? ' mentioned' : ''}${sameAsNext ? '' : ' tail'}`}
                      >
                        {showName && (
                          <div className="chat-bubble-author" style={{ color }}>
                            {isBot ? 'Javonon AI' : m.author?.fullName}
                          </div>
                        )}
                        {m.replyTo && !m.deletedAt && (
                          <div
                            className="chat-bubble-quote"
                            role="button"
                            onClick={(e) => { if (selected || m.replyTo!.deletedAt) return; e.stopPropagation(); void jumpTo(m.replyTo!.id); }}
                          >
                            <div className="chat-bubble-quote-name">{m.replyTo.author?.fullName || t('chat.message')}</div>
                            <div className="chat-bubble-quote-text">
                              {m.replyTo.deletedAt ? t('chat.deletedMessage') : (m.replyTo.text || (m.replyTo.attachments?.length ? `📎 ${t('chat.attachment')}` : ''))}
                            </div>
                          </div>
                        )}
                        {m.forwardedFrom && !m.deletedAt && (
                          <div className="chat-bubble-forward" data-testid="chat-forwarded">
                            <Icon name="forward" size={13} />
                            <span>{t('chat.forwardedFrom')} <b>{m.forwardedFrom.author?.fullName || t('chat.someoneGen')}</b></span>
                          </div>
                        )}
                        {!m.deletedAt && m.attachments && m.attachments.length > 0 && (
                          <div className="chat-bubble-files">
                            {m.attachments.map((a, ai) => {
                              // mimeType иногда приходит как octet-stream — картинку узнаём и по расширению.
                              const nameForExt = (a.originalName || a.filename || '').toLowerCase();
                              const extIsImg = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(nameForExt);
                              const isImg = a.mimeType?.startsWith('image/') || extIsImg;
                              const isVid = a.mimeType?.startsWith('video/');
                              const isAud = a.mimeType?.startsWith('audio/');
                              const url = absFileUrl(a.url);
                              if (isImg) {
                                return (
                                  <img
                                    key={ai}
                                    className="chat-msg-img"
                                    src={url}
                                    alt={a.originalName}
                                    data-testid="chat-img"
                                    onClick={() => setLightbox(url)}
                                  />
                                );
                              }
                              if (isVid) return <video key={ai} src={url} controls className="chat-msg-video" />;
                              if (isAud) return <audio key={ai} src={url} controls style={{ width: '100%', maxWidth: 280 }} />;
                              return (
                                <a key={ai} href={url} target="_blank" rel="noreferrer" className="chat-file-card">
                                  <Icon name="description" size={20} />
                                  <span className="chat-file-card-main">
                                    <span className="chat-file-card-name">{a.originalName}</span>
                                    <span className="chat-file-card-size">{(a.size / 1024).toFixed(1)} {t('finance.kb')}</span>
                                  </span>
                                  <Icon name="download" size={18} style={{ flexShrink: 0 }} />
                                </a>
                              );
                            })}
                          </div>
                        )}
                        {m.deletedAt
                          ? <span>{t('chat.messageDeleted')}</span>
                          : m.text ? <span className="chat-bubble-text">{renderMessageWithMentions(m.text)}</span> : null}
                        <span className="chat-bubble-meta">
                          {m.isPinned && <span title={t('chat.pinned')}>📌</span>}
                          {m.editedAt && !m.deletedAt && <span className="chat-edited" data-testid="chat-edited">{t('chat.edited')}</span>}
                          <span>{fmtTime(m.createdAt)}</span>
                          {receipt}
                        </span>
                      </div>
                      {!m.deletedAt && m.reactions && m.reactions.length > 0 && (
                        <div className="chat-reactions">
                          {Object.entries(
                            m.reactions.reduce((acc: Record<string, { count: number; mine: boolean }>, r) => {
                              if (!acc[r.emoji]) acc[r.emoji] = { count: 0, mine: false };
                              acc[r.emoji].count++;
                              if (r.userId === me?.id) acc[r.emoji].mine = true;
                              return acc;
                            }, {}),
                          ).map(([emoji, { count, mine }]) => (
                            <button
                              key={emoji}
                              type="button"
                              className={`chat-reaction${mine ? ' mine' : ''}`}
                              onClick={() => reactMut.mutate({ messageId: m.id, emoji })}
                            >
                              <span>{emoji}</span>
                              <span className="chat-reaction-count">{count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                </Fragment>
              );
            })}
            {/* «Печатает…» внутри переписки — пузырём, как в Telegram (и в группе, и в личке). */}
            {activeId && typingByRoom[activeId] && Object.keys(typingByRoom[activeId]).length > 0 && (() => {
              const typers = Object.entries(typingByRoom[activeId]);
              const names = typers.map(([, u]) => u.name);
              const label = names.length === 1
                ? t('chat.typing.one').replace('{a}', names[0])
                : names.length === 2
                  ? t('chat.typing.two').replace('{a}', names[0]).replace('{b}', names[1])
                  : t('chat.typing.many').replace('{n}', String(names.length));
              const [firstId, first] = typers[0];
              return (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="chat-row chat-typing-row"
                  data-testid="chat-typing-bubble"
                >
                  {activeRoom?.type !== 'DIRECT' && (
                    <span className="chat-avatar" style={{ background: avatarColor(firstId) }}>{initials(first.name || '?')}</span>
                  )}
                  <div className="chat-bubble tail chat-typing-bubble">
                    <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
                    <span className="chat-typing-text">{label}</span>
                  </div>
                </motion.div>
              );
            })()}
          </div>
          {/* Кнопка «вниз» со счётчиком новых — когда читаешь историю. */}
          <AnimatePresence>
            {activeRoom && (showDown || newBelow > 0) && (
              <motion.button
                type="button"
                className="chat-down-btn"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.12 }}
                onClick={scrollToBottom}
                aria-label={t('chat.toBottom')}
                data-testid="chat-down"
              >
                <Icon name="keyboard_arrow_down" size={24} />
                {newBelow > 0 && <span className="chat-down-count" data-testid="chat-down-count">{newBelow > 99 ? '99+' : newBelow}</span>}
              </motion.button>
            )}
          </AnimatePresence>
          </div>{/* end chat-thread-wrap */}

          {/* chat-composer: справа место под круглую кнопку звонков (она поверх угла экрана). */}
          <form onSubmit={send} className="chat-composer" style={{
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--border-soft)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            position: 'relative',
          }}>
            {/* Правка своего сообщения: вместо ответа — полоса «Редактирование». */}
            {editing && (
              <div className="chat-edit-bar" data-testid="chat-edit-bar">
                <Icon name="edit" size={16} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="chat-edit-bar-title">{t('chat.editing')}</div>
                  <div className="chat-edit-bar-text">{editing.text}</div>
                </div>
                <button type="button" className="chat-icon-btn" onClick={cancelEdit} aria-label={t('common.cancel')}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            )}
            {/* Reply preview bar */}
            {replyTo && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px',
                background: 'var(--primary-soft, rgba(1,54,139,0.08))',
                borderLeft: '3px solid var(--primary, #01368B)',
                borderRadius: 8,
              }}>
                <Icon name="reply" size={16} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary, #01368B)' }}>
                    {t('chat.replyTo')} {replyTo.author?.fullName || ''}
                  </div>
                  <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-soft)' }}>
                    {replyTo.text || (replyTo.attachments?.length ? `📎 ${t('chat.attachment')}` : '')}
                  </div>
                </div>
                <button type="button" onClick={() => setReplyTo(null)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', padding: 4,
                }}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            )}
            {/* Pending files preview */}
            {pendingFiles.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {pendingFiles.map((f, i) => {
                  const isImg = f.type.startsWith('image/');
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', background: 'var(--bg-soft, #f1f5f9)',
                      borderRadius: 8, fontSize: 12, position: 'relative',
                    }}>
                      {isImg ? (
                        <img src={URL.createObjectURL(f)} alt={f.name} style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4 }} />
                      ) : (
                        <Icon name="description" size={18} />
                      )}
                      <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <button
                        type="button"
                        onClick={() => removePendingFile(i)}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--danger)' }}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, position: 'relative' }}>
            {/* Mention picker dropdown */}
            {mention && mentionCandidates.length > 0 && (
              <div style={{
                position: 'absolute',
                bottom: '100%',
                left: 20,
                right: 80,
                marginBottom: 4,
                background: 'white',
                border: '1px solid var(--border)',
                borderRadius: 12,
                boxShadow: '0 12px 32px rgba(0,0,0,0.12)',
                overflow: 'hidden',
                zIndex: 50,
                maxHeight: 280,
                overflowY: 'auto',
              }}>
                <div style={{
                  padding: '8px 12px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  color: 'var(--text-soft)',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid var(--border-soft)',
                }}>
                  {t('chat.mentionHint')}
                </div>
                {mentionCandidates.map((u: any, i: number) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => insertMention(u)}
                    onMouseEnter={() => setMentionIdx(i)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '10px 12px',
                      border: 'none',
                      background: i === mentionIdx ? 'var(--bg-soft, #f5f5f5)' : 'white',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 14,
                    }}
                  >
                    <span style={{
                      width: 28, height: 28, borderRadius: '50%',
                      background: 'var(--primary, #01368B)', color: 'white',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 600,
                    }}>{initials(u.fullName)}</span>
                    <span style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{u.fullName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-soft)' }}>
                        {displayRoleLabel(u as any)}
                      </div>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!editing && <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title={t('chat.attach')}
              style={{
                width: 40, height: 40, borderRadius: '50%',
                background: 'var(--bg-soft, #f1f5f9)',
                border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-soft)',
                flexShrink: 0,
              }}
            >
              <Icon name="attach_file" size={20} />
            </button>}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={onPickFiles}
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar,.7z,.txt"
            />
            {/* Enter — отправить, Shift+Enter — новая строка; Ctrl+V вставляет скриншот. */}
            <textarea
              ref={inputRef}
              className="crm-input chat-input"
              data-testid="chat-input"
              rows={1}
              value={input}
              onChange={onInputChange}
              onKeyDown={onInputKeyDown}
              onPaste={onPaste}
              placeholder={t('chat.placeholder')}
            />
            <button
              type="submit"
              className="chat-send-btn"
              data-testid="chat-send"
              aria-label={editing ? t('common.save') : t('common.send')}
              disabled={editing ? (!input.trim() && !editing.attachments?.length) : (!input.trim() && pendingFiles.length === 0)}
            >
              <Icon name={editing ? 'check' : 'send'} size={18} />
            </button>
            </div>{/* end input row */}
          </form>
        </div>
      </div>

      {/* Lightbox for image preview */}
      <AnimatePresence>
        {lightbox && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setLightbox(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 10000, cursor: 'zoom-out',
            }}
          >
            <img src={lightbox} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain' }} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Context menu (Telegram-style) */}
      <AnimatePresence>
        {contextMenu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.12 }}
            style={{
              position: 'fixed',
              top: Math.max(12, Math.min(contextMenu.y, window.innerHeight - 470)),
              maxHeight: 'calc(100dvh - 24px)',
              overflowY: 'auto',
              left: Math.max(12, Math.min(contextMenu.x, window.innerWidth - 240)),
              background: 'white', borderRadius: 14, padding: 8,
              boxShadow: '0 16px 40px rgba(0,0,0,0.18)',
              zIndex: 9998, minWidth: 220,
              maxWidth: 'calc(100vw - 24px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Quick reactions row */}
            {!contextMenu.msg.deletedAt && !isDraft(contextMenu.msg) && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 6px 8px', borderBottom: '1px solid var(--border-soft)' }}>
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => {
                    reactMut.mutate({ messageId: contextMenu.msg.id, emoji });
                    setContextMenu(null);
                  }}
                  style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontSize: 18, padding: 0,
                    transition: 'transform 0.1s, background 0.15s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1.25)'; (e.currentTarget as HTMLElement).style.background = 'var(--bg-soft, #f1f5f9)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  {emoji}
                </button>
              ))}
            </div>}
            {/* Своё сообщение: кто прочитал и когда. */}
            {contextMenu.msg.authorId === me?.id && !isDraft(contextMenu.msg) && !contextMenu.msg.deletedAt
              && !contextMenu.msg.mentionsIds?.includes('__BOT__') && (
              <MessageReadsInfo messageId={contextMenu.msg.id} direct={activeRoom?.type === 'DIRECT'} />
            )}
            {/* Actions: черновик в пути — только «копировать»; не ушёл — «повторить». */}
            {(() => {
              const cm = contextMenu.msg as Draft;
              const live = !cm.deletedAt && !isDraft(cm);
              return [
                { id: 'retry', icon: 'refresh', label: t('chat.retry'), show: !!cm.failed, onClick: () => retrySend(cm) },
                { id: 'reply', icon: 'reply', label: t('chat.menu.reply'), show: live, onClick: () => { setEditing(null); setReplyTo(cm); inputRef.current?.focus(); } },
                { id: 'edit', icon: 'edit', label: t('chat.menu.edit'), show: canEdit(cm), onClick: () => startEdit(cm) },
                { id: 'pin', icon: 'push_pin', label: cm.isPinned ? t('chat.menu.unpin') : t('chat.menu.pin'), show: live && canPin(activeRoom), onClick: () => pinMut.mutate({ messageId: cm.id }) },
                { id: 'copy', icon: 'content_copy', label: t('chat.menu.copy'), show: !!cm.text && !cm.deletedAt, onClick: () => copyText(cm.text) },
                { id: 'forward', icon: 'forward', label: t('chat.menu.forward'), show: live, onClick: () => setForwardSource([cm]) },
                { id: 'select', icon: 'check_circle', label: t('chat.menu.select'), show: !isDraft(cm), onClick: () => setSelected([cm.id]) },
                { id: 'delete', icon: 'delete', label: t('common.delete'), show: canDelete(cm, activeRoom), onClick: () => askDelete([cm.id]), danger: true },
                { id: 'drop', icon: 'delete', label: t('common.delete'), show: !!cm.failed, onClick: () => dropDraft(cm), danger: true },
              ];
            })().filter((a) => a.show).map((a) => (
              <button
                key={a.id}
                data-testid={`chat-menu-${a.id}`}
                onClick={() => { a.onClick(); setContextMenu(null); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  width: '100%', padding: '10px 12px',
                  border: 'none', background: 'transparent',
                  cursor: 'pointer', textAlign: 'left',
                  borderRadius: 8, fontSize: 14,
                  color: a.danger ? 'var(--danger)' : 'inherit',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = a.danger ? 'rgba(220,38,38,0.08)' : 'var(--bg-soft, #f1f5f9)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <Icon name={a.icon} size={18} />
                {a.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Меню чата в списке: правая кнопка мыши / удержание 1 секунду. */}
      <AnimatePresence>
        {roomMenu && (() => {
          const r = roomMenu.room;
          const admin = isChatAdmin(r);
          const unread = unreadMap[r.id]?.unread || 0;
          const items = [
            { id: 'read', icon: 'mark_chat_read', label: t('chat.room.markRead'), show: unread > 0, onClick: () => { markRoomRead(r.id).catch(() => undefined); } },
            { id: 'delete', icon: 'delete', label: t('chat.room.delete'), show: r.type === 'DIRECT', danger: true, onClick: () => setDeleteDirect(r) },
            { id: 'delete-team', icon: 'delete', label: t('chat.room.deleteTeam'), show: r.type === 'TEAM' && admin, danger: true, onClick: () => askDeleteTeam(r) },
            { id: 'leave', icon: 'logout', label: t('chat.room.leave'), show: r.type === 'TEAM' && !admin, danger: true, onClick: () => askLeaveTeam(r) },
          ].filter((a) => a.show);
          return (
            <motion.div
              className="chat-menu"
              data-testid="chat-room-menu"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.12 }}
              style={{
                top: Math.min(roomMenu.y, window.innerHeight - 60 - items.length * 44),
                left: Math.max(12, Math.min(roomMenu.x, window.innerWidth - 250)),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {items.length === 0 && (
                <div className="chat-menu-note">{t('chat.room.generalNoDelete')}</div>
              )}
              {items.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`chat-menu-item${a.danger ? ' danger' : ''}`}
                  data-testid={`chat-room-menu-${a.id}`}
                  onClick={() => { setRoomMenu(null); a.onClick(); }}
                >
                  <Icon name={a.icon} size={18} />
                  {a.label}
                </button>
              ))}
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* «Удалить чат» (личный) — как в Telegram: галочка «удалить и у собеседника». */}
      <AnimatePresence>
        {deleteDirect && (
          <DeleteDirectDialog
            peerName={deleteDirect.members.find((m) => m.userId !== me?.id)?.user.fullName || deleteDirect.title || ''}
            onCancel={() => setDeleteDirect(null)}
            onConfirm={(forAll) => {
              roomDeleteMut.mutate({ room: deleteDirect, forAll });
              setDeleteDirect(null);
            }}
          />
        )}
      </AnimatePresence>

      {/* Участники чата и кто в сети — по клику на шапку. */}
      <AnimatePresence>
        {showMembers && activeRoom && (
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setShowMembers(false)}
          >
            <motion.div
              className="chat-members-card"
              data-testid="chat-members"
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="chat-members-head">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="chat-members-title">
                    {activeRoom.type === 'DIRECT' ? t('chat.members.direct') : t('chat.members.title')}
                  </div>
                  <div className="chat-members-sub" data-testid="chat-members-sub">
                    {roomMembers.length} {t('chat.membersCount')} · {roomMembers.filter((u) => u.online).length} {t('chat.onlineCount')}
                  </div>
                </div>
                <button type="button" className="chat-icon-btn" onClick={() => setShowMembers(false)} aria-label={t('common.close')}>
                  <Icon name="close" size={20} />
                </button>
              </div>
              <div className="chat-members-list">
                {membersQuery.isLoading && <div className="empty" style={{ padding: 24 }}>{t('common.loading')}</div>}
                {roomMembers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="chat-member-row"
                    data-testid="chat-member"
                    data-online={u.online ? '1' : '0'}
                    disabled={u.id === me?.id}
                    title={u.id === me?.id ? undefined : t('chat.members.write')}
                    onClick={() => {
                      if (u.id === me?.id) return;
                      setShowMembers(false);
                      startDirect(u.id);
                      setMobileShowList(false);
                    }}
                  >
                    <span className={`chat-avatar${u.online ? ' is-online' : ''}`} style={{ background: avatarColor(u.id), alignSelf: 'center' }}>
                      {initials(u.fullName)}
                    </span>
                    <span className="chat-member-main">
                      <span className="chat-member-name">
                        {u.fullName}
                        {u.id === me?.id && <span className="chat-member-you"> ({t('chat.you')})</span>}
                      </span>
                      <span className={`chat-member-status${u.online ? ' online' : ''}`} data-testid="chat-member-status">
                        {u.online ? t('chat.online') : lastSeenLabel(u.lastSeenAt, t)}
                      </span>
                    </span>
                    {u.isAdmin && activeRoom.type !== 'DIRECT' && <span className="chat-member-admin">{t('chat.members.admin')}</span>}
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Forward modal */}
      <AnimatePresence>
        {forwardSource && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setForwardSource(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(8,11,24,0.55)',
              backdropFilter: 'blur(4px)', zIndex: 9999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'white', borderRadius: 20, padding: 28,
                width: 'min(440px, 92vw)', maxHeight: '80vh',
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
              }}
            >
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11,
                letterSpacing: '0.16em', color: 'var(--text-soft)',
                textTransform: 'uppercase', marginBottom: 8,
              }}>{t('eyebrow.forwardMessage')}</div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 18 }}>
                {t('chat.forwardTo')}
              </h3>
              <div style={{ flex: 1, overflowY: 'auto', margin: '-4px -4px 12px' }}>
                {rooms.map((r) => {
                  const title = r.type === 'GENERAL'
                    ? t('chat.general')
                    : r.type === 'DIRECT'
                      ? r.members.find((mm) =>
                          (me?.id ? mm.userId !== me.id : true)
                          && (me?.fullName ? mm.user.fullName !== me.fullName : true),
                        )?.user.fullName || r.title || t('chat.title')
                      : r.title || t('chat.team');
                  return (
                    <button
                      key={r.id}
                      data-testid="chat-forward-target"
                      onClick={() => {
                        const ids = [...forwardSource]
                          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                          .map((m) => m.id);
                        forwardMut.mutate({ messageIds: ids, targetRoomId: r.id });
                        setForwardSource(null);
                        setSelected(null);
                        setActiveId(r.id);
                        setMobileShowList(false);
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        width: '100%', padding: '12px 14px',
                        borderRadius: 12, background: 'transparent', border: 'none',
                        cursor: 'pointer', textAlign: 'left',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-soft, #f1f5f9)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <span style={{
                        width: 36, height: 36, borderRadius: '50%',
                        background: r.type === 'GENERAL' ? 'var(--text)' : 'var(--primary, #01368B)',
                        color: 'white', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12, flexShrink: 0,
                      }}>{r.type === 'GENERAL' ? '#' : initials(title)}</span>
                      <span style={{ fontWeight: 500, fontSize: 14 }}>{title}</span>
                    </button>
                  );
                })}
              </div>
              <button className="btn btn-secondary" onClick={() => setForwardSource(null)} style={{ alignSelf: 'flex-end' }}>
                {t('common.cancel')}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* QA-fix #5: модалка выбора собеседника для нового direct-чата */}
      <AnimatePresence>
        {showNewDirect && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setShowNewDirect(false)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(8, 11, 24, 0.55)',
              backdropFilter: 'blur(4px)', zIndex: 9999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'white', borderRadius: 20, padding: 28, width: 'min(440px, 92vw)',
                maxHeight: '80vh', display: 'flex', flexDirection: 'column',
                boxShadow: '0 24px 60px rgba(0, 0, 0, 0.25)',
              }}
            >
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11,
                letterSpacing: '0.16em', color: 'var(--text-soft)',
                textTransform: 'uppercase', marginBottom: 8,
              }}>{t('eyebrow.newDirectMessage')}</div>
              <h3 style={{
                fontFamily: 'var(--font-display)', fontSize: 22,
                fontWeight: 500, marginBottom: 18,
              }}>
                {t('chat.pick.a')} <em style={{
                  fontFamily: 'Times New Roman, Georgia, serif',
                  fontWeight: 400, color: 'var(--primary-dark)',
                }}>{t('chat.pick.b')}</em>
              </h3>
              <div style={{ flex: 1, overflowY: 'auto', margin: '-4px -4px 12px' }}>
                {users.filter((u: any) => u.id !== me?.id).length === 0 ? (
                  <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-soft)' }}>
                    {t('chat.noUsers')}
                  </div>
                ) : (
                  users.filter((u: any) => u.id !== me?.id).map((u: any) => (
                    <button
                      key={u.id}
                      onClick={() => { startDirect(u.id); setShowNewDirect(false); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        width: '100%', padding: '12px 14px',
                        borderRadius: 12, background: 'transparent',
                        border: 'none', cursor: 'pointer', textAlign: 'left',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-soft, #f8fafc)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{
                        width: 36, height: 36, borderRadius: '50%',
                        background: 'var(--primary, #01368B)', color: 'white',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600, fontSize: 12, flexShrink: 0,
                      }}>{initials(u.fullName)}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: 14 }}>{u.fullName}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                          {displayRoleLabel(u as any)}
                        </div>
                      </span>
                    </button>
                  ))
                )}
              </div>
              <button
                className="btn btn-secondary"
                onClick={() => setShowNewDirect(false)}
                style={{ alignSelf: 'flex-end' }}
              >
                {t('common.cancel')}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* QA-fix #5: модалка для team-chat */}
      <AnimatePresence>
        {showNewTeam && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setShowNewTeam(false)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(8, 11, 24, 0.55)',
              backdropFilter: 'blur(4px)', zIndex: 9999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'white', borderRadius: 20, padding: 28, width: 'min(480px, 92vw)',
                maxHeight: '85vh', display: 'flex', flexDirection: 'column',
                boxShadow: '0 24px 60px rgba(0, 0, 0, 0.25)',
              }}
            >
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11,
                letterSpacing: '0.16em', color: 'var(--text-soft)',
                textTransform: 'uppercase', marginBottom: 8,
              }}>{t('eyebrow.newTeam')}</div>
              <h3 style={{
                fontFamily: 'var(--font-display)', fontSize: 22,
                fontWeight: 500, marginBottom: 18,
              }}>
                {t('chat.create.a')} <em style={{
                  fontFamily: 'Times New Roman, Georgia, serif',
                  fontWeight: 400, color: 'var(--primary-dark)',
                }}>{t('chat.create.b')}</em>
              </h3>
              <NewTeamForm
                users={users.filter((u: any) => u.id !== me?.id)}
                onCreate={async (title, memberIds) => {
                  const room = await createTeamRoom(title, memberIds);
                  setShowNewTeam(false);
                  qc.invalidateQueries({ queryKey: roomsKey });
                  setActiveId(room.id);
                }}
                onCancel={() => setShowNewTeam(false)}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Когда прочитано: сегодня — «16:45», вчера — «вчера 16:45», раньше — «21.09 16:45». */
function readTimeLabel(iso: string, t: (k: string) => string) {
  const day = tjDateInput(iso);
  if (day === tjDateInput(new Date())) return fmtTime(iso);
  if (day === tjDateInput(new Date(Date.now() - 86_400_000))) return t('chat.reads.yesterday').replace('{t}', fmtTime(iso));
  const sameYear = day.slice(0, 4) === tjDateInput(new Date()).slice(0, 4);
  const date = fmtDateText(iso, { day: '2-digit', month: '2-digit', ...(sameYear ? {} : { year: 'numeric' }), timeZone: TJ_TZ });
  return `${date} ${fmtTime(iso)}`;
}

/**
 * «Кто прочитал» в меню своего сообщения. Личный чат — одна строка
 * «Прочитано 16:45»; группа — «Прочитали (N)», по клику список с временем.
 * readAt=null — прочитал до того, как время стали запоминать.
 */
function MessageReadsInfo({ messageId, direct }: { messageId: string; direct: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['chat', 'reads', messageId],
    queryFn: () => getMessageReads(messageId),
    staleTime: 0,
  });
  const list = q.data ?? [];
  const when = (readAt: string | null) => (readAt ? readTimeLabel(readAt, t) : t('chat.reads.noTime'));
  if (direct) {
    const r = list[0];
    return (
      <div className="chat-reads-line" data-testid="chat-reads" data-state={r ? 'read' : 'unread'}>
        <Icon name={r ? 'done_all' : 'done'} size={18} />
        <span>
          {q.isLoading
            ? '…'
            : r
              ? (r.readAt ? t('chat.reads.readAt').replace('{t}', readTimeLabel(r.readAt, t)) : t('chat.reads.read'))
              : t('chat.reads.notYet')}
        </span>
      </div>
    );
  }
  return (
    <div className="chat-reads" data-testid="chat-reads">
      <button
        type="button"
        className="chat-reads-toggle"
        data-testid="chat-reads-toggle"
        disabled={!list.length}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="done_all" size={18} />
        <span style={{ flex: 1 }}>
          {q.isLoading ? '…' : list.length ? `${t('chat.reads.title')} (${list.length})` : t('chat.reads.none')}
        </span>
        {list.length > 0 && <Icon name={open ? 'expand_less' : 'expand_more'} size={18} />}
      </button>
      {open && (
        <div className="chat-reads-list" data-testid="chat-reads-list">
          {list.map((r) => (
            <div key={r.userId} className="chat-reads-row" data-testid="chat-reads-row">
              <span className="chat-avatar" style={{ background: avatarColor(r.userId), width: 26, height: 26, fontSize: 10, alignSelf: 'center' }}>
                {initials(r.fullName)}
              </span>
              <span className="chat-reads-name">{r.fullName}</span>
              <span className="chat-reads-time">{when(r.readAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** «Удалить чат» с собеседником: у себя или (галочка) у обоих. */
function DeleteDirectDialog({ peerName, onCancel, onConfirm }: {
  peerName: string;
  onCancel: () => void;
  onConfirm: (forAll: boolean) => void;
}) {
  const { t } = useT();
  const [forAll, setForAll] = useState(false);
  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onCancel}
    >
      <motion.div
        className="dialog-card"
        data-testid="chat-delete-dialog"
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-icon danger"><Icon name="delete" size={28} /></div>
        <div className="dialog-title">{t('chat.room.deleteTitle')}</div>
        <div className="dialog-message">{t('chat.room.deleteText').replace('{name}', peerName)}</div>
        <label className="chat-delete-both">
          <input type="checkbox" checked={forAll} onChange={(e) => setForAll(e.target.checked)} data-testid="chat-delete-both" />
          <span>{t('chat.room.deleteBoth').replace('{name}', peerName)}</span>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-danger" onClick={() => onConfirm(forAll)} data-testid="chat-delete-confirm">
            {t('common.delete')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Рендер текста сообщения с подсветкой @mentions */
function renderMessageWithMentions(text: string) {
  const parts = text.split(/(@[\wа-яА-ЯёЁ.\-]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('@') ? (
          <span
            key={i}
            // Контраст работает и на белом (свои/чужие пузыри), и на тёмно-синем
            // (свои сообщения): color: inherit наследуется от пузыря, фон —
            // полупрозрачный белый (на тёмном фоне он становится viтрин-glass,
            // на светлом — мягкий голубой акцент благодаря mix-blend).
            style={{
              fontWeight: 700,
              color: 'inherit',
              background: 'rgba(127, 169, 248, 0.32)',
              padding: '1px 6px',
              borderRadius: 6,
              textDecoration: 'underline',
              textDecorationColor: 'currentColor',
              textDecorationThickness: '1px',
              textUnderlineOffset: '2px',
            }}
          >
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Форма создания команды (group chat) */
function NewTeamForm({ users, onCreate, onCancel }: {
  users: any[];
  onCreate: (title: string, memberIds: string[]) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (id: string) => {
    setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  };

  return (
    <div style={{ padding: 14 }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.10em',
        color: 'var(--text-soft)',
        margin: '4px 4px 8px',
        textTransform: 'uppercase',
      }}>{t('chat.newTeam')}</div>
      <input
        className="crm-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('chat.teamName')}
        style={{ width: '100%', marginBottom: 12 }}
      />
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.10em',
        color: 'var(--text-soft)',
        margin: '4px 4px 8px',
        textTransform: 'uppercase',
      }}>{t('chat.members')} · {selected.length}</div>
      <div style={{ maxHeight: 280, overflowY: 'auto', marginBottom: 12 }}>
        {users.map((u) => {
          const isSel = selected.includes(u.id);
          return (
            <button
              key={u.id}
              type="button"
              onClick={() => toggle(u.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                background: isSel ? 'var(--primary-soft)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: 4,
                border: `1.5px solid ${isSel ? 'var(--primary)' : 'var(--input-border)'}`,
                background: isSel ? 'var(--primary)' : 'transparent',
                color: 'white',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11,
              }}>{isSel && '✓'}</div>
              <div style={{ fontSize: 13 }}>{u.fullName}</div>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!title.trim() || selected.length === 0}
          onClick={() => onCreate(title.trim(), selected)}
        >
          {t('common.create')}
        </button>
      </div>
    </div>
  );
}
