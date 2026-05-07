import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Transaction,
  TransactionType,
  TransactionCategory,
  TRANSACTION_CATEGORY_LABEL,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  CreateTransactionDto,
  listTransactions,
  createTransaction,
  deleteTransaction,
  financeSummary,
  pendingPayments,
  FinanceSummary,
} from '../api/finance';
import { listStudents } from '../api/students';
import { listUsers } from '../api/users';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';

function fmtMoney(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function Finance() {
  const { toast, confirm } = useUI();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [filterType, setFilterType] = useState<TransactionType | ''>('');
  const [showForm, setShowForm] = useState(false);

  const refresh = async () => {
    try {
      const [txs, sum, pp] = await Promise.all([
        listTransactions(filterType ? { type: filterType, take: 200 } : { take: 200 }),
        financeSummary(),
        pendingPayments(),
      ]);
      setTransactions(txs);
      setSummary(sum);
      setPending(pp);
    } catch {}
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [filterType]);
  useEffect(() => {
    listStudents({}).then((rs) => setStudents(rs)).catch(() => {});
    listUsers().then((rs) => setUsers(rs)).catch(() => {});
  }, []);

  const onDelete = async (t: Transaction) => {
    const ok = await confirm({
      title: 'Удалить транзакцию?',
      message: `${t.type === 'INCOME' ? 'Доход' : 'Расход'} ${fmtMoney(t.amount, t.currency)}`,
      danger: true,
      confirmText: 'Удалить',
    });
    if (!ok) return;
    try {
      await deleteTransaction(t.id);
      toast('Удалено', 'success');
      await refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">FINANCE · 08</span>
        <h2 className="crm-section-title">
          Деньги <em>под контролем.</em>
        </h2>
      </div>

      {/* Bento с финансовой сводкой */}
      {summary && (
        <div className="bento" style={{ marginBottom: 32 }}>
          <motion.div
            className="bento-card feature span-3 row-2"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <span className="bento-num">REVENUE · 01</span>
            <div style={{ marginTop: 'auto' }}>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(64px, 8vw, 104px)',
                fontWeight: 500,
                letterSpacing: '-0.04em',
                lineHeight: 0.9,
                marginBottom: 16,
              }}>
                {fmtMoney(summary.netProfit)}
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                color: 'rgba(255,255,255,0.55)',
                textTransform: 'uppercase',
              }}>
                Чистая прибыль <span style={{
                  fontFamily: 'Times New Roman, Georgia, serif',
                  fontStyle: 'italic',
                  fontSize: 18,
                  color: 'var(--primary-light)',
                  textTransform: 'none',
                  marginLeft: 6,
                }}>за всё время.</span>
              </div>
            </div>
          </motion.div>

          <KpiBento eyebrow="INCOME · 02" label="Доходы всего" value={fmtMoney(summary.totalIncome)} accent />
          <KpiBento eyebrow="EXPENSE · 03" label="Расходы всего" value={fmtMoney(summary.totalExpense)} />
          <KpiBento eyebrow="COUNT · 04" label="Всего транзакций" value={String(summary.incomeCount + summary.expenseCount)} span="span-3" />
        </div>
      )}

      {/* Pending payments */}
      {pending.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="crm-section-head">
            <span className="crm-section-eyebrow" style={{ color: '#b45309' }}>OUTSTANDING · WAITING FOR PAYMENT</span>
            <h2 className="crm-section-title">
              Задолженность <em>студентов.</em>
            </h2>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr><th>Студент</th><th>Программа</th><th>Сумма</th><th>Менеджер</th><th></th></tr>
              </thead>
              <tbody>
                {pending.map((app) => (
                  <tr key={app.id}>
                    <td style={{ fontWeight: 500 }}>{app.fullName}</td>
                    <td>{app.program?.name || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                    <td style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 16 }}>
                      {app.program ? fmtMoney(app.program.cost, app.program.currency || 'USD') : '—'}
                    </td>
                    <td>{app.manager?.fullName || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => {
                          setShowForm(true);
                          // Pre-select student in form via state below
                          setPreselectedStudent({
                            studentId: app.studentId,
                            managerId: app.managerId,
                            amount: app.program?.cost,
                            currency: app.program?.currency,
                          });
                        }}
                      >
                        Записать оплату
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Управление транзакциями */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">LEDGER · ALL TRANSACTIONS</span>
        <h2 className="crm-section-title">
          Журнал <em>транзакций.</em>
        </h2>
      </div>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="pagination-controls" style={{ padding: 4 }}>
          <button
            className={!filterType ? 'active' : ''}
            onClick={() => setFilterType('')}
          >
            Все
          </button>
          <button
            className={filterType === 'INCOME' ? 'active' : ''}
            onClick={() => setFilterType('INCOME')}
          >
            Доходы
          </button>
          <button
            className={filterType === 'EXPENSE' ? 'active' : ''}
            onClick={() => setFilterType('EXPENSE')}
          >
            Расходы
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>
          <Icon name="add" size={18} /> Новая транзакция
        </button>
      </div>

      <AnimatePresence>
        {showForm && (
          <TransactionForm
            students={students}
            users={users}
            preselect={preselectedStudent}
            onClose={() => { setShowForm(false); setPreselectedStudent(null); }}
            onCreated={async () => {
              setShowForm(false);
              setPreselectedStudent(null);
              await refresh();
            }}
          />
        )}
      </AnimatePresence>

      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Тип</th>
              <th>Категория</th>
              <th>Сумма</th>
              <th>Связь</th>
              <th>Комментарий</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 && (
              <tr><td colSpan={7} className="empty">Нет транзакций</td></tr>
            )}
            {transactions.map((t) => (
              <tr key={t.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fmtDate(t.date)}</td>
                <td>
                  <span className={`badge ${t.type === 'INCOME' ? 'badge-success' : 'badge-danger'}`}>
                    {t.type === 'INCOME' ? 'Доход' : 'Расход'}
                  </span>
                </td>
                <td>{TRANSACTION_CATEGORY_LABEL[t.category]}</td>
                <td style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 500,
                  fontSize: 17,
                  letterSpacing: '-0.01em',
                  color: t.type === 'INCOME' ? 'var(--primary-dark)' : 'var(--danger)',
                }}>
                  {t.type === 'INCOME' ? '+' : '−'} {fmtMoney(t.amount, t.currency)}
                </td>
                <td style={{ fontSize: 13 }}>
                  {t.student && <div>👤 {t.student.fullName}</div>}
                  {t.manager && <div style={{ color: 'var(--text-soft)' }}>💼 {t.manager.fullName}</div>}
                  {!t.student && !t.manager && <span style={{ color: 'var(--text-light)' }}>—</span>}
                </td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{t.comment || '—'}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => onDelete(t)}>
                    <Icon name="delete" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

let preselectedStudent: any = null;
function setPreselectedStudent(v: any) { preselectedStudent = v; }

function KpiBento({ eyebrow, label, value, accent, span = 'span-3' }: {
  eyebrow: string;
  label: string;
  value: string;
  accent?: boolean;
  span?: string;
}) {
  return (
    <motion.div
      className={`bento-card ${accent ? 'accent' : ''} ${span}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3 }}
    >
      <span className="bento-num">{eyebrow}</span>
      <div style={{ marginTop: 'auto' }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(40px, 5vw, 64px)',
          fontWeight: 500,
          letterSpacing: '-0.04em',
          lineHeight: 0.9,
          marginBottom: 12,
        }}>
          {value}
        </div>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: accent ? 'rgba(5,7,6,0.65)' : 'var(--text-soft)',
        }}>
          {label}
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// Form for new transaction
// ============================================================
function TransactionForm({
  students,
  users,
  preselect,
  onClose,
  onCreated,
}: {
  students: any[];
  users: any[];
  preselect: any;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useUI();
  const [type, setType] = useState<TransactionType>('INCOME');
  const [category, setCategory] = useState<TransactionCategory>('TUITION_PAYMENT');
  const [amount, setAmount] = useState<string>(preselect?.amount ? String(preselect.amount) : '');
  const [currency, setCurrency] = useState(preselect?.currency || 'USD');
  const [studentId, setStudentId] = useState<string>(preselect?.studentId || '');
  const [managerId, setManagerId] = useState<string>(preselect?.managerId || '');
  const [comment, setComment] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);

  const cats = type === 'INCOME' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      toast('Введите корректную сумму', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const dto: CreateTransactionDto = {
        type,
        category,
        amount: amt,
        currency,
        comment: comment.trim() || undefined,
        date,
        studentId: studentId || null,
        managerId: managerId || null,
      };
      await createTransaction(dto);
      toast('Транзакция создана', 'success');
      onCreated();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      style={{ overflow: 'hidden', marginBottom: 24 }}
    >
      <form
        onSubmit={onSubmit}
        className="card"
        style={{ padding: 28 }}
      >
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.16em',
          color: 'var(--primary-dark)',
          marginBottom: 6,
        }}>NEW · TRANSACTION</div>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginBottom: 24,
        }}>
          Запись <em style={{
            fontFamily: 'Times New Roman, Georgia, serif',
            fontWeight: 400,
            color: 'var(--primary-dark)',
          }}>о деньгах.</em>
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="form-group">
            <label>Тип</label>
            <select value={type} onChange={(e) => {
              const t = e.target.value as TransactionType;
              setType(t);
              setCategory(t === 'INCOME' ? 'TUITION_PAYMENT' : 'SALARY');
            }}>
              <option value="INCOME">Доход</option>
              <option value="EXPENSE">Расход</option>
            </select>
          </div>
          <div className="form-group">
            <label>Категория</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as TransactionCategory)}>
              {cats.map((c) => (
                <option key={c} value={c}>{TRANSACTION_CATEGORY_LABEL[c]}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Сумма</label>
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
          </div>
          <div className="form-group">
            <label>Валюта</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="CNY">CNY</option>
              <option value="RUB">RUB</option>
              <option value="TJS">TJS</option>
            </select>
          </div>
          <div className="form-group">
            <label>Дата</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {type === 'INCOME' && (
            <div className="form-group">
              <label>Студент</label>
              <select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                <option value="">— не выбран —</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>{s.fullName}</option>
                ))}
              </select>
            </div>
          )}
          {(type === 'EXPENSE' && category === 'SALARY') && (
            <div className="form-group">
              <label>Сотрудник (получатель)</label>
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                <option value="">— не выбран —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
            <label>Комментарий</label>
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="(опционально)" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </form>
    </motion.div>
  );
}
