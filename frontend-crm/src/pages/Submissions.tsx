import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useRealtime } from '../realtime';
import { useT } from '../lib/i18n';
import {
  listMySubmissions,
  listAllSubmissions,
  listPendingPayments,
  type SaleSubmission,
  type PendingPayment,
  type SubmissionStatus,
  SUBMISSION_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
} from '../api/submissions';
import Icon from '../Icon';
import { absFileUrl as absUrl } from '../lib/fileUrl';

const STATUS_COLOR: Record<SubmissionStatus, string> = {
  ACTIVE: '#0ea5e9',
  COMPLETED: '#10b981',
  CANCELLED: '#94a3b8',
};

const PAYMENT_STATUS_COLOR: Record<string, string> = {
  PENDING: '#fbbf24',
  APPROVED: '#10b981',
  REJECTED: '#ef4444',
};

export default function Submissions() {
  const me = useAuth((s) => s.user);
  const { t } = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const founder = isFounder(me);

  const [tab, setTab] = useState<'mine' | 'pending' | 'all'>(founder ? 'pending' : 'mine');

  // Realtime: бэкенд эмитит submission:new (staff), submission:payment-new (staff),
  // submission:reviewed (staff), submission:approved/rejected (юзеру-менеджеру).
  // Инвалидируем весь префикс ['submissions'] — он покрывает 'mine'/'all'/'pending'.
  useRealtime({
    'submission:new': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:payment-new': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:reviewed': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:approved': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:rejected': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
  });

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">SALES · 06</span>
        <h2 className="crm-section-title">{t('submissions.title') !== 'submissions.title' ? t('submissions.title') : 'Сделки'}</h2>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {!founder && (
          <button
            className={`btn btn-sm ${tab === 'mine' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab('mine')}
          >
            Мои сделки
          </button>
        )}
        {founder && (
          <>
            <button
              className={`btn btn-sm ${tab === 'pending' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setTab('pending')}
            >
              На рассмотрении
            </button>
            <button
              className={`btn btn-sm ${tab === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setTab('all')}
            >
              Все сделки
            </button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => navigate('/submissions/new')}>
          <Icon name="add" size={16} /> Новая сделка
        </button>
      </div>

      {tab === 'mine' && <MySubmissions />}
      {tab === 'pending' && <PendingPayments />}
      {tab === 'all' && <AllSubmissions />}
    </>
  );
}

function MySubmissions() {
  const query = useQuery({ queryKey: ['submissions', 'mine'], queryFn: () => listMySubmissions() });
  if (query.isLoading) return <Loading />;
  const items = query.data || [];
  if (items.length === 0) {
    return <Empty>У вас пока нет сделок. Нажмите «Новая сделка», чтобы оформить первую.</Empty>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((s) => <SubmissionCard key={s.id} s={s} />)}
    </div>
  );
}

function AllSubmissions() {
  const query = useQuery({ queryKey: ['submissions', 'all'], queryFn: () => listAllSubmissions({ take: 200 }) });
  if (query.isLoading) return <Loading />;
  const items = query.data || [];
  if (items.length === 0) return <Empty>Сделок пока нет.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((s) => <SubmissionCard key={s.id} s={s} showManager />)}
    </div>
  );
}

function PendingPayments() {
  const query = useQuery({ queryKey: ['submissions', 'pending'], queryFn: () => listPendingPayments() });
  if (query.isLoading) return <Loading />;
  const items = query.data || [];
  if (items.length === 0) return <Empty>Нет платежей на рассмотрении.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((p) => <PendingPaymentCard key={p.id} p={p} />)}
    </div>
  );
}

function SubmissionCard({ s, showManager }: { s: SaleSubmission; showManager?: boolean }) {
  const studentName = s.student?.fullName || s.newStudentName || '—';
  const program = s.program?.name || '—';
  const totalPaid = s.payments.filter((p) => p.status === 'APPROVED').reduce((sum, p) => sum + p.amount, 0);
  const pendingSum = s.payments.filter((p) => p.status === 'PENDING').reduce((sum, p) => sum + p.amount, 0);
  return (
    <Link
      to={`/submissions/${s.id}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <motion.div
        className="card"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ y: -2 }}
        style={{ padding: 18, cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{studentName}</div>
            <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{program}</div>
            {showManager && s.manager && (
              <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 2 }}>
                Менеджер: {s.manager.fullName}
              </div>
            )}
          </div>
          <span
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: STATUS_COLOR[s.status] + '22',
              color: STATUS_COLOR[s.status],
              fontSize: 12,
              fontWeight: 600,
              border: `1.5px solid ${STATUS_COLOR[s.status]}`,
            }}
          >
            {SUBMISSION_STATUS_LABEL[s.status]}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, marginTop: 8 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Контракт</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              {s.totalAmount.toLocaleString('ru-RU')} {s.currency}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Оплачено</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--primary-dark)' }}>
              {totalPaid.toLocaleString('ru-RU')} {s.currency}
            </div>
          </div>
          {pendingSum > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Ждёт одобрения</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#b45309' }}>
                {pendingSum.toLocaleString('ru-RU')} {s.currency}
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Платежей</div>
            <div style={{ fontFamily: 'var(--font-mono)' }}>{s.payments.length}</div>
          </div>
        </div>
      </motion.div>
    </Link>
  );
}

function PendingPaymentCard({ p }: { p: PendingPayment }) {
  const studentName = p.submission.student?.fullName || p.submission.newStudentName || '—';
  return (
    <Link
      to={`/submissions/${p.submission.id}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <motion.div
        className="card"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ y: -2 }}
        style={{ padding: 18, cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{studentName}</div>
            <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{p.submission.program.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 2 }}>
              Менеджер: {p.submission.manager.fullName}
            </div>
          </div>
          <span
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: PAYMENT_STATUS_COLOR.PENDING + '22',
              color: PAYMENT_STATUS_COLOR.PENDING,
              fontSize: 12,
              fontWeight: 600,
              border: `1.5px solid ${PAYMENT_STATUS_COLOR.PENDING}`,
            }}
          >
            {PAYMENT_STATUS_LABEL.PENDING}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase' }}>Сумма платежа</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--primary-dark)', fontSize: 16 }}>
              {p.amount.toLocaleString('ru-RU')} {p.submission.currency}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase' }}>Дата оплаты</div>
            <div style={{ fontFamily: 'var(--font-mono)' }}>
              {new Date(p.paidAt).toLocaleDateString('ru-RU')}
            </div>
          </div>
          {p.receiptUrl && (
            <a href={absUrl(p.receiptUrl)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="btn btn-sm btn-secondary">
              <Icon name="image" size={14} /> Чек
            </a>
          )}
          {p.depositProofUrl && (
            <a href={absUrl(p.depositProofUrl)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="btn btn-sm btn-secondary">
              <Icon name="image" size={14} /> Депозит
            </a>
          )}
        </div>
      </motion.div>
    </Link>
  );
}

function Loading() {
  return <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-soft)' }}>Загружаем…</div>;
}
function Empty({ children }: { children: any }) {
  return <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>{children}</div>;
}
