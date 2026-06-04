import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import {
  InboxChannel,
  InboxMessage,
  INBOX_CHANNEL_LABEL,
  INBOX_CHANNEL_ICON,
  inboxThreads,
  inboxThread,
  sendWhatsapp,
  sendInstagram,
} from '../api/inbox';

const CHANNEL_COLOR: Record<InboxChannel, string> = {
  WHATSAPP: '#25d366',
  INSTAGRAM: '#e1306c',
  TELEGRAM: '#0088cc',
  SMS: '#94a3b8',
};

export default function Inbox() {
  const [channelFilter, setChannelFilter] = useState<InboxChannel | ''>('');
  const [selected, setSelected] = useState<{ channel: InboxChannel; handle: string } | null>(null);

  const threadsQuery = useQuery({
    queryKey: ['inbox', 'threads', channelFilter || 'all'],
    queryFn: () => inboxThreads(channelFilter || undefined),
    // Реалтайм обновления — обновляем каждые 15с (вместо WebSocket для простоты).
    refetchInterval: 15_000,
  });
  const threads = threadsQuery.data ?? [];

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">UNIFIED INBOX</span>
        <h2 className="crm-section-title">
          Входящие <em>сообщения.</em>
        </h2>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 360px) 1fr',
        gap: 16,
        minHeight: 'calc(100vh - 200px)',
      }}>
        {/* Левая колонка — список диалогов */}
        <motion.div
          className="card"
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <ChannelTab active={channelFilter === ''} onClick={() => setChannelFilter('')} label="Все" />
              {(['WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'SMS'] as InboxChannel[]).map((ch) => (
                <ChannelTab
                  key={ch}
                  active={channelFilter === ch}
                  onClick={() => setChannelFilter(ch)}
                  label={INBOX_CHANNEL_LABEL[ch]}
                  color={CHANNEL_COLOR[ch]}
                />
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {threadsQuery.isLoading && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-soft)' }}>Загружаем…</div>
            )}
            {threads.length === 0 && !threadsQuery.isLoading && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-soft)', fontSize: 13 }}>
                Входящих ещё нет.<br />
                <span style={{ fontSize: 11 }}>Для WhatsApp/Instagram нужно настроить webhook URL в Meta Business Suite.</span>
              </div>
            )}
            {threads.map((t) => {
              const handle = t.direction === 'IN' ? t.fromHandle : t.toHandle;
              if (!handle) return null;
              const isSelected = selected?.channel === t.channel && selected?.handle === handle;
              return (
                <button
                  key={t.id}
                  onClick={() => setSelected({ channel: t.channel, handle })}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '12px 14px',
                    textAlign: 'left',
                    border: 'none',
                    borderBottom: '1px solid var(--border-soft)',
                    background: isSelected ? 'var(--bg-soft)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Icon name={INBOX_CHANNEL_ICON[t.channel]} size={14} style={{ color: CHANNEL_COLOR[t.channel] }} />
                    <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {handle}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-soft)' }}>
                      {new Date(t.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
                    </span>
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: 'var(--text-soft)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {t.direction === 'OUT' && '→ '}
                    {t.content || (t.mediaUrl ? '📎 файл' : '—')}
                  </div>
                </button>
              );
            })}
          </div>
        </motion.div>

        {/* Правая колонка — переписка */}
        <motion.div
          className="card"
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          style={{ padding: 0, display: 'flex', flexDirection: 'column' }}
        >
          {selected ? (
            <ThreadView
              channel={selected.channel}
              handle={selected.handle}
              onClose={() => setSelected(null)}
            />
          ) : (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-soft)', padding: 40, textAlign: 'center',
            }}>
              Выбери диалог слева
            </div>
          )}
        </motion.div>
      </div>
    </>
  );
}

function ChannelTab({ active, onClick, label, color }: { active: boolean; onClick: () => void; label: string; color?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px',
        borderRadius: 999,
        border: '1.5px solid',
        borderColor: active ? (color || 'var(--primary)') : 'var(--border)',
        background: active ? `${color || 'var(--primary)'}20` : 'transparent',
        color: active ? (color || 'var(--primary-dark)') : 'var(--text-soft)',
        fontSize: 12, fontWeight: 600, cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function ThreadView({ channel, handle, onClose }: { channel: InboxChannel; handle: string; onClose: () => void }) {
  const { toast } = useUI();
  const qc = useQueryClient();
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const query = useQuery({
    queryKey: ['inbox', 'thread', channel, handle],
    queryFn: () => inboxThread(channel, handle),
    refetchInterval: 10_000,
  });
  const messages = query.data ?? [];

  const send = async () => {
    if (!reply.trim()) return;
    setSending(true);
    try {
      if (channel === 'WHATSAPP') {
        await sendWhatsapp(handle.replace(/^\+/, ''), reply.trim());
      } else if (channel === 'INSTAGRAM') {
        await sendInstagram(handle, reply.trim());
      } else {
        toast(`Отправка через ${INBOX_CHANNEL_LABEL[channel]} пока не поддержана из UI`, 'info');
        setSending(false);
        return;
      }
      setReply('');
      qc.invalidateQueries({ queryKey: ['inbox', 'thread', channel, handle] });
      qc.invalidateQueries({ queryKey: ['inbox', 'threads'] });
      toast('Отправлено', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка отправки', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <Icon name={INBOX_CHANNEL_ICON[channel]} size={18} style={{ color: CHANNEL_COLOR[channel] }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{handle}</div>
          <div style={{ fontSize: 11, color: 'var(--text-soft)' }}>{INBOX_CHANNEL_LABEL[channel]}</div>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div style={{
        flex: 1, overflowY: 'auto', padding: 16,
        display: 'flex', flexDirection: 'column', gap: 8,
        minHeight: 300,
      }}>
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-soft)', padding: 24 }}>
            Сообщений пока нет
          </div>
        )}
      </div>
      <div style={{
        padding: 12,
        borderTop: '1px solid var(--border)',
        display: 'flex',
        gap: 8,
      }}>
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
          placeholder={`Ответить через ${INBOX_CHANNEL_LABEL[channel]}…`}
          style={{ flex: 1 }}
          disabled={sending}
        />
        <button className="btn btn-primary" onClick={send} disabled={!reply.trim() || sending}>
          <Icon name="send" size={14} />
        </button>
      </div>
    </>
  );
}

function MessageBubble({ message }: { message: InboxMessage }) {
  const isIn = message.direction === 'IN';
  return (
    <div style={{
      alignSelf: isIn ? 'flex-start' : 'flex-end',
      maxWidth: '70%',
      padding: '8px 12px',
      borderRadius: 12,
      background: isIn ? 'var(--bg-soft)' : 'var(--primary)',
      color: isIn ? 'var(--text)' : 'white',
      fontSize: 13,
      lineHeight: 1.4,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      {message.content || (message.mediaUrl ? '📎 файл' : '')}
      <div style={{
        fontSize: 10,
        opacity: 0.7,
        marginTop: 4,
      }}>
        {new Date(message.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        {message.status === 'FAILED' && ' · ✗'}
      </div>
    </div>
  );
}
