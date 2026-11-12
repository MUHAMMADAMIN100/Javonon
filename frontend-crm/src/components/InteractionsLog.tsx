import { fmtDateText, TJ_TZ, tjDateInput, tjFormatTime, tjToday, addDaysYmd } from '../lib/tjTime';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { roleCan } from '../lib/permissions';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Interaction,
  InteractionType,
  INTERACTION_LABEL,
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
import { timelineVisuals, type TimelineKind } from '../lib/timeline';
import { EmptyLine } from './ClientCard';
import DismissedMark from './DismissedMark';
import BusyLabel from './BusyLabel';

const TYPES: InteractionType[] = ['CALL', 'WHATSAPP', 'MEETING', 'NOTE', 'TELEGRAM', 'SMS', 'EMAIL'];
type Filter = 'all' | TimelineKind;
const FILTERS: Filter[] = ['all', 'call', 'message', 'meeting', 'note'];

/** «Сегодня», «Вчера», «5 ноября» (с годом — если не текущий). По Душанбе. */
function dayLabel(ymd: string) {
  const today = tjToday();
  if (ymd === today) return tr('tl.today');
  if (ymd === addDaysYmd(today, -1)) return tr('tl.yesterday');
  const d = new Date(`${ymd}T12:00:00Z`);
  const sameYear = ymd.slice(0, 4) === today.slice(0, 4);
  return fmtDateText(d, { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }), timeZone: TJ_TZ });
}

/**
 * История общения клиента — лентой по дням (макет UI 11.11.2026): ручные
 * записи, звонки телефонии и переписка вместе; фильтр «Звонки / Переписка /
 * Встречи / Заметки»; у ручной записи — метка «видно студенту» или «внутреннее».
 */
export default function InteractionsLog({ studentId, canEdit = true }: { studentId: string; canEdit?: boolean }) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const me = useAuth((st) => st.user);
  const elevated = isElevated(me);
  // Роль: добавлять — «История контактов — добавление», удалять — только свои
  // записи с «… — удаление» (сервер то же: interactions.service).
  const canAdd = canEdit && roleCan(me, 'interactions:create');
  const canRemove = canEdit && roleCan(me, 'interactions:delete');
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const listKey = keys.interactions.list(studentId);
  // Тот же ключ, что у «Обзора» карточки (ClientTabs.timelineKey) — один запрос.
  const timelineKey = ['interactions', 'timeline', studentId] as const;
  const timelineQuery = useQuery<TimelineItem[]>({
    queryKey: timelineKey,
    queryFn: () => fullTimeline(studentId),
    enabled: !!studentId,
  });
  const items = [...(timelineQuery.data ?? [])].sort((x, y) => y.occurredAt.localeCompare(x.occurredAt));

  useRealtimeEvent('interaction:new', () => {
    qc.invalidateQueries({ queryKey: listKey });
    qc.invalidateQueries({ queryKey: timelineKey });
  });

  const createMut = useInvalidatingMutation({
    mutationFn: createInteraction,
    invalidate: [listKey, timelineKey],
    onSuccess: () => {
      toast(t('toast.created'), 'success');
      setShowForm(false);
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteMut = useOptimisticMutation<unknown, string, TimelineItem[]>({
    mutationFn: deleteInteraction,
    queryKey: timelineKey as unknown as readonly unknown[],
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [listKey],
    onSuccess: () => toast(t('toast.deleted'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onCreate = (data: { type: InteractionType; summary: string; details?: string; visibleToStudent: boolean }) => {
    createMut.mutate({ ...data, studentId });
  };

  const onDelete = async (it: TimelineItem) => {
    // Удаляем только ручные записи. Звонки и переписка — внешние данные.
    if (it.source && it.source !== 'interaction') return;
    const ok = await confirm({ title: t('common.delete'), message: it.summary, danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    deleteMut.mutate(it.id);
  };

  const addButton = canAdd && !showForm && (
    <button className="btn btn-sm btn-primary" onClick={() => setShowForm(true)} data-testid="interaction-add">
      <Icon name="add" size={14} /> {t('tl.add')}
    </button>
  );
  const loading = timelineQuery.isLoading;

  // Записей нет — одной строкой, как пустые блоки карточки сотрудника.
  if (!loading && items.length === 0 && !showForm) {
    return <EmptyLine title={t('interactions.title')} text={t('interactions.emptyLine')} testId="interactions-empty" actions={addButton || undefined} />;
  }

  const kindOf = (it: TimelineItem) => timelineVisuals(it, t).kind;
  const counts = FILTERS.reduce<Record<Filter, number>>((acc, f) => {
    acc[f] = f === 'all' ? items.length : items.filter((it) => kindOf(it) === f).length;
    return acc;
  }, {} as Record<Filter, number>);
  const shown = filter === 'all' ? items : items.filter((it) => kindOf(it) === filter);
  const days: { ymd: string; list: TimelineItem[] }[] = [];
  for (const it of shown) {
    const ymd = tjDateInput(it.occurredAt);
    const last = days[days.length - 1];
    if (last && last.ymd === ymd) last.list.push(it);
    else days.push({ ymd, list: [it] });
  }

  return (
    <section className="card profile-section" data-testid="interactions">
      <div className="client-block-head">
        <h3 className="profile-h">
          {t('interactions.title')}
          {items.length > 0 && <span className="client-count">{items.length}</span>}
        </h3>
        <div className="client-block-actions">{addButton}</div>
      </div>

      <AnimatePresence>
        {showForm && canAdd && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: 'hidden', marginBottom: 16 }}
          >
            <NewInteractionForm onSubmit={onCreate} onCancel={() => setShowForm(false)} busy={createMut.isPending} />
          </motion.div>
        )}
      </AnimatePresence>

      {items.length > 0 && (
        <div className="tl-filter" role="radiogroup" aria-label={t('tl.show')} data-testid="tl-filter">
          <span className="tl-filter-label">{t('tl.show')}</span>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              className={`tl-chip${filter === f ? ' active' : ''}`}
              onClick={() => setFilter(f)}
              disabled={f !== 'all' && counts[f] === 0}
              data-testid={`tl-filter-${f}`}
            >
              {t(`tl.filter.${f}`)} <span className="tl-chip-n">{counts[f]}</span>
            </button>
          ))}
        </div>
      )}

      {loading && <div className="profile-empty" style={{ padding: '4px 0' }}>{t('common.loading')}</div>}
      {!loading && shown.length === 0 && items.length > 0 && <div className="profile-empty" style={{ padding: '4px 0' }}>{t('tl.filter.none')}</div>}

      <div className="tl-feed">
        {days.map((day) => (
          <div key={day.ymd} className="tl-day" data-testid="tl-day">
            <div className="tl-day-label">{dayLabel(day.ymd)}</div>
            <ul className="tl-list">
              {day.list.map((it) => {
                const vis = timelineVisuals(it, t);
                const isInteraction = !it.source || it.source === 'interaction';
                // QA-2 №12: нет признака — не показываем «видно студенту».
                const visible = (it as unknown as Interaction).visibleToStudent === true;
                const dur = it.durationSeconds;
                const meta = [
                  tjFormatTime(it.occurredAt),
                  it.author?.fullName,
                  dur !== undefined ? `${Math.floor(dur / 60)} ${tr('time.m')} ${dur % 60} ${tr('time.sec')}` : '',
                ].filter(Boolean).join(' · ');
                return (
                  <li key={`${it.source || 'interaction'}-${it.id}`} className={`tl-item k-${vis.kind}`} data-testid="tl-item">
                    <span className="tl-icon" aria-hidden="true"><Icon name={vis.icon} size={18} /></span>
                    <div className="tl-body">
                      <div className="tl-head">
                        <b>{vis.label}</b>
                        {isInteraction && (visible ? (
                          <span className="tl-tag is-visible" data-testid="interaction-visible" title={t('interactions.visibleToStudent')}>
                            <Icon name="visibility" size={12} /> {t('interactions.visibleMark')}
                          </span>
                        ) : (
                          <span className="tl-tag">{t('interactions.internal')}</span>
                        ))}
                      </div>
                      <div className="tl-meta">
                        {meta}
                        {it.author && <DismissedMark person={it.author} />}
                      </div>
                      <div className="tl-text">{it.summary}</div>
                      {it.details && <div className="tl-details">{it.details}</div>}
                      {it.recordingUrl && <audio src={it.recordingUrl} controls preload="none" className="tl-audio" />}
                    </div>
                    {/* Удалять — автору или руководству (так же проверяет сервер). */}
                    {canRemove && isInteraction && (elevated || (it as unknown as Interaction).authorId === me?.id || it.author?.id === me?.id) && (
                      <button className="btn btn-sm btn-secondary tl-del" data-testid="interaction-delete" onClick={() => onDelete(it)} aria-label={t('common.delete')} title={t('common.delete')}>
                        <Icon name="delete" size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function NewInteractionForm({
  onSubmit,
  onCancel,
  busy,
}: {
  onSubmit: (data: { type: InteractionType; summary: string; details?: string; visibleToStudent: boolean }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useT();
  const [type, setType] = useState<InteractionType>('CALL');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  // По умолчанию запись ВНУТРЕННЯЯ: студенту её показывают осознанно
  // (QA №30 — раньше даже «Заметка» сразу уходила в кабинет студента).
  const [visibleToStudent, setVisibleToStudent] = useState(false);

  return (
    <form
      className="tl-form"
      onSubmit={(e) => { e.preventDefault(); onSubmit({ type, summary, details: details || undefined, visibleToStudent }); }}
      data-testid="interaction-form"
    >
      <div className="tl-form-title">{t('tl.newEntry')}</div>
      <div className="tl-types" role="radiogroup" aria-label={t('tl.type')}>
        {TYPES.map((tp) => (
          <button
            key={tp}
            type="button"
            role="radio"
            aria-checked={type === tp}
            onClick={() => setType(tp)}
            className={`tl-chip${type === tp ? ' active' : ''}`}
          >
            {INTERACTION_LABEL[tp]}
          </button>
        ))}
      </div>
      <label className="tl-field">
        <span>{t('interactions.field.summary')}</span>
        <input className="crm-input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={t('tl.summary.ph')} required />
      </label>
      <label className="tl-field">
        <span>{t('interactions.field.details')} <small>{t('tl.optional')}</small></span>
        <textarea className="crm-textarea" value={details} onChange={(e) => setDetails(e.target.value)} rows={3} />
      </label>
      <label className="tl-check">
        <input type="checkbox" className="crm-checkbox" checked={visibleToStudent} onChange={(e) => setVisibleToStudent(e.target.checked)} />
        {t('tl.visible')}
      </label>
      <div className="tl-form-actions">
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!summary.trim() || busy} data-testid="interaction-save">
          <BusyLabel busy={busy}>{t('tl.addEntry')}</BusyLabel>
        </button>
      </div>
    </form>
  );
}
