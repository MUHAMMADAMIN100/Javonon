import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import {
  listPendingExcuses,
  listExcuses,
  approveExcuse,
  rejectExcuse,
  type ExcuseEntry,
  type ExcuseStatus,
} from '../api/excuses';

const STATUS_LABEL: Record<ExcuseStatus, string> = {
  PENDING: 'Ожидает',
  APPROVED: 'Одобрено',
  REJECTED: 'Отклонено',
};

const STATUS_COLOR: Record<ExcuseStatus, string> = {
  PENDING: '#fbbf24',
  APPROVED: '#10b981',
  REJECTED: '#ef4444',
};

export default function Excuses() {
  const me = useAuth((s) => s.user);
  if (!isFounder(me)) {
    return <div className="card" style={{ padding: 28 }}>Доступ только для основателя.</div>;
  }

  const [tab, setTab] = useState<'pending' | 'history'>('pending');

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">HR · ПРИЧИНЫ</span>
        <h2 className="crm-section-title">Причины опозданий</h2>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${tab === 'pending' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('pending')}
        >
          Ожидают
        </button>
        <button
          className={`btn btn-sm ${tab === 'history' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('history')}
        >
          История
        </button>
      </div>

      {tab === 'pending' ? <PendingTab /> : <HistoryTab />}
    </>
  );
}

function PendingTab() {
  const { toast } = useUI();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['excuses', 'pending'], queryFn: listPendingExcuses });

  const approveMut = useMutation({
    mutationFn: (id: string) => approveExcuse(id),
    onSuccess: (data) => {
      toast(
        data.penaltiesRemoved > 0
          ? `Причина одобрена, штраф (${data.penaltiesRemoved}) отменён`
          : 'Причина одобрена, штраф не списывался',
        'success',
      );
      qc.invalidateQueries({ queryKey: ['excuses'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => rejectExcuse(id),
    onSuccess: () => {
      toast('Причина отклонена, штраф остаётся', 'success');
      qc.invalidateQueries({ queryKey: ['excuses'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  if (query.isLoading) return <div className="card" style={{ padding: 24 }}>Загружаем…</div>;
  const items = query.data || [];
  if (items.length === 0) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
        Нет причин на рассмотрении. 🎉
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((e) => (
        <ExcuseCard
          key={e.id}
          entry={e}
          onApprove={() => approveMut.mutate(e.id)}
          onReject={() => rejectMut.mutate(e.id)}
          busy={approveMut.isPending || rejectMut.isPending}
        />
      ))}
    </div>
  );
}

function HistoryTab() {
  const query = useQuery({ queryKey: ['excuses', 'all'], queryFn: () => listExcuses({ take: 200 }) });

  if (query.isLoading) return <div className="card" style={{ padding: 24 }}>Загружаем…</div>;
  const items = query.data || [];
  if (items.length === 0) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
        Истории пока нет.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((e) => (
        <ExcuseCard key={e.id} entry={e} />
      ))}
    </div>
  );
}

function ExcuseCard({
  entry,
  onApprove,
  onReject,
  busy,
}: {
  entry: ExcuseEntry;
  onApprove?: () => void;
  onReject?: () => void;
  busy?: boolean;
}) {
  const status = entry.lateExcuseStatus || 'PENDING';
  const isPending = status === 'PENDING';
  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: 22 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>{entry.user.fullName}</div>
          <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{entry.user.email}</div>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
            {new Date(entry.clockIn).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {' · '}
            <span style={{ color: 'var(--primary-dark)', fontWeight: 600 }}>
              опоздал на {entry.lateMinutes} мин
            </span>
          </div>
        </div>
        <span
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: STATUS_COLOR[status] + '22',
            color: STATUS_COLOR[status],
            fontSize: 12,
            fontWeight: 600,
            border: `1.5px solid ${STATUS_COLOR[status]}`,
          }}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>

      {entry.lateExcuseReason && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            Причина
          </div>
          <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{entry.lateExcuseReason}</div>
        </div>
      )}

      {entry.lateExcuseUrl && (
        <div style={{ marginBottom: 12 }}>
          <a href={entry.lateExcuseUrl} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
            <Icon name="image" size={14} /> Открыть фото
          </a>
        </div>
      )}

      {isPending && onApprove && onReject && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
          <button className="btn btn-sm btn-danger" onClick={onReject} disabled={busy}>
            <Icon name="close" size={14} /> Отклонить
          </button>
          <button className="btn btn-sm btn-primary" onClick={onApprove} disabled={busy}>
            <Icon name="check" size={14} /> Одобрить
          </button>
        </div>
      )}

      {!isPending && entry.lateExcuseReviewedAt && (
        <div style={{ fontSize: 11, color: 'var(--text-soft)', borderTop: '1px solid var(--border-soft)', paddingTop: 10, marginTop: 6 }}>
          Разобрано: {new Date(entry.lateExcuseReviewedAt).toLocaleString('ru-RU')}
        </div>
      )}
    </motion.div>
  );
}
