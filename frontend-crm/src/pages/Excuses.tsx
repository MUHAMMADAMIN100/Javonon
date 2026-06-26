import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useUI } from '../ui/Dialogs';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';
import {
  listPendingExcuses,
  listExcuses,
  approveExcuse,
  rejectExcuse,
  approveLunchExcuse,
  rejectLunchExcuse,
  type ExcuseEntry,
  type ExcuseStatus,
} from '../api/excuses';
import { tjFormatDateTime, tjFormatFull } from '../lib/tjTime';
import { useT } from '../lib/i18n';

// Файлы лежат на backend (Railway), а не на фронте (Vercel). Без этого
// префикса <a href="/uploads/..."> тыкается в Vercel и получает 404 /
// пустую страницу. Снимаем суффикс `/api` если он есть в env.
const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');
const absUrl = (u: string | null | undefined) => {
  if (!u) return '';
  return u.startsWith('http') ? u : `${API_BASE}${u}`;
};

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
  const { t } = useT();
  if (!isFounder(me)) {
    return <div className="card" style={{ padding: 28 }}>Доступ только для основателя.</div>;
  }

  const [tab, setTab] = useState<'pending' | 'history'>('pending');

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.hr')} · {t('workday.tab.excuses')}</span>
        <h2 className="crm-section-title">{t('excuses.title')}</h2>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${tab === 'pending' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('pending')}
        >
          {t('excuses.tab.pending')}
        </button>
        <button
          className={`btn btn-sm ${tab === 'history' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('history')}
        >
          {t('excuses.tab.history')}
        </button>
      </div>

      {tab === 'pending' ? <PendingTab /> : <HistoryTab />}
    </>
  );
}

function PendingTab() {
  const { toast } = useUI();
  const { t } = useT();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['excuses', 'pending'], queryFn: listPendingExcuses });

  // По ТЗ — когда сотрудник присылает причину, у основателя список
  // обновляется мгновенно. Тот же event тригерится после approve/reject
  // (другой сессии основателя — например на мобильнике).
  useRealtimeEvent('excuse:new', () => qc.invalidateQueries({ queryKey: ['excuses'] }));
  useRealtimeEvent('excuse:reviewed', () => qc.invalidateQueries({ queryKey: ['excuses'] }));

  const approveMut = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'arrival' | 'lunch' }) =>
      kind === 'lunch' ? approveLunchExcuse(id) : approveExcuse(id),
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
    mutationFn: ({ id, kind }: { id: string; kind: 'arrival' | 'lunch' }) =>
      kind === 'lunch' ? rejectLunchExcuse(id) : rejectExcuse(id),
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
        {t('excuses.empty')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((e) => (
        <ExcuseCard
          key={`${e.id}-${e.kind}`}
          entry={e}
          onApprove={() => approveMut.mutate({ id: e.id, kind: e.kind })}
          onReject={() => rejectMut.mutate({ id: e.id, kind: e.kind })}
          busy={approveMut.isPending || rejectMut.isPending}
        />
      ))}
    </div>
  );
}

function HistoryTab() {
  const { t } = useT();
  const query = useQuery({ queryKey: ['excuses', 'all'], queryFn: () => listExcuses({ take: 200 }) });

  if (query.isLoading) return <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>;
  const items = query.data || [];
  if (items.length === 0) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
        {t('common.empty')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((e) => (
        <ExcuseCard key={`${e.id}-${e.kind}`} entry={e} />
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
  const { t } = useT();
  const isLunch = entry.kind === 'lunch';
  // Поля выбираются в зависимости от типа объяснения
  const status = (isLunch ? entry.lunchLateExcuseStatus : entry.lateExcuseStatus) || 'PENDING';
  const reason = isLunch ? entry.lunchLateExcuseReason : entry.lateExcuseReason;
  const url = isLunch ? entry.lunchLateExcuseUrl : entry.lateExcuseUrl;
  const minutes = isLunch ? (entry.lateLunchMinutes ?? 0) : entry.lateMinutes;
  const reviewedAt = isLunch ? entry.lunchLateExcuseReviewedAt : entry.lateExcuseReviewedAt;
  const kindLabel = isLunch
    ? (t('excuses.kind.lunch') !== 'excuses.kind.lunch' ? t('excuses.kind.lunch') : 'С обеда')
    : (t('excuses.kind.arrival') !== 'excuses.kind.arrival' ? t('excuses.kind.arrival') : 'Утром');
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{entry.user.fullName}</div>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                background: isLunch ? '#f59e0b22' : '#0ea5e922',
                color: isLunch ? '#b45309' : '#0369a1',
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${isLunch ? '#f59e0b' : '#0ea5e9'}`,
              }}
            >
              {kindLabel}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{entry.user.email}</div>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
            {tjFormatDateTime(entry.clockIn)}
            {' · '}
            <span style={{ color: 'var(--primary-dark)', fontWeight: 600 }}>
              {t('excuses.late')}: {minutes} {t('common.minutes')}
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
          {t(`excuses.status.${status}`) !== `excuses.status.${status}` ? t(`excuses.status.${status}`) : STATUS_LABEL[status]}
        </span>
      </div>

      {reason && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            {t('excuses.reason')}
          </div>
          <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{reason}</div>
        </div>
      )}

      {url && (
        <div style={{ marginBottom: 12 }}>
          <a href={absUrl(url)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
            <Icon name="image" size={14} /> {t('common.open')}
          </a>
        </div>
      )}

      {isPending && onApprove && onReject && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
          <button className="btn btn-sm btn-danger" onClick={onReject} disabled={busy}>
            <Icon name="close" size={14} /> {t('excuses.reject')}
          </button>
          <button className="btn btn-sm btn-primary" onClick={onApprove} disabled={busy}>
            <Icon name="check" size={14} /> {t('excuses.approve')}
          </button>
        </div>
      )}

      {!isPending && reviewedAt && (
        <div style={{ fontSize: 11, color: 'var(--text-soft)', borderTop: '1px solid var(--border-soft)', paddingTop: 10, marginTop: 6 }}>
          {tjFormatFull(reviewedAt)}
        </div>
      )}
    </motion.div>
  );
}
