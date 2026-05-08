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
} from '../api/chat';
import { listUsers } from '../api/users';
import { listNotifications, markRead } from '../api/notifications';
import { useAuth } from '../store/auth';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, tempId } from '../lib/optimistic';

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
  // emojiPickerFor зарезервирован для будущего полного picker'а; quick-react
  // через context-menu пока достаточно. Подавляем lint через void-присвоение.
  const [, ] = useState<string | null>(null);
  void 0;
  const [forwardSource, setForwardSource] = useState<ChatMessage | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // Telegram-style: realtime для реакций, удаления, закрепления.
  useRealtimeEvent('chat:reaction', () => qc.invalidateQueries({ queryKey: keys.chat.all }));
  useRealtimeEvent('chat:message:deleted', () => qc.invalidateQueries({ queryKey: keys.chat.all }));
  useRealtimeEvent('chat:message:pin', () => qc.invalidateQueries({ queryKey: keys.chat.all }));

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
    if (data.roomId === activeId) {
      qc.setQueryData<ChatMessage[]>(messagesKey, (cur) => {
        const list = cur ?? [];
        // Не добавляем если такой id уже есть.
        if (list.some((m) => m.id === data.message.id)) return list;
        // Если это моё сообщение — попробуем заменить tmp-копию по тексту.
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
    }
    qc.invalidateQueries({ queryKey: keys.chat.unread() });
    qc.invalidateQueries({ queryKey: roomsKey });
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

  const reactMut = useInvalidatingMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      reactToMessage(messageId, emoji),
    invalidate: [keys.chat.all],
  });
  const deleteMut = useInvalidatingMutation({
    mutationFn: ({ messageId }: { messageId: string }) => deleteChatMessage(messageId),
    invalidate: [keys.chat.all],
  });
  const pinMut = useInvalidatingMutation({
    mutationFn: ({ messageId }: { messageId: string }) => pinChatMessage(messageId),
    invalidate: [keys.chat.all],
  });
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

  // При изменении input ищем '@' непосредственно перед курсором.
  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setInput(v);
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

      <div className="card" style={{
        padding: 0,
        height: 'calc(100vh - 280px)',
        minHeight: 520,
        display: 'grid',
        gridTemplateColumns: '280px 1fr',
        overflow: 'hidden',
      }}>
        {/* Sidebar — список чатов */}
        <div style={{
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
            {/* QA-fix #5: список чатов всегда виден; "+ собеседник" /
                "+ команда" открываются в отдельной модалке поверх. */}
            {(() => {
              return rooms.map((r) => {
                const isActive = r.id === activeId;
                const lastMsg = r.messages?.[0];
                const otherMember = r.type === 'DIRECT'
                  ? r.members.find((m) => m.userId !== me?.id)
                  : null;
                const title = r.type === 'GENERAL'
                  ? 'Команда Javonon'
                  : r.type === 'DIRECT'
                    ? otherMember?.user.fullName || r.title || 'Чат'
                    : r.title || 'Команда';
                return (
                  <button
                    key={r.id}
                    onClick={() => setActiveId(r.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      width: '100%',
                      padding: '14px 18px',
                      background: isActive ? 'var(--primary-soft)' : 'transparent',
                      borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--border-soft)',
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
              });
            })()}
          </div>
        </div>

        {/* Messages */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {activeRoom && (
            <div style={{
              padding: '20px 24px',
              borderBottom: '1px solid var(--border-soft)',
            }}>
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
              }}>
                {activeRoom.type === 'GENERAL' ? 'Команда Javonon' :
                  activeRoom.type === 'DIRECT'
                    ? activeRoom.members.find((m) => m.userId !== me?.id)?.user.fullName || activeRoom.title
                    : activeRoom.title}
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
                      }}>
                        {isBot ? 'Javonon AI · BOT' : (isMine ? 'Вы' : m.author?.fullName)} · {fmtTime(m.createdAt)}
                        {m.isPinned && <span title="Закреплено" style={{ marginLeft: 6 }}>📌</span>}
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
                                  minWidth: 220,
                                }}
                              >
                                <Icon name="description" size={20} />
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 500, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {a.originalName}
                                  </div>
                                  <div style={{ fontSize: 11, opacity: 0.7 }}>
                                    {(a.size / 1024).toFixed(1)} KB
                                  </div>
                                </span>
                                <Icon name="download" size={18} />
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
                      ? r.members.find((mm) => mm.userId !== me?.id)?.user.fullName || r.title || 'Чат'
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
