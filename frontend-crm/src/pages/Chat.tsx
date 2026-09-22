import { fmtDateText, tjDateInput, TJ_TZ } from '../lib/tjTime';
import { absFileUrl, useFileToken } from '../lib/fileUrl';
import { setViewingChatRoom, useChatUnreadMap } from '../lib/chatUnread';
import { Fragment, useEffect, useRef, useState } from 'react';
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
} from '../api/chat';
import { listUsers } from '../api/users';
import { listNotifications, markRead } from '../api/notifications';
import { useAuth } from '../store/auth';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation, tempId } from '../lib/optimistic';
import { isElevated, displayRoleLabel } from '../lib/roles';
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

export default function Chat() {
  const { t } = useT();
  // Ссылки на картинки и файлы строятся с файловым токеном: перерисовываемся, когда он приходит.
  useFileToken();
  const unreadMap = useChatUnreadMap();
  const { toast } = useUI();
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
    // Непрочитанные считает lib/chatUnread (одно место на всё приложение).
  });

  // Новый чат (создал собеседник) — появляется в списке сразу.
  useRealtimeEvent('chat:room', () => {
    qc.invalidateQueries({ queryKey: roomsKey });
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeId]);

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
      qc.setQueryData<ChatMessage[]>(keys.chat.room(vars.roomId), (cur) => {
        const list = cur ?? [];
        if (list.some((m) => m.id === msg.id)) return list.filter((m) => m.id !== vars.clientId);
        return list.map((m) => (m.id === vars.clientId ? msg : m));
      });
    },
    onError: (e: any, vars) => {
      qc.setQueryData<ChatMessage[]>(keys.chat.room(vars.roomId), (cur) => (cur ?? []).filter((m) => m.id !== vars.clientId));
      toast(e?.response?.data?.message || e?.userMessage || t('chat.sendError'), 'error');
      // Текст не пропадает: возвращаем его в поле ввода.
      setInput((cur) => cur || vars.text);
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
                    onClick={() => { setActiveId(r.id); setMobileShowList(false); }}
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
                ? t('chat.directChat')
                : `${activeRoom.members.length} ${t('chat.membersCount')}`;
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
                <span
                  className="chat-avatar chat-avatar-lg"
                  style={{ background: activeRoom.type === 'GENERAL' ? 'var(--text)' : avatarColor(activeRoom.id) }}
                >
                  {activeRoom.type === 'GENERAL' ? '#' : initials(title)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="chat-thread-title">{title}</div>
                  <div className={`chat-thread-sub${typers.length ? ' typing' : ''}`} data-testid="chat-thread-sub">
                    {typers.length > 0 && (
                      <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
                    )}
                    {subtitle}
                  </div>
                </div>
              </div>
            );
          })()}

          <div ref={scrollRef} className="chat-thread-body" data-testid="chat-thread-body">
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
              const color = isBot ? 'var(--primary)' : avatarColor(m.authorId);
              const dayLabel = day === tjDateInput(new Date())
                ? t('common.today')
                : day === tjDateInput(new Date(Date.now() - 86_400_000))
                  ? t('common.yesterday')
                  : fmtDateText(m.createdAt, {
                      day: 'numeric', month: 'long', timeZone: TJ_TZ,
                      ...(day.slice(0, 4) !== tjDateInput(new Date()).slice(0, 4) ? { year: 'numeric' } : {}),
                    });
              // Галочки: часы — ещё не на сервере; ✓ — доставлено; ✓✓ — прочитал хоть кто-то.
              const receipt = isMine && !isBot ? (() => {
                if (m.id.startsWith('tmp-')) return <Icon name="schedule" size={13} />;
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
                <Fragment key={m.id}>
                  {newDay && <div className="chat-day-sep"><span>{dayLabel}</span></div>}
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`chat-row${isMine ? ' mine' : ''}${sameAsNext ? ' grouped' : ''}`}
                    data-testid="chat-msg"
                    data-mine={isMine ? '1' : '0'}
                  >
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
                          <div className="chat-bubble-quote">
                            <div className="chat-bubble-quote-name">{m.replyTo.author?.fullName || t('chat.message')}</div>
                            <div className="chat-bubble-quote-text">
                              {m.replyTo.deletedAt ? t('chat.deletedMessage') : (m.replyTo.text || (m.replyTo.attachments?.length ? `📎 ${t('chat.attachment')}` : ''))}
                            </div>
                          </div>
                        )}
                        {m.forwardedFrom && !m.deletedAt && (
                          <div className="chat-bubble-forward">
                            ↪ {t('chat.forwardedFrom')} {m.forwardedFrom.author?.fullName || t('chat.someoneGen')}
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

          {/* chat-composer: справа место под круглую кнопку звонков (она поверх угла экрана). */}
          <form onSubmit={send} className="chat-composer" style={{
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
            <button
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
              className="crm-input"
              value={input}
              onChange={onInputChange}
              onKeyDown={onInputKeyDown}
              placeholder={t('chat.placeholder')}
              style={{ flex: 1, borderRadius: 100 }}
            />
            <button
              type="submit"
              className="chat-send-btn"
              data-testid="chat-send"
              aria-label={t('common.send')}
              disabled={!input.trim() && pendingFiles.length === 0}
            >
              <Icon name="send" size={18} />
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
              left: Math.max(12, Math.min(contextMenu.x, window.innerWidth - 240)),
              background: 'white', borderRadius: 14, padding: 8,
              boxShadow: '0 16px 40px rgba(0,0,0,0.18)',
              zIndex: 9998, minWidth: 220,
              maxWidth: 'calc(100vw - 24px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Quick reactions row */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 6px 8px', borderBottom: '1px solid var(--border-soft)' }}>
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
              { icon: 'reply', label: t('chat.menu.reply'), show: !contextMenu.msg.deletedAt, onClick: () => setReplyTo(contextMenu.msg) },
              { icon: 'push_pin', label: contextMenu.msg.isPinned ? t('chat.menu.unpin') : t('chat.menu.pin'), show: isElevated(me) && !contextMenu.msg.deletedAt, onClick: () => pinMut.mutate({ messageId: contextMenu.msg.id }) },
              { icon: 'content_copy', label: t('chat.menu.copy'), show: !!contextMenu.msg.text && !contextMenu.msg.deletedAt, onClick: () => copyText(contextMenu.msg.text) },
              { icon: 'forward', label: t('chat.menu.forward'), show: !contextMenu.msg.deletedAt, onClick: () => setForwardSource(contextMenu.msg) },
              { icon: 'delete', label: t('common.delete'), show: !contextMenu.msg.deletedAt && (contextMenu.msg.authorId === me?.id || isElevated(me)), onClick: () => deleteMut.mutate({ messageId: contextMenu.msg.id }), danger: true },
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
              }}>{t('eyebrow.forwardMessage')}</div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 18 }}>
                {t('chat.forwardTo')}
              </h3>
              <div style={{ flex: 1, overflowY: 'auto', margin: '-4px -4px 12px' }}>
                {rooms.filter((r) => r.id !== activeId).map((r) => {
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
