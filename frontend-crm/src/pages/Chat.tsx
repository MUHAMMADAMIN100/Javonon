import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChatRoom,
  ChatMessage,
  listChatRooms,
  getChatRoom,
  sendChatMessage,
  createDirectRoom,
  createTeamRoom,
} from '../api/chat';
import { listUsers } from '../api/users';
import { useAuth } from '../store/auth';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, tempId } from '../lib/optimistic';

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [showNewDirect, setShowNewDirect] = useState(false);
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // Realtime: новое сообщение → добавляем в кеш мгновенно (без перезагрузки).
  useRealtimeEvent('chat:message', (data: any) => {
    if (data.roomId === activeId) {
      qc.setQueryData<ChatMessage[]>(messagesKey, (cur) => optimistic.append(cur, data.message));
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
    mutationFn: ({ roomId, text }: { roomId: string; text: string }) => sendChatMessage(roomId, text),
    invalidate: [keys.chat.all],
    onError: (e: any) => {
      // При ошибке откатываем optimistic-сообщение по префиксу tmp-.
      qc.setQueryData<ChatMessage[]>(messagesKey, (cur) => (cur ?? []).filter((m) => !m.id.startsWith('tmp-')));
    },
  });

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeId || !input.trim()) return;
    const text = input;
    // 1) optimistic add
    const optimisticMsg: ChatMessage = {
      id: tempId(),
      roomId: activeId,
      authorId: me?.id || '',
      author: me ? { id: me.id, fullName: me.fullName, role: me.role } : undefined,
      text,
      mentionsIds: [],
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    qc.setQueryData<ChatMessage[]>(messagesKey, (cur) => optimistic.append(cur, optimisticMsg));
    setInput('');
    // 2) actually send
    sendMut.mutate({ roomId: activeId, text });
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

  const activeRoom = rooms.find((r) => r.id === activeId);

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
            {showNewDirect ? (
              <div style={{ padding: 12 }}>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.10em',
                  color: 'var(--text-soft)',
                  margin: '4px 8px 8px',
                  textTransform: 'uppercase',
                }}>Выбери собеседника</div>
                {users.filter((u) => u.id !== me?.id).map((u) => (
                  <button
                    key={u.id}
                    onClick={() => startDirect(u.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 10,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: 'var(--primary)',
                      color: 'var(--text)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--font-display)',
                      fontWeight: 600, fontSize: 12,
                    }}>{initials(u.fullName)}</div>
                    <div style={{ fontSize: 14 }}>{u.fullName}</div>
                  </button>
                ))}
              </div>
            ) : showNewTeam ? (
              <NewTeamForm
                users={users.filter((u) => u.id !== me?.id)}
                onCreate={async (title, memberIds) => {
                  const room = await createTeamRoom(title, memberIds);
                  setShowNewTeam(false);
                  qc.invalidateQueries({ queryKey: roomsKey });
                  setActiveId(room.id);
                }}
                onCancel={() => setShowNewTeam(false)}
              />
            ) : (
              rooms.map((r) => {
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
              })
            )}
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
              const isMine = m.authorId === me?.id;
              const prev = messages[i - 1];
              const showHeader = !prev || prev.authorId !== m.authorId ||
                new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60 * 1000;
              const isBot = m.mentionsIds?.includes('__BOT__');
              const isMentionedMe = me?.id && m.mentionsIds?.includes(me.id);
              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    display: 'flex',
                    flexDirection: isBot ? 'row' : (isMine ? 'row-reverse' : 'row'),
                    gap: 10,
                    marginBottom: showHeader ? 14 : 4,
                    alignItems: 'flex-end',
                  }}
                >
                  {showHeader || isBot ? (
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: isBot ? 'linear-gradient(135deg, var(--primary), var(--text))' : (isMine ? 'var(--primary)' : 'var(--text)'),
                      color: isMine && !isBot ? 'var(--text)' : 'white',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--font-display)',
                      fontWeight: 600, fontSize: 11,
                      flexShrink: 0,
                    }}>{isBot ? '🤖' : initials(m.author?.fullName || '?')}</div>
                  ) : <div style={{ width: 32 }} />}
                  <div style={{ maxWidth: '70%' }}>
                    {(showHeader || isBot) && (
                      <div style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        letterSpacing: '0.08em',
                        color: 'var(--text-light)',
                        textAlign: isBot ? 'left' : (isMine ? 'right' : 'left'),
                        marginBottom: 4,
                        textTransform: 'uppercase',
                      }}>
                        {isBot ? 'Javonon AI · BOT' : (isMine ? 'Вы' : m.author?.fullName)} · {fmtTime(m.createdAt)}
                      </div>
                    )}
                    <div style={{
                      background: isBot
                        ? 'linear-gradient(135deg, rgba(1, 54, 139,0.10), rgba(0,0,0,0.04))'
                        : isMentionedMe && !isMine
                          ? 'var(--primary-soft)'
                          : isMine
                            ? 'var(--text)'
                            : 'var(--bg-soft)',
                      color: isBot ? 'var(--text)' : (isMine ? 'white' : 'var(--text)'),
                      padding: '10px 14px',
                      borderRadius: 14,
                      fontSize: 14,
                      lineHeight: 1.5,
                      wordWrap: 'break-word',
                      border: isMentionedMe && !isMine ? '1px solid var(--primary)' : undefined,
                    }}>
                      {renderMessageWithMentions(m.text)}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>

          <form onSubmit={send} style={{
            padding: '16px 20px',
            borderTop: '1px solid var(--border-soft)',
            display: 'flex',
            gap: 8,
          }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Напиши сообщение..."
              style={{
                flex: 1,
                padding: '12px 16px',
                border: '1px solid var(--border)',
                borderRadius: 100,
                fontSize: 14,
                fontFamily: 'inherit',
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
              <Icon name="send" size={16} />
            </button>
          </form>
        </div>
      </div>
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
            style={{
              fontWeight: 600,
              color: 'var(--primary-dark)',
              background: 'rgba(1, 54, 139,0.16)',
              padding: '0 4px',
              borderRadius: 4,
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
