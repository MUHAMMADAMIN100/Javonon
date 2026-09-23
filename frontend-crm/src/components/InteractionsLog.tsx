import { fmtDateText, TJ_TZ } from '../lib/tjTime';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
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
import { tr, useT } from '../lib/i18n';
import { EmptyLine } from './ClientCard';

const TYPES: InteractionType[] = ['CALL', 'EMAIL', 'MEETING', 'NOTE', 'SMS', 'TELEGRAM', 'WHATSAPP'];

function fmtRelative(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return tr('ago.min').replace('{n}', String(diffMin || 1));
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return tr('ago.h').replace('{n}', String(diffH));
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return tr('ago.d').replace('{n}', String(diffD));
  return fmtDateText(d, { day: '2-digit', month: 'short', year: 'numeric', timeZone: TJ_TZ });
}

export default function InteractionsLog({ studentId, canEdit = true }: { studentId: string; canEdit?: boolean }) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const me = useAuth((st) => st.user);
  const elevated = isElevated(me);
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
    // Полная лента открыта по умолчанию — без её сброса новая запись
    // появлялась только после события по сокету.
    invalidate: [listKey, timelineKey],
    onSuccess: () => {
      toast(t('toast.created'), 'success');
      setShowForm(false);
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteMut = useOptimisticMutation<unknown, string, Interaction[]>({
    mutationFn: deleteInteraction,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [timelineKey],
    onSuccess: () => toast(t('toast.deleted'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
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
      title: t('common.delete'),
      message: it.summary,
      danger: true,
      confirmText: t('common.delete'),
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
    const item = it as TimelineItem;
    if (item.source === 'call') {
      return {
        label: item.direction === 'INCOMING' ? t('interactions.call.in') : t('interactions.call.out'),
        icon: 'call',
        bg: '#dbeafe',
      };
    }
    if (item.source === 'message') {
      const labels: Record<string, string> = {
        WHATSAPP: 'WhatsApp',
        INSTAGRAM: 'Instagram',
        TELEGRAM: 'Telegram',
        SMS: 'SMS',
      };
      return {
        label: `${labels[item.channel || ''] || item.channel} ${item.direction === 'IN' ? t('interactions.from') : t('interactions.to')}`,
        icon: item.channel === 'INSTAGRAM' ? 'photo_camera' : item.channel === 'SMS' ? 'sms' : 'chat_bubble',
        bg: '#fce7f3',
      };
    }
    return {
      label: item.type ? INTERACTION_LABEL[item.type] : t('interactions.entry'),
      icon: item.type ? INTERACTION_ICON[item.type] : 'chat',
      bg: 'var(--primary-soft)',
    };
  };

  const timelineToggle = (
    <button
      type="button"
      onClick={() => setShowFullTimeline((v) => !v)}
      className={`client-toggle${showFullTimeline ? ' is-on' : ''}`}
      title={t('interactions.fullTimeline')}
      data-testid="interactions-full-toggle"
    >
      {showFullTimeline ? '◉ ' : '○ '}{t('interactions.fullTimeline')}
    </button>
  );
  const addButton = canEdit && !showForm && (
    <button className="btn btn-sm btn-primary" onClick={() => setShowForm(true)} data-testid="interaction-add">
      <Icon name="add" size={14} /> {t('common.add')}
    </button>
  );
  const loading = showFullTimeline ? timelineQuery.isLoading : interactionsQuery.isLoading;

  // Записей нет — одной строкой, как пустые блоки карточки сотрудника.
  // Переключатель ленты нужен только чтобы вернуться к полной ленте: в ней
  // и так есть все ручные записи.
  if (!loading && items.length === 0 && !showForm) {
    return (
      <EmptyLine
        title={t('interactions.title')}
        text={t('interactions.emptyLine')}
        testId="interactions-empty"
        actions={<>{!showFullTimeline && timelineToggle}{addButton}</>}
      />
    );
  }

  return (
    <section className="card profile-section" data-testid="interactions">
      <div className="client-block-head">
        <h3 className="profile-h">
          {t('interactions.title')}
          {items.length > 0 && <span className="client-count">{items.length}</span>}
        </h3>
        <div className="client-block-actions">
          {timelineToggle}
          {addButton}
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
          <div className="profile-empty" style={{ padding: '4px 0' }}>{loading ? t('common.loading') : t('interactions.emptyLine')}</div>
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
                  }}>· {t('interactions.internal')}</span>
                )}
                {(it as TimelineItem).durationSeconds !== undefined && (
                  <span style={{ fontSize: 11, color: 'var(--text-soft)', fontFamily: 'var(--font-mono)' }}>
                    · {Math.floor((it as TimelineItem).durationSeconds! / 60)}{tr('time.m')} {(it as TimelineItem).durationSeconds! % 60}{tr('time.sec')}
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
            {/* Удалять — автору или руководству (так же проверяет сервер). */}
            {canEdit && isInteraction && (elevated || (it as any).authorId === me?.id || it.author?.id === me?.id) && (
              <button className="btn btn-sm btn-danger" data-testid="interaction-delete" onClick={() => onDelete(it)} style={{ alignSelf: 'flex-start' }}>
                <Icon name="delete" size={14} />
              </button>
            )}
          </motion.div>
          );
        })}
      </div>
    </section>
  );
}

function NewInteractionForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (data: { type: InteractionType; summary: string; details?: string; visibleToStudent: boolean }) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
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
        {TYPES.map((tp) => (
          <button
            key={tp}
            type="button"
            onClick={() => setType(tp)}
            className={`btn btn-sm ${type === tp ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '6px 12px' }}
          >
            {INTERACTION_LABEL[tp]}
          </button>
        ))}
      </div>
      <div className="form-group">
        <label>{t('interactions.field.summary')}</label>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          required
        />
      </div>
      <div className="form-group">
        <label>{t('interactions.field.details')}</label>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={3}
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
        {t('interactions.visibleToStudent')}
      </label>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!summary.trim()}>{t('common.save')}</button>
      </div>
    </form>
  );
}
