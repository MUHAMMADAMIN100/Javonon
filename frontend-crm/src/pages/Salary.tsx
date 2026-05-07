import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  SalaryRecord,
  SalaryPreview,
  listSalaries,
  previewSalary,
  createSalary,
  paySalary,
  deleteSalary,
} from '../api/salary';
import { listUsers } from '../api/users';
import { ROLE_LABEL } from '../api/types';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';

function fmtMoney(n: number, c = 'USD') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}
function fmtMin(min: number) {
  if (min <= 0) return '0ч';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
}
function defaultMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { start, end };
}

export default function Salary() {
  const { toast, confirm } = useUI();
  const [users, setUsers] = useState<any[]>([]);
  const [records, setRecords] = useState<SalaryRecord[]>([]);
  const [userId, setUserId] = useState<string>('');
  const [{ start, end }, setRange] = useState(defaultMonthRange());
  const [kpiBonus, setKpiBonus] = useState('0');
  const [comment, setComment] = useState('');
  const [preview, setPreview] = useState<SalaryPreview | null>(null);

  const refresh = () => {
    listSalaries().then(setRecords).catch(() => {});
  };

  useEffect(() => {
    listUsers().then((u) => {
      setUsers(u);
      if (!userId && u.length) setUserId(u[0].id);
    }).catch(() => {});
    refresh();
  }, []);

  useEffect(() => {
    if (!userId || !start || !end) return;
    previewSalary({ userId, periodStart: start, periodEnd: end, kpiBonus: parseFloat(kpiBonus) || 0 })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [userId, start, end, kpiBonus]);

  const onCreate = async () => {
    if (!userId) return;
    try {
      await createSalary({
        userId,
        periodStart: start,
        periodEnd: end,
        kpiBonus: parseFloat(kpiBonus) || 0,
        comment: comment.trim() || undefined,
      });
      toast('Расчёт сохранён', 'success');
      setComment('');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  const onPay = async (r: SalaryRecord) => {
    const ok = await confirm({
      title: 'Выплатить зарплату?',
      message: `${r.user?.fullName}: ${fmtMoney(r.netAmount, r.currency)} — будет создана расходная транзакция.`,
      confirmText: 'Выплатить',
    });
    if (!ok) return;
    try {
      await paySalary(r.id);
      toast('Зарплата выплачена', 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  const onDelete = async (r: SalaryRecord) => {
    const ok = await confirm({
      title: 'Удалить расчёт?',
      message: `${r.user?.fullName}: ${fmtMoney(r.netAmount)}`,
      danger: true,
      confirmText: 'Удалить',
    });
    if (!ok) return;
    try {
      await deleteSalary(r.id);
      toast('Удалено', 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">PAYROLL · 09</span>
        <h2 className="crm-section-title">
          Зарплата <em>сотрудников.</em>
        </h2>
      </div>

      {/* Калькулятор */}
      <div className="card" style={{ padding: 28, marginBottom: 24 }}>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.16em',
          color: 'var(--primary-dark)',
          marginBottom: 6,
        }}>CALCULATOR · LIVE PREVIEW</div>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginBottom: 24,
        }}>
          Расчёт <em style={{
            fontFamily: 'Times New Roman, Georgia, serif',
            fontWeight: 400,
            color: 'var(--primary-dark)',
          }}>за период.</em>
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div className="form-group">
            <label>Сотрудник</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName} · {ROLE_LABEL[u.role as 'ADMIN' | 'EMPLOYEE' | 'ACCOUNTANT'] || u.role}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Период с</label>
            <input type="date" value={start} onChange={(e) => setRange({ start: e.target.value, end })} />
          </div>
          <div className="form-group">
            <label>По</label>
            <input type="date" value={end} onChange={(e) => setRange({ start, end: e.target.value })} />
          </div>
          <div className="form-group">
            <label>KPI бонус ($)</label>
            <input type="number" step="0.01" value={kpiBonus} onChange={(e) => setKpiBonus(e.target.value)} placeholder="0" />
          </div>
        </div>

        {preview && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              marginTop: 24,
              padding: 24,
              background: 'var(--bg-soft)',
              borderRadius: 18,
              border: '1px solid var(--border-soft)',
            }}
          >
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 24,
              marginBottom: 24,
            }}>
              <PreviewCell label="Часов" value={fmtMin(preview.workedMinutes)} />
              <PreviewCell label="Опоздания" value={preview.lateMinutes > 0 ? `${preview.lateMinutes}м` : '—'} />
              <PreviewCell label="База" value={fmtMoney(preview.baseAmount)} />
              <PreviewCell
                label={`Бонус · ${preview.bonusPercent}% от продаж`}
                value={fmtMoney(preview.bonusAmount)}
                sub={`Продажи: ${fmtMoney(preview.salesAmount)}`}
              />
              <PreviewCell label="KPI" value={fmtMoney(preview.kpiBonus)} />
              <PreviewCell label="Штрафы" value={`− ${fmtMoney(preview.penalties)}`} negative={preview.penalties > 0} />
            </div>
            <div style={{
              borderTop: '1px solid var(--border)',
              paddingTop: 24,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              gap: 16,
              flexWrap: 'wrap',
            }}>
              <div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.16em',
                  color: 'var(--text-soft)',
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}>К ВЫПЛАТЕ</div>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 56,
                  fontWeight: 500,
                  letterSpacing: '-0.04em',
                  lineHeight: 1,
                  color: 'var(--primary-dark)',
                }}>{fmtMoney(preview.netAmount, preview.currency)}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Комментарий (опционально)"
                  style={{
                    padding: '12px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    fontSize: 14,
                    minWidth: 220,
                  }}
                />
                <button className="btn btn-primary" onClick={onCreate}>
                  <Icon name="bookmark_add" size={18} /> Зафиксировать
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* История расчётов */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">HISTORY · ALL RECORDS</span>
        <h2 className="crm-section-title">
          Журнал <em>выплат.</em>
        </h2>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th>Период</th>
              <th>Часы</th>
              <th>Продажи</th>
              <th>База</th>
              <th>Бонус</th>
              <th>Итого</th>
              <th>Статус</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr><td colSpan={9} className="empty">Нет расчётов</td></tr>
            )}
            {records.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 500 }}>{r.user?.fullName}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {new Date(r.periodStart).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })}
                  {' → '}
                  {new Date(r.periodEnd).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(r.workedMinutes)}</td>
                <td style={{ color: 'var(--text-soft)' }}>{fmtMoney(r.salesAmount, r.currency)}</td>
                <td>{fmtMoney(r.baseAmount, r.currency)}</td>
                <td style={{ color: 'var(--primary-dark)' }}>+ {fmtMoney(r.bonusAmount + r.kpiBonus, r.currency)}</td>
                <td style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 500,
                  fontSize: 17,
                }}>{fmtMoney(r.netAmount, r.currency)}</td>
                <td>
                  {r.status === 'PAID'
                    ? <span className="badge badge-success">Выплачено</span>
                    : <span className="badge badge-warning">Черновик</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {r.status === 'DRAFT' && (
                      <button className="btn btn-sm btn-secondary" onClick={() => onPay(r)}>
                        <Icon name="paid" size={14} /> Выплатить
                      </button>
                    )}
                    <button className="btn btn-sm btn-danger" onClick={() => onDelete(r)}>
                      <Icon name="delete" size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PreviewCell({ label, value, sub, negative }: { label: string; value: string; sub?: string; negative?: boolean }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--text-soft)',
        marginBottom: 6,
      }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: '-0.02em',
        color: negative ? 'var(--danger)' : 'var(--text)',
      }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-light)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
