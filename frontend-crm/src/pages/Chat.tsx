import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ChatRoom,
  ChatMessage,
  listChatRooms,
  getChatRoom,
  sendChatMessage,
  createDirectRoom,
} from '../api/chat';
import { listUsers } from '../api/users';
import { useAuth } from '../store/auth';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';

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
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [showNewDirect, setShowNewDirect] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshRooms = async () => {
    const r = await listChatRooms();
    setRooms(r);
    if (!activeId && r.length) setActiveId(r[0].id);
  };

  useEffect(() => { refreshRooms(); }, []);

  useEffect(() => {
    if (!activeId) return;
    getChatRoom(activeId).then((d) => setMessages(d.messages)).catch(() => {});
  }, [activeId]);

  useEffect(() => {
    listUsers().then(setUsers).catch(() => {});
  }, []);

  useRealtimeEvent('chat:message', (data: any) => {
    if (data.roomId === activeId) {
      setMessages((prev) => [...prev, data.message]);
    }
    refreshRooms();
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeId || !input.trim()) return;
    try {
      const msg = await sendChatMessage(activeId, input);
      setMessages((prev) => [...prev, msg]);
      setInput('');
      refreshRooms();
    } catch {}
  };

  const startDirect = async (userId: string) => {
    const room = await createDirectRoom(userId);
    setShowNewDirect(false);
    await refreshRooms();
    setActiveId(room.id);
  };

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
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setShowNewDirect((v) => !v)}
              title="Новый личный чат"
            >
              <Icon name={showNewDirect ? 'close' : 'add'} size={14} />
            </button>
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
              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    display: 'flex',
                    flexDirection: isMine ? 'row-reverse' : 'row',
                    gap: 10,
                    marginBottom: showHeader ? 14 : 4,
                    alignItems: 'flex-end',
                  }}
                >
                  {showHeader ? (
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: isMine ? 'var(--primary)' : 'var(--text)',
                      color: isMine ? 'var(--text)' : 'white',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--font-display)',
                      fontWeight: 600, fontSize: 11,
                      flexShrink: 0,
                    }}>{initials(m.author?.fullName || '?')}</div>
                  ) : <div style={{ width: 32 }} />}
                  <div style={{ maxWidth: '70%' }}>
                    {showHeader && (
                      <div style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        letterSpacing: '0.08em',
                        color: 'var(--text-light)',
                        textAlign: isMine ? 'right' : 'left',
                        marginBottom: 4,
                        textTransform: 'uppercase',
                      }}>
                        {isMine ? 'Вы' : m.author?.fullName} · {fmtTime(m.createdAt)}
                      </div>
                    )}
                    <div style={{
                      background: isMine ? 'var(--text)' : 'var(--bg-soft)',
                      color: isMine ? 'white' : 'var(--text)',
                      padding: '10px 14px',
                      borderRadius: 14,
                      fontSize: 14,
                      lineHeight: 1.5,
                      wordWrap: 'break-word',
                    }}>{m.text}</div>
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
