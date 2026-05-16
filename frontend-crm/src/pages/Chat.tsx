import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  setTyping,
  markRoomRead,
} from '../api/chat';
import { listUsers } from '../api/users';
import { listNotifications, markRead } from '../api/notifications';
import { useAuth } from '../store/auth';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation, tempId } from '../lib/optimistic';

// Базовый URL для статических attachments (chat-uploads).
const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}
function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

export default function Chat() {
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
  const [forwardSource, setForwardSource] = useState<ChatMessage | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Typing indicator: roomId → Map<userId, { name, expiresAt }>.
  // Auto-expire: если событие не приходило 5 сек — убираем из списка.
  const [typingByRoom, setTypingByRoom] = useState<Record<string, Record<string, { name: string; expiresAt: number }>>>({});
  const inputRef = useRef<HTMLInputElement>(null);
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

  // Если URL изменился (открыли через notification) — переключаем room.
  useEffect(() => {
    const fromUrl = searchParams.get('room');
    if (fromUrl && fromUrl !== activeId) setActiveId(fromUrl);
  }, [searchParams]);

  const messagesKey = activeId ? keys.chat.room(activeId) : ['chat', 'room', null];
  const messagesQuery = useQuery({
    queryKey: messagesKey,
    queryFn: () => getChatRoom(activeId!).then((d) => d.messages),
    enabled: !!activeId,
  });
  const messages = messagesQuery.data ?? [];

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
  useRealtimeEvent('chat:message:deleted', (data: any) => {
    qc.setQueryData<ChatMessage[]>(keys.chat.room(data.roomId), (cur) => {
      if (!cur) return cur;
      return cur.map((m) => m.id === data.messageId
        ? { ...m, deletedAt: new Date().toISOString(), text: '', attachments: null }
        : m);
    });
  });
  useRealtimeEvent('chat:message:pin', (data: any) => {
    qc.setQueryData<ChatMessage[]>(keys.chat.room(data.roomId), (cur) => {
      if (!cur) return cur;
      return cur.map((m) => m.id === data.messageId ? { ...m, isPinned: data.isPinned } : m);
    });
  });
  useRealtimeEvent('chat:read', (data: any) => {
    // data: { roomId, userId, lastReadAt } — обновляем member в roomsKey
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
        room[data.userId] = { name: data.userName || 'Кто-то', expiresAt: Date.now() + 5000 };
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
      // Если это моё сообщение — заменяем tmp-копию по тексту/времени.
      if (me?.id && data.message.authorId === me.id) {
        const tmpIdx = list.findIndex(
          (m) => m.id.startsWith('tmp-') && m.text === data.message.text,
        );
        if (tmpIdx >= 0) {
          const next = list.slice();
          next[tmpIdx] = data.message;
          return next;
        }
      }
      return [...list, data.message];
    });
    // Bump room в roomsKey локально (без refetch) — чтобы preview обновился.
    qc.setQueryData<ChatRoom[]>(roomsKey, (cur) => {
      if (!cur) return cur;
      return cur.map((r) => r.id === data.roomId
        ? { ...r, updatedAt: data.message.createdAt, messages: [data.message, ...(r.messages || []).slice(0, 0)] }
        : r,
      );
    });
    // Unread — bump только если не моё сообщение и комната не активная.
    if (data.message.authorId !== me?.id && data.roomId !== activeId) {
      qc.setQueryData<Array<{ roomId: string; unread: number }>>(['chat', 'unread'], (cur) => {
        if (!cur) return cur;
        const exists = cur.find((u) => u.roomId === data.roomId);
        if (exists) {
          return cur.map((u) => u.roomId === data.roomId ? { ...u, unread: u.unread + 1 } : u);
        }
        return [...cur, { roomId: data.roomId, unread: 1 }];
      });
    }
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // SEND — оптимистично добавляем сообщение мгновенно с tempId.
  // На invalidate реальное сообщение из сервера приедет с настоящим id.
  const sendMut = useInvalidatingMutation({
    mutationFn: ({ roomId, text, files, replyToId }: {
      roomId: string; text: string; files?: File[]; replyToId?: string;
    }) => sendChatMessage(roomId, text, { files, replyToId }),
    invalidate: [keys.chat.all],
    onError: (_e: any) => {
      qc.setQueryData<ChatMessage[]>(messagesKey, (cur) => (cur ?? []).filter((m) => !m.id.startsWith('tmp-')));
    },
  });

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

  // QA-fix: удаление — оптимистично помечаем deletedAt сразу.
  const deleteMut = useOptimisticMutation<unknown, { messageId: string }, ChatMessage[]>({
    mutationFn: ({ messageId }) => deleteChatMessage(messageId),
    queryKey: messagesKey,
    applyOptimistic: (cur, { messageId }) => {
      if (!cur) return cur;
      return cur.map((m) => m.id === messageId
        ? { ...m, deletedAt: new Date().toISOString(), text: '', attachments: null }
        : m);
    },
  });

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
  const forwardMut = useInvalidatingMutation({
    mutationFn: ({ messageId, targetRoomId }: { messageId: string; targetRoomId: string }) =>
      forwardChatMessage(messageId, targetRoomId),
    invalidate: [keys.chat.all],
  });

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (mention) return; // если открыт picker — Enter выбирает, а не отправляет
    if (!activeId) return;
    const text = input.trim();
    if (!text && pendingFiles.length === 0) return;
    // 1) optimistic add — для текста и attachments-превью
    const optimisticAttachments: ChatAttachment[] = pendingFiles.map((f) => ({
      url: URL.createObjectURL(f),
      filename: f.name,
      originalName: f.name,
      mimeType: f.type || 'application/octet-stream',
      size: f.size,
    }));
    const optimisticMsg: ChatMessage = {
      id: tempId(),
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
    setInput('');
    setMention(null);
    setPendingFiles([]);
    setReplyTo(null);
    // 2) actually send
    sendMut.mutate({ roomId: activeId, text, files: filesCopy, replyToId: replyId });
    // 3) сразу шлём typing:false чтобы у собеседника убрался индикатор
    if (typingPingRef.current.idleTimer) {
      window.clearTimeout(typingPingRef.current.idleTimer);
      typingPingRef.current.idleTimer = null;
    }
    typingPingRef.current.lastPingAt = 0;
    setTyping(activeId, false).catch(() => undefined);
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length) setPendingFiles((prev) => [...prev, ...files].slice(0, 10));
    e.target.value = '';
  };
  const removePendingFile = (i: number) => {
    setPendingFiles((prev) => prev.filter((_, idx) => idx !== i));
  };

  const copyText = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const onContextMenu = (e: React.MouseEvent, msg: ChatMessage) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, msg });
  };
  // Закрытие context-menu по клику вне
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // ============ MENTION PICKER ============
  // Отслеживаем '@' в input, открываем dropdown с участниками комнаты.
  // Кандидаты — members активной комнаты (без меня), либо все users если их нет.
  const activeRoom = rooms.find((r) => r.id === activeId);
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
      setTyping(activeId, true).catch(() => undefined);
    }
    if (typingPingRef.current.idleTimer) {
      window.clearTimeout(typingPingRef.current.idleTimer);
    }
    if (!text) {
      // input пустой — сразу шлём false
      typingPingRef.current.lastPingAt = 0;
      setTyping(activeId, false).catch(() => undefined);
      return;
    }
    typingPingRef.current.idleTimer = window.setTimeout(() => {
      if (activeId) setTyping(activeId, false).catch(() => undefined);
      typingPingRef.current.lastPingAt = 0;
    }, 3500);
  };

  // При изменении input ищем '@' непосредственно перед курсором.
  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!mention || mentionCandidates.length === 0) return;
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
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">CHAT · 12</span>
        <h2 className="crm-section-title">
          Внутренний <em>чат.</em>
        </h2>
      </div>

      <div className={`card chat-card${mobileShowList ? ' show-list' : ' show-thread'}`} style={{
        padding: 0,
        height: 'calc(100vh - 280px)',
        minHeight: 520,
        display: 'grid',
        gridTemplateColumns: '280px 1fr',
        overflow: 'hidden',
      }}>
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
            }}>Чаты</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => { setShowNewTeam(false); setShowNewDirect((v) => !v); }}
                title="Новый личный чат"
              >
                <Icon name="person_add" size={14} />
              </button>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => { setShowNewDirect(false); setShowNewTeam((v) => !v); }}
                title="Новая команда"
              >
                <Icon name="groups" size={14} />
              </button>
            </div>
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
                  ? 'Команда Javonon'
                  : r.type === 'DIRECT'
                    ? otherMember?.user.fullName || r.title || 'Чат'
                    : r.title || 'Команда';
              };

              const renderRoom = (r: typeof rooms[number]) => {
                const isActive = r.id === activeId;
                const lastMsg = r.messages?.[0];
                const title = roomTitle(r);
                return (
                  <button
                    key={r.id}
                    onClick={() => { setActiveId(r.id); setMobileShowList(false); }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      width: '100%',
                      padding: '12px 18px',
                      background: isActive ? 'var(--primary-soft)' : 'transparent',
                      borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: '50%',
                      background: r.type === 'GENERAL' ? 'var(--text)' : 'var(--primary)',
                      color: r.type === 'GENERAL' ? 'white' : 'var(--text)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--font-display)',
                      fontWeight: 600,
                      fontSize: 13,
                      flexShrink: 0,
                    }}>
                      {r.type === 'GENERAL' ? '#' : initials(title)}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontWeight: 500,
                        fontSize: 14,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>{title}</div>
                      {lastMsg && (
                        <div style={{
                          fontSize: 12,
                          color: 'var(--text-soft)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          marginTop: 2,
                        }}>{lastMsg.author?.fullName?.split(' ')[0] || ''}: {lastMsg.text}</div>
                      )}
                    </div>
                  </button>
                );
              };

              const general = rooms.filter((r) => r.type === 'GENERAL');
              const teams = rooms.filter((r) => r.type === 'TEAM');
              const directs = rooms.filter((r) => r.type === 'DIRECT');

              const folders: Array<{ key: string; icon: string; label: string; list: typeof rooms }> = [
                { key: 'GENERAL', icon: 'campaign', label: 'Общий', list: general },
                { key: 'TEAM', icon: 'groups', label: 'Команды', list: teams },
                { key: 'DIRECT', icon: 'person', label: 'Личные', list: directs },
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
                      <span style={{ fontWeight: 700 }}>{f.list.length}</span>
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
          {activeRoom && (
            <div className="chat-thread-header" style={{
              padding: '20px 24px',
              borderBottom: '1px solid var(--border-soft)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              {/* Mobile: back-кнопка чтобы вернуться к списку чатов */}
              <button
                type="button"
                className="chat-back-btn"
                onClick={() => setMobileShowList(true)}
                aria-label="Назад к списку чатов"
              >
                <Icon name="arrow_back" size={22} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  color: 'var(--text-soft)',
                  textTransform: 'uppercase',
                  marginBottom: 4,
                }}>{activeRoom.type === 'GENERAL' ? 'GENERAL' : activeRoom.type === 'DIRECT' ? 'DIRECT' : 'TEAM'} · {activeRoom.members.length} members</div>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 22,
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {activeRoom.type === 'GENERAL' ? 'Команда Javonon' :
                    activeRoom.type === 'DIRECT'
                      ? (() => {
                          // Берём member'а который НЕ текущий пользователь.
                          // Защита: если me?.id неизвестен — фильтруем по
                          // fullName тоже, чтобы не показать собственное имя.
                          const other = activeRoom.members.find((m) =>
                            (me?.id ? m.userId !== me.id : true)
                            && (me?.fullName ? m.user.fullName !== me.fullName : true),
                          );
                          return other?.user.fullName || activeRoom.title || 'Чат';
                        })()
                      : activeRoom.title}
                </div>
              </div>
            </div>
          )}

          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
            {messages.length === 0 && (
              <div className="empty" style={{ marginTop: 80 }}>Сообщений пока нет — начни первым</div>
            )}
            {messages.map((m, i) => {
              // QA-fix #6: надёжное определение isMine. Bot (__BOT__ mention)
              // — всегда слева. Иначе сравниваем authorId с me.id.
              const isBot = m.mentionsIds?.includes('__BOT__');
              const isMine = !isBot && !!me?.id && m.authorId === me.id;
              const prev = messages[i - 1];
              const showHeader = !prev || prev.authorId !== m.authorId ||
                new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60 * 1000;
              const isMentionedMe = me?.id && m.mentionsIds?.includes(me.id);
              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    display: 'flex',
                    // Всегда row — alignment делаем через justify-content + max-width.
                    // Так надёжнее чем row-reverse (rtl bugs c flex-end).
                    justifyContent: isMine ? 'flex-end' : 'flex-start',
                    gap: 10,
                    marginBottom: showHeader ? 14 : 4,
                    alignItems: 'flex-end',
                  }}
                >
                  {/* Аватар СОБЕСЕДНИКА — слева. Свой не показываем чтобы был ровный край справа. */}
                  {!isMine && (
                    showHeader || isBot ? (
                      <div style={{
                        width: 32, height: 32, borderRadius: '50%',
                        background: isBot ? 'linear-gradient(135deg, var(--primary), var(--text))' : 'var(--text)',
                        color: 'white',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600, fontSize: 11,
                        flexShrink: 0,
                      }}>{isBot ? '🤖' : initials(m.author?.fullName || '?')}</div>
                    ) : <div style={{ width: 32, flexShrink: 0 }} />
                  )}
                  <div style={{ maxWidth: '70%', display: 'flex', flexDirection: 'column', alignItems: isMine ? 'flex-end' : 'flex-start', position: 'relative' }}>
                    {(showHeader || isBot) && (
                      <div style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        letterSpacing: '0.08em',
                        color: 'var(--text-light)',
                        marginBottom: 4,
                        textTransform: 'uppercase',
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}>
                        <span>{isBot ? 'Javonon AI · BOT' : (isMine ? 'Вы' : m.author?.fullName)} · {fmtTime(m.createdAt)}</span>
                        {m.isPinned && <span title="Закреплено">📌</span>}
                        {/* Telegram-style read receipts: только для своих сообщений */}
                        {isMine && !isBot && (() => {
                          // tmp- = ещё не доставлено серверу → часы
                          if (m.id.startsWith('tmp-')) {
                            return <span title="Отправляется"><Icon name="schedule" size={12} /></span>;
                          }
                          // Прочитано если хоть один другой участник
                          // имеет lastReadAt >= createdAt сообщения
                          const others = (activeRoom?.members || []).filter((mm) => mm.userId !== me?.id);
                          const created = new Date(m.createdAt).getTime();
                          const isRead = others.some((mm) => mm.lastReadAt && new Date(mm.lastReadAt).getTime() >= created);
                          return (
                            <span
                              title={isRead ? 'Прочитано' : 'Доставлено'}
                              style={{ color: isRead ? 'var(--primary, #01368B)' : 'var(--text-light)', display: 'inline-flex' }}
                            >
                              <Icon name={isRead ? 'done_all' : 'done'} size={14} />
                            </span>
                          );
                        })()}
                      </div>
                    )}
                    <div
                      onContextMenu={(e) => onContextMenu(e, m)}
                      style={{
                        background: m.deletedAt
                          ? 'transparent'
                          : isBot
                            ? 'linear-gradient(135deg, rgba(1, 54, 139,0.10), rgba(0,0,0,0.04))'
                            : isMentionedMe && !isMine
                              ? 'var(--primary-soft)'
                              : isMine
                                ? 'var(--primary, #01368B)'
                                : 'var(--bg-soft, #f1f5f9)',
                        color: m.deletedAt ? 'var(--text-light)' : isBot ? 'var(--text)' : (isMine ? 'white' : 'var(--text)'),
                        padding: m.deletedAt ? '6px 12px' : '10px 14px',
                        borderRadius: isMine ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                        fontSize: 14,
                        lineHeight: 1.5,
                        wordWrap: 'break-word',
                        fontStyle: m.deletedAt ? 'italic' : 'normal',
                        border: m.deletedAt ? '1px dashed var(--border)' : (isMentionedMe && !isMine ? '1px solid var(--primary)' : undefined),
                        position: 'relative',
                      }}>
                      {/* Reply quote inside bubble */}
                      {m.replyTo && !m.deletedAt && (
                        <div style={{
                          fontSize: 12,
                          padding: '6px 10px',
                          marginBottom: 8,
                          borderLeft: `3px solid ${isMine ? 'rgba(255,255,255,0.6)' : 'var(--primary, #01368B)'}`,
                          background: isMine ? 'rgba(255,255,255,0.1)' : 'rgba(1, 54, 139, 0.08)',
                          borderRadius: 4,
                          opacity: 0.85,
                        }}>
                          <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2 }}>
                            {m.replyTo.author?.fullName || 'Сообщение'}
                          </div>
                          <div style={{
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280,
                          }}>
                            {m.replyTo.deletedAt ? 'удалённое сообщение' : (m.replyTo.text || (m.replyTo.attachments?.length ? '📎 Вложение' : ''))}
                          </div>
                        </div>
                      )}
                      {/* Forwarded badge */}
                      {m.forwardedFrom && !m.deletedAt && (
                        <div style={{
                          fontSize: 11, marginBottom: 6, opacity: 0.75,
                          fontStyle: 'italic',
                        }}>
                          ↪ Переслано от {m.forwardedFrom.author?.fullName || 'кого-то'}
                        </div>
                      )}
                      {/* Attachments */}
                      {!m.deletedAt && m.attachments && m.attachments.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: m.text ? 8 : 0 }}>
                          {m.attachments.map((a, ai) => {
                            const isImg = a.mimeType?.startsWith('image/');
                            const isVid = a.mimeType?.startsWith('video/');
                            const isAud = a.mimeType?.startsWith('audio/');
                            const url = a.url.startsWith('http') ? a.url : `${API_BASE}${a.url}`;
                            if (isImg) {
                              return (
                                <img
                                  key={ai}
                                  src={url}
                                  alt={a.originalName}
                                  onClick={() => setLightbox(url)}
                                  style={{
                                    maxWidth: 320, maxHeight: 320, borderRadius: 10,
                                    cursor: 'zoom-in', display: 'block',
                                  }}
                                />
                              );
                            }
                            if (isVid) {
                              return (
                                <video
                                  key={ai}
                                  src={url}
                                  controls
                                  style={{ maxWidth: 320, maxHeight: 320, borderRadius: 10 }}
                                />
                              );
                            }
                            if (isAud) {
                              return <audio key={ai} src={url} controls style={{ width: 280 }} />;
                            }
                            // file card
                            return (
                              <a
                                key={ai}
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 10,
                                  padding: '10px 12px',
                                  background: isMine ? 'rgba(255,255,255,0.18)' : 'white',
                                  color: 'inherit',
                                  border: '1px solid rgba(0,0,0,0.06)',
                                  borderRadius: 10,
                                  textDecoration: 'none',
                                  minWidth: 0,
                                  maxWidth: '100%',
                                  width: '100%',
                                  boxSizing: 'border-box',
                                }}
                              >
                                <Icon name="description" size={20} />
                                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                                  <div style={{ fontWeight: 500, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {a.originalName}
                                  </div>
                                  <div style={{ fontSize: 11, opacity: 0.7 }}>
                                    {(a.size / 1024).toFixed(1)} KB
                                  </div>
                                </span>
                                <Icon name="download" size={18} style={{ flexShrink: 0 }} />
                              </a>
                            );
                          })}
                        </div>
                      )}
                      {m.deletedAt ? <span>сообщение удалено</span> : renderMessageWithMentions(m.text)}
                    </div>
                    {/* Reactions chips */}
                    {!m.deletedAt && m.reactions && m.reactions.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
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
                            onClick={() => reactMut.mutate({ messageId: m.id, emoji })}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              padding: '3px 8px', borderRadius: 100,
                              background: mine ? 'rgba(1, 54, 139, 0.15)' : 'rgba(0,0,0,0.04)',
                              border: mine ? '1px solid var(--primary, #01368B)' : '1px solid transparent',
                              fontSize: 12, cursor: 'pointer',
                            }}
                          >
                            <span>{emoji}</span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })}
            {/* Typing indicator (Telegram-style) */}
            {activeId && typingByRoom[activeId] && Object.keys(typingByRoom[activeId]).length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 14px', marginTop: 4,
                  fontSize: 12, color: 'var(--text-soft)',
                  fontStyle: 'italic',
                }}
              >
                <span className="typing-dots" aria-hidden="true">
                  <span /><span /><span />
                </span>
                {(() => {
                  const names = Object.values(typingByRoom[activeId]).map((u) => u.name);
                  if (names.length === 1) return `${names[0]} печатает…`;
                  if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`;
                  return `${names.length} человек печатают…`;
                })()}
              </motion.div>
            )}
          </div>

          <form onSubmit={send} style={{
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--border-soft)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            position: 'relative',
          }}>
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
                    Ответ {replyTo.author?.fullName || ''}
                  </div>
                  <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-soft)' }}>
                    {replyTo.text || (replyTo.attachments?.length ? '📎 Вложение' : '')}
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
            <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
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
                  Упомянуть · ↑↓ выбрать · Enter / Tab вставить · Esc закрыть
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
                        {u.role === 'ADMIN' ? 'Администратор' : u.role === 'ACCOUNTANT' ? 'Бухгалтер' : 'Сотрудник'}
                      </div>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Прикрепить файл"
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
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={onPickFiles}
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar,.7z,.txt"
            />
            <input
              ref={inputRef}
              value={input}
              onChange={onInputChange}
              onKeyDown={onInputKeyDown}
              placeholder="Напиши сообщение... (@ — упомянуть)"
              style={{
                flex: 1,
                padding: '12px 16px',
                border: '1px solid var(--border)',
                borderRadius: 100,
                fontSize: 14,
                fontFamily: 'inherit',
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={!input.trim() && pendingFiles.length === 0}>
              <Icon name="send" size={16} />
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
              top: Math.min(contextMenu.y, window.innerHeight - 380),
              left: Math.min(contextMenu.x, window.innerWidth - 240),
              background: 'white', borderRadius: 14, padding: 8,
              boxShadow: '0 16px 40px rgba(0,0,0,0.18)',
              zIndex: 9998, minWidth: 220,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Quick reactions row */}
            <div style={{ display: 'flex', gap: 4, padding: '4px 6px 8px', borderBottom: '1px solid var(--border-soft)' }}>
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
            </div>
            {/* Actions */}
            {[
              { icon: 'reply', label: 'Ответить', show: !contextMenu.msg.deletedAt, onClick: () => setReplyTo(contextMenu.msg) },
              { icon: 'push_pin', label: contextMenu.msg.isPinned ? 'Открепить' : 'Закрепить', show: me?.role === 'ADMIN' && !contextMenu.msg.deletedAt, onClick: () => pinMut.mutate({ messageId: contextMenu.msg.id }) },
              { icon: 'content_copy', label: 'Копировать текст', show: !!contextMenu.msg.text && !contextMenu.msg.deletedAt, onClick: () => copyText(contextMenu.msg.text) },
              { icon: 'forward', label: 'Переслать', show: !contextMenu.msg.deletedAt, onClick: () => setForwardSource(contextMenu.msg) },
              { icon: 'delete', label: 'Удалить', show: !contextMenu.msg.deletedAt && (contextMenu.msg.authorId === me?.id || me?.role === 'ADMIN'), onClick: () => deleteMut.mutate({ messageId: contextMenu.msg.id }), danger: true },
            ].filter((a) => a.show).map((a) => (
              <button
                key={a.label}
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
              }}>FORWARD MESSAGE</div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 18 }}>
                Переслать в чат
              </h3>
              <div style={{ flex: 1, overflowY: 'auto', margin: '-4px -4px 12px' }}>
                {rooms.filter((r) => r.id !== activeId).map((r) => {
                  const title = r.type === 'GENERAL'
                    ? 'Команда Javonon'
                    : r.type === 'DIRECT'
                      ? r.members.find((mm) =>
                          (me?.id ? mm.userId !== me.id : true)
                          && (me?.fullName ? mm.user.fullName !== me.fullName : true),
                        )?.user.fullName || r.title || 'Чат'
                      : r.title || 'Команда';
                  return (
                    <button
                      key={r.id}
                      onClick={() => {
                        forwardMut.mutate({ messageId: forwardSource.id, targetRoomId: r.id });
                        setForwardSource(null);
                        setActiveId(r.id);
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
                Отмена
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
              }}>NEW DIRECT MESSAGE</div>
              <h3 style={{
                fontFamily: 'var(--font-display)', fontSize: 22,
                fontWeight: 500, marginBottom: 18,
              }}>
                Выбери <em style={{
                  fontFamily: 'Times New Roman, Georgia, serif',
                  fontWeight: 400, color: 'var(--primary-dark)',
                }}>собеседника.</em>
              </h3>
              <div style={{ flex: 1, overflowY: 'auto', margin: '-4px -4px 12px' }}>
                {users.filter((u: any) => u.id !== me?.id).length === 0 ? (
                  <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-soft)' }}>
                    Нет доступных пользователей
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
                          {u.role === 'ADMIN' ? 'Администратор' : u.role === 'ACCOUNTANT' ? 'Бухгалтер' : 'Сотрудник'}
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
                Отмена
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
              }}>NEW TEAM</div>
              <h3 style={{
                fontFamily: 'var(--font-display)', fontSize: 22,
                fontWeight: 500, marginBottom: 18,
              }}>
                Создай <em style={{
                  fontFamily: 'Times New Roman, Georgia, serif',
                  fontWeight: 400, color: 'var(--primary-dark)',
                }}>команду.</em>
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
      }}>Новая команда</div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Название команды"
        style={{
          width: '100%',
          padding: '10px 12px',
          border: '1px solid var(--border)',
          borderRadius: 10,
          fontSize: 14,
          marginBottom: 12,
        }}
      />
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.10em',
        color: 'var(--text-soft)',
        margin: '4px 4px 8px',
        textTransform: 'uppercase',
      }}>Участники · {selected.length}</div>
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
                border: `1.5px solid ${isSel ? 'var(--primary)' : 'var(--border)'}`,
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
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>Отмена</button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!title.trim() || selected.length === 0}
          onClick={() => onCreate(title.trim(), selected)}
        >
          Создать
        </button>
      </div>
    </div>
  );
}
