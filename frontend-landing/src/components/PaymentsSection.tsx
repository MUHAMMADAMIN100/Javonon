import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  listStudentTransactions,
  listStudentPayments,
  createStudentPayment,
  cancelStudentPayment,
  type StudentTransaction,
  type StudentPayment,
} from '../studentApi';
import Icon from '../Icon';
import Loading from './Loading';

const CATEGORY_LABEL: Record<string, string> = {
  TUITION_PAYMENT: 'Оплата обучения',
  ADDITIONAL_FEE: 'Доплата',
  OTHER_INCOME: 'Прочее',
};

const METHOD_LABEL: Record<string, string> = {
  CARD: 'Карта',
  BANK_TRANSFER: 'Банковский перевод',
  CASH: 'Наличные',
  CRYPTO: 'Криптовалюта',
  OTHER: 'Другое',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Ожидает подтверждения',
  CONFIRMED: 'Подтверждена',
  REJECTED: 'Отклонена',
  CANCELLED: 'Отменена',
};

function fmt(n: number, c: string) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

export default function PaymentsSection() {
  const [items, setItems] = useState<StudentTransaction[]>([]);
  const [pendingList, setPendingList] = useState<StudentPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const refresh = async () => {
    try {
      const [tx, py] = await Promise.all([listStudentTransactions(), listStudentPayments()]);
      setItems(tx);
      setPendingList(py);
    } catch {} finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);

  const total = items.reduce((s, t) => s + t.amount, 0);

  return (
    <div>
      {/* Заявки на оплату */}
      {pendingList.length > 0 && (
        <div className="stu-card" style={{ marginBottom: 16 }}>
          <h2>Мои заявки на оплату</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingList.map((p) => {
              const statusColor =
                p.status === 'CONFIRMED' ? 'rgb(1, 36, 87)' :
                p.status === 'PENDING' ? '#b45309' :
                p.status === 'REJECTED' ? '#b91c1c' : 'var(--text-light)';
              return (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: 14,
                    border: '1px solid var(--border-soft, #e5e5e5)',
                    borderLeft: `3px solid ${statusColor}`,
                    borderRadius: 12,
                    background: 'white',
                  }}
                >
                  <div style={{
                    width: 36, height: 36, borderRadius: 10,
                    background: 'var(--bg-soft, #f5f5f5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <Icon name={p.status === 'CONFIRMED' ? 'check_circle' : p.status === 'REJECTED' ? 'cancel' : 'pending'} size={18} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>
                      {fmt(p.amount, p.currency)} · {METHOD_LABEL[p.method] || p.method}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 2 }}>
                      <span style={{ color: statusColor, fontWeight: 500 }}>{STATUS_LABEL[p.status] || p.status}</span>
                      {' · '}
                      {new Date(p.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })}
                      {p.comment && ` · ${p.comment}`}
                    </div>
                  </div>
                  {p.status === 'PENDING' && (
                    <button
                      className="btn btn-outline btn-small"
                      onClick={async () => {
                        await cancelStudentPayment(p.id);
                        refresh();
                      }}
                    >
                      Отменить
                    </button>
                  )}
                </motion.div>
              );
            })}
          </div>
        </div>
      )}

      {/* Кнопка / форма «Оплатить» */}
      <div className="stu-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <h2 style={{ margin: 0 }}>Оплата обучения</h2>
          {!showForm && (
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>
              <Icon name="payments" size={18} /> Оплатить
            </button>
          )}
        </div>
        <AnimatePresence>
          {showForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              style={{ overflow: 'hidden', marginTop: 16 }}
            >
              <NewPaymentForm
                onSubmit={async (payload) => {
                  await createStudentPayment(payload);
                  setShowForm(false);
                  refresh();
                }}
                onCancel={() => setShowForm(false)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* История платежей */}
      <div className="stu-card">
        <h2>История платежей</h2>
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
            <Icon name="receipt_long" size={48} style={{ opacity: 0.25, marginBottom: 12 }} />
            <div>Подтверждённых платежей пока нет</div>
          </div>
        ) : (
          <>
            <div style={{
              background: 'var(--bg-soft, #f5f5f5)',
              borderRadius: 14,
              padding: 24,
              marginBottom: 16,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: 16,
            }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                  Всего оплачено
                </div>
                <div style={{ fontFamily: 'var(--font-display, Inter)', fontSize: 36, fontWeight: 600 }}>
                  {fmt(total, items[0]?.currency || 'USD')}
                </div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-soft)' }}>
                {items.length} {items.length === 1 ? 'платёж' : items.length < 5 ? 'платежа' : 'платежей'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.map((t) => (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    padding: 16,
                    border: '1px solid var(--border-soft, #e5e5e5)',
                    borderRadius: 12,
                    background: 'white',
                  }}
                >
                  <div style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: 'rgba(1, 54, 139,0.10)',
                    color: 'rgb(1, 36, 87)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <Icon name="payments" size={20} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 15 }}>
                      {CATEGORY_LABEL[t.category] || t.category}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 2 }}>
                      {new Date(t.date).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })}
                      {t.comment && ` · ${t.comment}`}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 18,
                    fontWeight: 600,
                    color: 'rgb(1, 36, 87)',
                  }}>
                    + {fmt(t.amount, t.currency)}
                  </div>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NewPaymentForm({ onSubmit, onCancel }: {
  onSubmit: (payload: { amount: number; currency: string; method: any; comment?: string }) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('TJS');
  const [method, setMethod] = useState<'CARD' | 'BANK_TRANSFER' | 'CASH' | 'CRYPTO' | 'OTHER'>('BANK_TRANSFER');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setSubmitting(true);
    try {
      await onSubmit({ amount: amt, currency, method, comment: comment || undefined });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{
      background: 'var(--bg-soft, #f5f5f5)',
      padding: 20,
      borderRadius: 14,
      border: '1px solid var(--border-soft, #e5e5e5)',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>Сумма</label>
          <input
            type="number" step="0.01" min={0.01}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            required
            style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border, #ddd)', borderRadius: 10, fontSize: 16 }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>Валюта</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border, #ddd)', borderRadius: 10, fontSize: 14 }}
          >
            <option>USD</option><option>EUR</option><option>RUB</option><option>TJS</option>
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>Способ</label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as any)}
            style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border, #ddd)', borderRadius: 10, fontSize: 14 }}
          >
            <option value="BANK_TRANSFER">Банковский перевод</option>
            <option value="CARD">Карта</option>
            <option value="CASH">Наличные</option>
            <option value="CRYPTO">Криптовалюта</option>
            <option value="OTHER">Другое</option>
          </select>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>Комментарий (опционально)</label>
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Например: оплата за 1-й семестр"
          style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border, #ddd)', borderRadius: 10, fontSize: 14 }}
        />
      </div>
      <div style={{
        marginTop: 12,
        padding: 12,
        background: 'rgba(245,158,11,0.08)',
        border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 10,
        fontSize: 13,
        color: '#92400e',
      }}>
        <Icon name="info" size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
        После отправки бухгалтер свяжется с тобой и подтвердит оплату.
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn btn-outline btn-small" onClick={onCancel}>Отмена</button>
        <button type="submit" className="btn btn-primary" disabled={submitting || !amount}>
          {submitting ? 'Отправляем...' : 'Отправить заявку'}
        </button>
      </div>
    </form>
  );
}
