import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { listStudentTransactions, type StudentTransaction } from '../studentApi';
import Icon from '../Icon';

const CATEGORY_LABEL: Record<string, string> = {
  TUITION_PAYMENT: 'Оплата обучения',
  ADDITIONAL_FEE: 'Доплата',
  OTHER_INCOME: 'Прочее',
};

function fmt(n: number, c: string) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

export default function PaymentsSection() {
  const [items, setItems] = useState<StudentTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listStudentTransactions()
      .then((d) => setItems(d))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const total = items.reduce((s, t) => s + t.amount, 0);

  return (
    <div className="stu-card">
      <h2>История оплат</h2>
      {loading ? (
        <div style={{ color: 'var(--text-soft)' }}>Загрузка...</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
          <Icon name="receipt_long" size={48} style={{ opacity: 0.25, marginBottom: 12 }} />
          <div>Платежей пока не было</div>
        </div>
      ) : (
        <>
          <div style={{
            background: 'var(--bg-soft)',
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
                  background: 'rgba(16,185,129,0.10)',
                  color: 'rgb(4,120,87)',
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
                  color: 'rgb(4,120,87)',
                }}>
                  + {fmt(t.amount, t.currency)}
                </div>
              </motion.div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
