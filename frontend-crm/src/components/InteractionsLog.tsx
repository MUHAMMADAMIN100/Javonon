import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Interaction,
  InteractionType,
  INTERACTION_LABEL,
  INTERACTION_ICON,
  listInteractions,
  createInteraction,
  deleteInteraction,
} from '../api/interactions';
import { useUI } from '../ui/Dialogs';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';

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
  const [items, setItems] = useState<Interaction[]>([]);
  const [showForm, setShowForm] = useState(false);

  const refresh = () => {
    if (!studentId) return;
    listInteractions(studentId).then(setItems).catch(() => setItems([]));
  };
  useEffect(() => { refresh(); }, [studentId]);
  useRealtimeEvent('interaction:new', () => refresh());

  const onCreate = async (data: { type: InteractionType; summary: string; details?: string; visibleToStudent: boolean }) => {
    try {
      await createInteraction({ ...data, studentId });
      toast('Запись добавлена', 'success');
      setShowForm(false);
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  const onDelete = async (it: Interaction) => {
    const ok = await confirm({
      title: 'Удалить запись?',
      message: it.summary,
      danger: true,
      confirmText: 'Удалить',
    });
    if (!ok) return;
    await deleteInteraction(it.id);
    toast('Удалено', 'success');
    refresh();
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
        {canEdit && !showForm && (
          <button className="btn btn-sm btn-primary" onClick={() => setShowForm(true)}>
            <Icon name="add" size={14} /> Добавить
          </button>
        )}
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
        {items.map((it) => (
          <motion.div
            key={it.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              display: 'flex',
              gap: 14,
              padding: 16,
              border: '1px solid var(--border-soft)',
              borderRadius: 14,
              background: it.visibleToStudent ? 'white' : 'var(--bg-soft)',
              borderLeft: `3px solid ${it.visibleToStudent ? 'var(--primary)' : 'var(--text-light)'}`,
            }}
          >
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'var(--primary-soft)',
              color: 'var(--primary-dark)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <Icon name={INTERACTION_ICON[it.type]} size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  color: 'var(--primary-dark)',
                }}>{INTERACTION_LABEL[it.type]}</span>
                {!it.visibleToStudent && (
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--text-light)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.10em',
                  }}>· внутреннее</span>
                )}
                <span style={{ fontSize: 11, color: 'var(--text-light)', marginLeft: 'auto' }}>
                  {fmtRelative(it.occurredAt)}
                </span>
              </div>
              <div style={{ fontWeight: 500, fontSize: 14, marginBottom: it.details ? 4 : 0 }}>{it.summary}</div>
              {it.details && (
                <div style={{ fontSize: 13, color: 'var(--text-soft)', whiteSpace: 'pre-wrap', marginTop: 4 }}>{it.details}</div>
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
            {canEdit && (
              <button className="btn btn-sm btn-danger" onClick={() => onDelete(it)} style={{ alignSelf: 'flex-start' }}>
                <Icon name="delete" size={14} />
              </button>
            )}
          </motion.div>
        ))}
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
