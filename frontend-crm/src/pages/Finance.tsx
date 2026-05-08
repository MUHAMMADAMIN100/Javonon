import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { aiAddTransaction } from '../api/ai';
import { financeTimeseries, type TimeseriesPoint } from '../api/finance';
import { listPayments, confirmPayment, rejectPayment, type Payment, PAYMENT_METHOD_LABEL } from '../api/payments';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';

function fmtMoney(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function Finance() {
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const [filterType, setFilterType] = useState<TransactionType | ''>('');
  const [showForm, setShowForm] = useState(false);
  const [aiInput, setAiInput] = useState('');

  const txKey = keys.finance.transactions(filterType ? { type: filterType, take: 200 } : { take: 200 });
  const txQuery = useQuery({
    queryKey: txKey,
    queryFn: () => listTransactions(filterType ? { type: filterType, take: 200 } : { take: 200 }),
  });
  const transactions = txQuery.data ?? [];

  const summaryQuery = useQuery({
    queryKey: keys.finance.summary(),
    queryFn: () => financeSummary(),
  });
  const summary = summaryQuery.data ?? null;

  const pendingQuery = useQuery({
    queryKey: keys.finance.pending(),
    queryFn: () => pendingPayments(),
  });
  const pending = pendingQuery.data ?? [];

  const seriesQuery = useQuery({
    queryKey: keys.finance.timeseries({ bucket: 'week' }),
    queryFn: () => financeTimeseries({ bucket: 'week' }),
  });
  const series = seriesQuery.data ?? [];

  const paymentsKey = keys.payments.list({ status: 'PENDING' });
  const paymentsQuery = useQuery({
    queryKey: paymentsKey,
    queryFn: () => listPayments('PENDING'),
  });
  const paymentRequests = paymentsQuery.data ?? [];

  const studentsQuery = useQuery({
    queryKey: keys.students.list(),
    queryFn: () => listStudents({}),
  });
  const students = studentsQuery.data ?? [];

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
  });
  const users = usersQuery.data ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.finance.all });
    qc.invalidateQueries({ queryKey: keys.payments.all });
  };

  // Confirm payment — оптимистично убираем из PENDING-списка.
  const confirmPayMut = useOptimisticMutation<Payment, Payment, Payment[]>({
    mutationFn: (p) => confirmPayment(p.id, {}),
    queryKey: paymentsKey,
    applyOptimistic: (cur, p) => optimistic.removeById(cur, p.id),
    invalidateAlso: [keys.finance.all, keys.payments.all],
    onSuccess: () => toast('Оплата подтверждена', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const rejectPayMut = useOptimisticMutation<Payment, Payment, Payment[]>({
    mutationFn: (p) => rejectPayment(p.id),
    queryKey: paymentsKey,
    applyOptimistic: (cur, p) => optimistic.removeById(cur, p.id),
    invalidateAlso: [keys.payments.all],
    onSuccess: () => toast('Отклонено', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const deleteTxMut = useOptimisticMutation<unknown, string, Transaction[]>({
    mutationFn: deleteTransaction,
    queryKey: txKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.finance.all],
    onSuccess: () => toast('Удалено', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const aiMut = useInvalidatingMutation({
    mutationFn: aiAddTransaction,
    invalidate: [keys.finance.all],
    onSuccess: (res: any) => {
      if (res.ok) {
        toast(`Добавлено: ${res.transaction?.type === 'INCOME' ? '+' : '−'}${res.transaction?.amount}${res.transaction?.currency}`, 'success');
        setAiInput('');
      } else {
        toast(res.error || 'Не распознано', 'error');
      }
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });
  const aiBusy = aiMut.isPending;

  const onConfirmPayment = async (p: Payment) => {
    const ok = await confirm({
      title: 'Подтвердить оплату?',
      message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}. Будет создана транзакция-доход.`,
      confirmText: 'Подтвердить',
    });
    if (!ok) return;
    confirmPayMut.mutate(p);
  };

  const onRejectPayment = async (p: Payment) => {
    const ok = await confirm({
      title: 'Отклонить заявку?',
      message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`,
      danger: true,
      confirmText: 'Отклонить',
    });
    if (!ok) return;
    rejectPayMut.mutate(p);
  };

  const onAi = (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiInput.trim() || aiBusy) return;
    aiMut.mutate(aiInput);
  };

  const onDelete = async (t: Transaction) => {
    const ok = await confirm({
      title: 'Удалить транзакцию?',
      message: `${t.type === 'INCOME' ? 'Доход' : 'Расход'} ${fmtMoney(t.amount, t.currency)}`,
      danger: true,
      confirmText: 'Удалить',
    });
    if (!ok) return;
    deleteTxMut.mutate(t.id);
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

      {/* AI quick add */}
      <motion.form
        onSubmit={onAi}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background: 'var(--text)',
          color: 'white',
          padding: 18,
          borderRadius: 18,
          marginBottom: 24,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'var(--primary)',
          color: 'var(--text)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon name="auto_awesome" size={18} />
        </div>
        <div style={{ flexShrink: 0 }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.16em',
            color: 'var(--primary-light)',
            marginBottom: 4,
            textTransform: 'uppercase',
          }}>AI · QUICK ENTRY</div>
          <div style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 500,
          }}>Добавь <em style={{
            fontFamily: 'Times New Roman, Georgia, serif',
            fontWeight: 400,
            color: 'var(--primary-light)',
          }}>командой.</em></div>
        </div>
        <input
          value={aiInput}
          onChange={(e) => setAiInput(e.target.value)}
          placeholder='Например: "добавь расход 200$ аренда"'
          style={{
            flex: 1,
            minWidth: 240,
            padding: '12px 16px',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.16)',
            color: 'white',
            borderRadius: 100,
            fontSize: 14,
            fontFamily: 'inherit',
          }}
        />
        <button
          type="submit"
          className="btn"
          style={{
            background: 'var(--primary)',
            color: 'var(--text)',
            border: 'none',
          }}
          disabled={aiBusy || !aiInput.trim()}
        >
          {aiBusy ? 'Парсим...' : 'Добавить'} <Icon name="arrow_outward" size={14} />
        </button>
      </motion.form>

      {/* Revenue chart (timeseries) */}
      {series.length > 0 && (
        <div className="card" style={{ padding: 28, marginBottom: 24 }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            color: 'var(--primary-dark)',
            marginBottom: 6,
          }}>REVENUE · WEEKLY</div>
          <h3 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 500,
            letterSpacing: '-0.02em',
            marginBottom: 24,
          }}>Динамика <em style={{
            fontFamily: 'Times New Roman, Georgia, serif',
            fontWeight: 400,
            color: 'var(--primary-dark)',
          }}>денежных потоков.</em></h3>
          <RevenueChart points={series} />
        </div>
      )}

      {/* Заявки на оплату от клиентов (от студентов) — ждут подтверждения бухгалтера */}
      {paymentRequests.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="crm-section-head">
            <span className="crm-section-eyebrow" style={{ color: 'var(--primary-dark)' }}>PAYMENT REQUESTS · WAITING FOR YOU</span>
            <h2 className="crm-section-title">
              Заявки <em>на оплату.</em>
            </h2>
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', tableLayout: 'fixed' }}>
              {/* QA-fix #5: фиксируем ширины и no-wrap для заголовков
                  (раньше «КОГДА / СТУДЕНТ» сжимались до 1 буквы), плюс
                  truncate для длинного комментария чтобы не ломал layout. */}
              <colgroup>
                <col style={{ width: '14%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '26%' }} />
                <col style={{ width: '16%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ whiteSpace: 'nowrap' }}>Когда</th>
                  <th style={{ whiteSpace: 'nowrap' }}>Студент</th>
                  <th style={{ whiteSpace: 'nowrap' }}>Сумма</th>
                  <th style={{ whiteSpace: 'nowrap' }}>Метод</th>
                  <th style={{ whiteSpace: 'nowrap' }}>Комментарий</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {paymentRequests.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(p.createdAt)}</td>
                    <td style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.student?.fullName}</td>
                    <td style={{
                      fontFamily: 'var(--font-display)',
                      fontWeight: 500,
                      fontSize: 18,
                      color: 'var(--primary-dark)',
                      whiteSpace: 'nowrap',
                    }}>{fmtMoney(p.amount, p.currency)}</td>
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{PAYMENT_METHOD_LABEL[p.method]}</td>
                    <td
                      style={{
                        color: 'var(--text-soft)', fontSize: 13,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        maxWidth: 0,
                      }}
                      title={p.comment || ''}
                    >
                      {p.comment || '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-primary" onClick={() => onConfirmPayment(p)}>
                          <Icon name="check" size={14} /> Подтвердить
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => onRejectPayment(p)}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            onCreated={() => {
              setShowForm(false);
              setPreselectedStudent(null);
              refresh();
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

// ============================================================
// Revenue chart — pure SVG, dual line (income / expense) + profit area
// ============================================================
function RevenueChart({ points }: { points: TimeseriesPoint[] }) {
  const width = 800;
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 28, left: 50 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const maxValue = Math.max(
    ...points.map((p) => Math.max(p.income, p.expense)),
    100,
  );

  const xStep = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const x = (i: number) => padding.left + i * xStep;
  const y = (v: number) => padding.top + innerH - (v / maxValue) * innerH;

  const incomePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.income)}`).join(' ');
  const expensePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.expense)}`).join(' ');
  const profitArea = `M ${x(0)} ${y(0)} ${points.map((p, i) => `L ${x(i)} ${y(Math.max(0, p.profit))}`).join(' ')} L ${x(points.length - 1)} ${y(0)} Z`;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} style={{ minWidth: 600, display: 'block' }}>
        {/* grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={padding.top + innerH * (1 - p)}
              y2={padding.top + innerH * (1 - p)}
              stroke="var(--border-soft)"
              strokeDasharray="2 4"
            />
            <text
              x={padding.left - 8}
              y={padding.top + innerH * (1 - p) + 4}
              fontFamily="var(--font-mono)"
              fontSize="10"
              fill="var(--text-light)"
              textAnchor="end"
            >
              {Math.round((maxValue * p) / 1000) || 0}K
            </text>
          </g>
        ))}

        {/* Profit area (emerald-soft) */}
        <path d={profitArea} fill="rgba(1, 54, 139,0.12)" />

        {/* Income line */}
        <path d={incomePath} stroke="var(--primary)" strokeWidth={2.5} fill="none" />
        {/* Expense line */}
        <path d={expensePath} stroke="var(--danger)" strokeWidth={2} fill="none" strokeDasharray="4 4" />

        {/* Points + x-axis labels */}
        {points.map((p, i) => (
          <g key={p.key}>
            <circle cx={x(i)} cy={y(p.income)} r={3} fill="var(--primary)" />
            <circle cx={x(i)} cy={y(p.expense)} r={2.5} fill="var(--danger)" />
            {(i % Math.max(1, Math.ceil(points.length / 8)) === 0 || i === points.length - 1) && (
              <text
                x={x(i)}
                y={padding.top + innerH + 16}
                fontFamily="var(--font-mono)"
                fontSize="9"
                fill="var(--text-light)"
                textAnchor="middle"
              >
                {p.key.slice(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div style={{
        display: 'flex',
        gap: 24,
        marginTop: 12,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.06em',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 2, background: 'var(--primary)' }} />
          ДОХОДЫ
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 2, background: 'var(--danger)' }} />
          РАСХОДЫ
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, background: 'rgba(1, 54, 139,0.3)' }} />
          ПРИБЫЛЬ
        </div>
      </div>
    </div>
  );
}
