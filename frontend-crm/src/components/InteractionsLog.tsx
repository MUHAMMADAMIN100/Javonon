import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Interaction,
  InteractionType,
  INTERACTION_LABEL,
  INTERACTION_ICON,
  listInteractions,
  fullTimeline,
  type TimelineItem,
  createInteraction,
  deleteInteraction,
} from '../api/interactions';
import { useUI } from '../ui/Dialogs';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';

const TYPES: InteractionType[] = ['CALL', 'EMAIL', 'MEETING', 'NOTE', 'SMS', 'TELEGRAM', 'WHATSAPP'];

function fmtRelative(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin || 1} мин назад`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} ч назад`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD} д назад`;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function InteractionsLog({ studentId, canEdit = true }: { studentId: string; canEdit?: boolean }) {
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  // По ТЗ §8 «вся связанная информация» — переключатель показывает либо
  // только ручные записи (старое поведение), либо полную ленту (звонки
  // через dialpad + WhatsApp/IG/SMS переписка + ручные записи).
  const [showFullTimeline, setShowFullTimeline] = useState(true);

  const listKey = keys.interactions.list(studentId);
  const interactionsQuery = useQuery<Interaction[]>({
    queryKey: listKey,
    queryFn: () => listInteractions(studentId),
    enabled: !!studentId && !showFullTimeline,
  });
  const timelineKey = ['interactions', 'timeline', studentId] as const;
  const timelineQuery = useQuery<TimelineItem[]>({
    queryKey: timelineKey,
    queryFn: () => fullTimeline(studentId),
    enabled: !!studentId && showFullTimeline,
  });
  const items = showFullTimeline ? (timelineQuery.data ?? []) : (interactionsQuery.data ?? []);

  useRealtimeEvent('interaction:new', () => {
    qc.invalidateQueries({ queryKey: listKey });
    qc.invalidateQueries({ queryKey: timelineKey });
  });

  const createMut = useInvalidatingMutation({
    mutationFn: createInteraction,
    invalidate: [listKey],
    onSuccess: () => {
      toast('Запись добавлена', 'success');
      setShowForm(false);
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const deleteMut = useOptimisticMutation<unknown, string, Interaction[]>({
    mutationFn: deleteInteraction,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    onSuccess: () => toast('Удалено', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onCreate = (data: { type: InteractionType; summary: string; details?: string; visibleToStudent: boolean }) => {
    createMut.mutate({ ...data, studentId });
  };

  const onDelete = async (it: Interaction | TimelineItem) => {
    // Удаляем только записи типа Interaction. CallLog/ExternalMessage —
    // источники внешних данных, удалять их с этой ленты бессмысленно.
    const source = (it as any).source;
    if (source && source !== 'interaction') return;
    const ok = await confirm({
      title: 'Удалить запись?',
      message: it.summary,
      danger: true,
      confirmText: 'Удалить',
    });
    if (!ok) return;
    deleteMut.mutate(it.id);
  };

  /** Преобразует TimelineItem в визуальные параметры (label, icon, type). */
  const resolveVisuals = (it: Interaction | TimelineItem): { label: string; icon: string; bg: string } => {
    // Старая модель Interaction всегда имеет type.
    if ('type' in it && it.type && !(it as any).source) {
      return {
        label: INTERACTION_LABEL[it.type as InteractionType] || it.type,
        icon: INTERACTION_ICON[it.type as InteractionType] || 'chat',
        bg: 'var(--primary-soft)',
      };
    }
    const t = it as TimelineItem;
    if (t.source === 'call') {
      return {
        label: t.direction === 'INCOMING' ? 'Звонок входящий' : 'Звонок исходящий',
        icon: 'call',
        bg: '#dbeafe',
      };
    }
    if (t.source === 'message') {
      const labels: Record<string, string> = {
        WHATSAPP: 'WhatsApp',
        INSTAGRAM: 'Instagram',
        TELEGRAM: 'Telegram',
        SMS: 'SMS',
      };
      return {
        label: `${labels[t.channel || ''] || t.channel} ${t.direction === 'IN' ? 'от клиента' : 'клиенту'}`,
        icon: t.channel === 'INSTAGRAM' ? 'photo_camera' : t.channel === 'SMS' ? 'sms' : 'chat_bubble',
        bg: '#fce7f3',
      };
    }
    return {
      label: t.type ? INTERACTION_LABEL[t.type] : 'Запись',
      icon: t.type ? INTERACTION_ICON[t.type] : 'chat',
      bg: 'var(--primary-soft)',
    };
  };

  return (
    <div className="card" style={{ padding: 28, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            color: 'var(--primary-dark)',
            marginBottom: 6,
            textTransform: 'uppercase',
          }}>INTERACTIONS · {items.length}</div>
          <h3 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 500,
            letterSpacing: '-0.02em',
          }}>
            История <em style={{
              fontFamily: 'Times New Roman, Georgia, serif',
              fontWeight: 400,
              color: 'var(--primary-dark)',
            }}>общения.</em>
          </h3>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setShowFullTimeline((v) => !v)}
            style={{
              padding: '6px 12px',
              borderRadius: 999,
              border: '1.5px solid var(--border)',
              background: showFullTimeline ? 'var(--primary-light)' : 'transparent',
              color: showFullTimeline ? 'var(--primary-dark)' : 'var(--text-soft)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
            title="Включает звонки и переписку из WhatsApp/IG/SMS"
          >
            {showFullTimeline ? '◉ Полная история' : '○ Полная история'}
          </button>
          {canEdit && !showForm && (
            <button className="btn btn-sm btn-primary" onClick={() => setShowForm(true)}>
              <Icon name="add" size={14} /> Добавить
            </button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {showForm && canEdit && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: 'hidden', marginBottom: 16 }}
          >
            <NewInteractionForm onSubmit={onCreate} onCancel={() => setShowForm(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.length === 0 && (
          <div className="empty" style={{ padding: 32 }}>Записей пока нет</div>
        )}
        {items.map((it) => {
          const vis = resolveVisuals(it);
          const source = (it as any).source;
          const isInteraction = !source || source === 'interaction';
          const visibleToStudent = (it as any).visibleToStudent ?? true;
          return (
          <motion.div
            key={`${source || 'interaction'}-${it.id}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              display: 'flex',
              gap: 14,
              padding: 16,
              border: '1px solid var(--border-soft)',
              borderRadius: 14,
              background: isInteraction && !visibleToStudent ? 'var(--bg-soft)' : 'white',
              borderLeft: `3px solid ${isInteraction && visibleToStudent ? 'var(--primary)' : 'var(--text-light)'}`,
            }}
          >
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: vis.bg,
              color: 'var(--primary-dark)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <Icon name={vis.icon} size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  color: 'var(--primary-dark)',
                }}>{vis.label}</span>
                {isInteraction && !visibleToStudent && (
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--text-light)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.10em',
                  }}>· внутреннее</span>
                )}
                {(it as TimelineItem).durationSeconds !== undefined && (
                  <span style={{ fontSize: 11, color: 'var(--text-soft)', fontFamily: 'var(--font-mono)' }}>
                    · {Math.floor((it as TimelineItem).durationSeconds! / 60)}м {(it as TimelineItem).durationSeconds! % 60}с
                  </span>
                )}
                <span style={{ fontSize: 11, color: 'var(--text-light)', marginLeft: 'auto' }}>
                  {fmtRelative(it.occurredAt)}
                </span>
              </div>
              <div style={{ fontWeight: 500, fontSize: 14, marginBottom: it.details ? 4 : 0 }}>{it.summary}</div>
              {it.details && (
                <div style={{ fontSize: 13, color: 'var(--text-soft)', whiteSpace: 'pre-wrap', marginTop: 4 }}>{it.details}</div>
              )}
              {(it as TimelineItem).recordingUrl && (
                <audio src={(it as TimelineItem).recordingUrl!} controls preload="none" style={{ height: 32, marginTop: 6, width: '100%', maxWidth: 280 }} />
              )}
              {it.author && (
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.06em',
                  color: 'var(--text-light)',
                  marginTop: 8,
                }}>
                  {it.author.fullName}
                </div>
              )}
            </div>
            {canEdit && isInteraction && (
              <button className="btn btn-sm btn-danger" onClick={() => onDelete(it)} style={{ alignSelf: 'flex-start' }}>
                <Icon name="delete" size={14} />
              </button>
            )}
          </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function NewInteractionForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (data: { type: InteractionType; summary: string; details?: string; visibleToStudent: boolean }) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<InteractionType>('CALL');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [visibleToStudent, setVisibleToStudent] = useState(true);

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ type, summary, details: details || undefined, visibleToStudent }); }}
      style={{
        background: 'var(--bg-soft)',
        padding: 20,
        borderRadius: 14,
        border: '1px solid var(--border-soft)',
      }}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`btn btn-sm ${type === t ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '6px 12px' }}
          >
            {INTERACTION_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="form-group">
        <label>Краткое описание</label>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Например: позвонил, договорились перезвонить во вторник"
          required
        />
      </div>
      <div className="form-group">
        <label>Подробности (опционально)</label>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={3}
          placeholder="Длинная заметка"
        />
      </div>
      <label style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 16,
        fontSize: 13,
        cursor: 'pointer',
      }}>
        <input
          type="checkbox"
          checked={visibleToStudent}
          onChange={(e) => setVisibleToStudent(e.target.checked)}
          style={{ width: 16, height: 16 }}
        />
        Видно студенту в его кабинете
      </label>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>Отмена</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!summary.trim()}>Сохранить</button>
      </div>
    </form>
  );
}
