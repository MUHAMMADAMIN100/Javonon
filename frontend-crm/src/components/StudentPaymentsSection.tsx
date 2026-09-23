import { fmtDateText, TJ_TZ } from '../lib/tjTime';
import { useRealtime } from '../realtime';
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api/client';
import Icon from '../Icon';
import { localized, useT } from '../lib/i18n';
import { EmptyLine } from './ClientCard';

interface PaymentTx {
  id: string;
  amount: number;
  currency: string;
  category: string;
  date: string;
  comment: string | null;
  recordedBy?: { id: string; fullName: string } | null;
}

interface PaymentReq {
  id: string;
  amount: number;
  currency: string;
  method: string;
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';
  comment: string | null;
  createdAt: string;
  confirmedAt: string | null;
  confirmedBy?: { id: string; fullName: string } | null;
}

interface Response {
  transactions: PaymentTx[];
  paymentRequests: PaymentReq[];
  /** Оплачено в TJS (удалённые оплаты не входят). */
  totalPaid: number;
  /** Оплаты в других валютах — отдельно, с сомони не складываются. */
  totalPaidOther?: Record<string, number>;
}

const CATEGORY_LABEL: Record<string, string> = localized('finance.cat', {
  TUITION_PAYMENT: 'Оплата обучения',
  ADDITIONAL_FEE: 'Доплата',
  OTHER_INCOME: 'Прочее',
});

const STATUS_LABEL: Record<string, string> = localized('payments.status', {
  PENDING: 'Ожидает',
  CONFIRMED: 'Подтверждена',
  REJECTED: 'Отклонена',
  CANCELLED: 'Отменена',
});

const STATUS_COLOR: Record<string, string> = {
  PENDING: '#b45309',
  CONFIRMED: 'var(--primary-dark)',
  REJECTED: '#b91c1c',
  CANCELLED: 'var(--text-light)',
};

function fmt(n: number, c: string) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

export default function StudentPaymentsSection({ studentId }: { studentId: string }) {
  const { t } = useT();
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!studentId) return;
    api.get<Response>(`/students/${studentId}/payments`)
      .then((r) => setData(r.data))
      .catch(() => setData({ transactions: [], paymentRequests: [], totalPaid: 0 }))
      .finally(() => setLoading(false));
  }, [studentId]);
  useEffect(load, [load]);

  // Живое обновление: подтвердили/отклонили/внесли платёж, одобрили оплату по
  // сделке, изменили транзакцию — блок перечитывается сам. Раньше менеджер
  // видел «Ожидает», пока не перезагрузит страницу.
  const mine = (p: any) =>
    !p || p?.payment?.studentId === studentId || p?.transaction?.studentId === studentId || p?.studentId === studentId;
  useRealtime({
    'payment:pending': (p: any) => mine(p) && load(),
    'payment:confirmed': (p: any) => mine(p) && load(),
    'payment:rejected': (p: any) => mine(p) && load(),
    'submission:reviewed': () => load(),
    'transaction:new': (p: any) => mine(p) && load(),
    'transaction:updated': (p: any) => mine(p) && load(),
    'transaction:deleted': () => load(),
  });

  if (loading) {
    return <EmptyLine title={t('payments.title')} text={t('common.loading')} />;
  }
  if (!data) return null;

  const { transactions, paymentRequests, totalPaid, totalPaidOther } = data;
  const pendingActive = paymentRequests.filter((p) => p.status === 'PENDING');

  // Оплат и заявок на оплату нет — одной строкой, как пустые блоки карточки сотрудника.
  if (transactions.length === 0 && paymentRequests.length === 0) {
    return <EmptyLine title={t('payments.title')} text={t('payments.emptyLine')} testId="payments-empty" />;
  }

  return (
    <section className="card profile-section" data-testid="payments">
      <div className="client-block-head">
        <h3 className="profile-h">
          {t('payments.title')}
          {transactions.length > 0 && <span className="client-count">{transactions.length}</span>}
        </h3>
        {/* «Оплачено» в TJS, рядом — другие валюты (в сумму не входят). */}
        <div className="client-payments-total" data-testid="paid-total">
          <b>{fmt(totalPaid, 'TJS')}</b>
          {Object.entries(totalPaidOther ?? {}).map(([cur, v]) => (
            <span key={cur} data-testid="paid-other">+ {fmt(v, cur)}</span>
          ))}
        </div>
      </div>

      {/* Pending заявки */}
      {pendingActive.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: 'var(--text-soft)',
            marginBottom: 8,
          }}>{t('payments.pending')} · {pendingActive.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pendingActive.map((p) => (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: 12,
                  background: 'rgba(245,158,11,0.06)',
                  borderRadius: 10,
                  border: '1px solid rgba(245,158,11,0.3)',
                  borderLeft: '3px solid #f59e0b',
                }}
              >
                <Icon name="pending" size={18} style={{ color: '#b45309' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>{fmt(p.amount, p.currency)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                    {fmtDateText(p.createdAt, { day: '2-digit', month: 'short', timeZone: TJ_TZ })}
                    {p.comment && ` · ${p.comment}`}
                  </div>
                </div>
                <span className="badge badge-warning" style={{ fontFamily: 'var(--font-mono)' }}>
                  {t('payments.status.PENDING')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Подтверждённые транзакции */}
      {transactions.length === 0 ? (
        <div className="profile-empty" style={{ padding: '4px 0' }}>{t('payments.emptyLine')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {transactions.map((tx) => (
            <motion.div
              key={tx.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: 12,
                background: 'white',
                border: '1px solid var(--border-soft)',
                borderRadius: 10,
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'var(--primary-soft)',
                color: 'var(--primary-dark)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Icon name="payments" size={16} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>
                  {t(`payments.cat.${tx.category}`) !== `payments.cat.${tx.category}` ? t(`payments.cat.${tx.category}`) : (CATEGORY_LABEL[tx.category] || tx.category)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                  {fmtDateText(tx.date, { day: '2-digit', month: 'short', year: 'numeric', timeZone: TJ_TZ })}
                  {tx.comment && ` · ${tx.comment}`}
                  {tx.recordedBy && ` · ${tx.recordedBy.fullName}`}
                </div>
              </div>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: 18,
                fontWeight: 500,
                color: 'var(--primary-dark)',
              }}>
                +{fmt(tx.amount, tx.currency)}
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* История заявок (включая отклонённые/отменённые) */}
      {paymentRequests.filter((p) => p.status !== 'PENDING').length > 0 && (
        <details style={{ marginTop: 18 }}>
          <summary style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.10em',
            color: 'var(--text-soft)',
            textTransform: 'uppercase',
            cursor: 'pointer',
            padding: '8px 0',
          }}>
            {t('payments.history')} · {paymentRequests.filter((p) => p.status !== 'PENDING').length}
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {paymentRequests.filter((p) => p.status !== 'PENDING').map((p) => (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 10,
                  fontSize: 13,
                  color: 'var(--text-soft)',
                }}
              >
                <span style={{ color: STATUS_COLOR[p.status], fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {t(`payments.status.${p.status}`) !== `payments.status.${p.status}` ? t(`payments.status.${p.status}`) : STATUS_LABEL[p.status]}
                </span>
                <span>{fmt(p.amount, p.currency)}</span>
                <span>·</span>
                <span>{new Date(p.createdAt).toLocaleDateString('ru-RU')}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
