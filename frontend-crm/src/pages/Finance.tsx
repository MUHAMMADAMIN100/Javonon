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
  PRODUCT_CATEGORIES,
  listTransactions,
  createTransaction,
  deleteTransaction,
  financeSummary,
  pendingPayments,
  financeIncomeSources,
  financeIncomeByProduct,
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
import { tjToday } from '../lib/tjTime';
import { useT } from '../lib/i18n';

function fmtMoney(n: number, currency = 'TJS'): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function Finance() {
  const { t } = useT();
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

  // Распределение 70/20/10 за текущий месяц + топ менеджеров
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const distributionQuery = useQuery({
    queryKey: ['finance', 'distribution', monthStart],
    queryFn: async () => {
      const m = await import('../api/finance');
      return m.financeDistribution({ from: monthStart });
    },
  });
  const distribution = distributionQuery.data;

  const topManagersQuery = useQuery({
    queryKey: ['finance', 'top-managers', monthStart],
    queryFn: async () => {
      const m = await import('../api/finance');
      return m.financeTopManagers({ from: monthStart, limit: 10 });
    },
  });
  const topManagers = topManagersQuery.data ?? [];

  const incomeSourcesQuery = useQuery({
    queryKey: ['finance', 'income-sources', monthStart],
    queryFn: () => financeIncomeSources({ from: monthStart }),
  });
  const incomeSources = incomeSourcesQuery.data ?? [];

  const incomeByProductQuery = useQuery({
    queryKey: ['finance', 'income-by-product', monthStart],
    queryFn: () => financeIncomeByProduct({ from: monthStart }),
  });
  const incomeByProduct = incomeByProductQuery.data ?? [];

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
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const rejectPayMut = useOptimisticMutation<Payment, Payment, Payment[]>({
    mutationFn: (p) => rejectPayment(p.id),
    queryKey: paymentsKey,
    applyOptimistic: (cur, p) => optimistic.removeById(cur, p.id),
    invalidateAlso: [keys.payments.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteTxMut = useOptimisticMutation<unknown, string, Transaction[]>({
    mutationFn: deleteTransaction,
    queryKey: txKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.finance.all],
    onSuccess: () => toast(t('toast.deleted'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const aiMut = useInvalidatingMutation({
    mutationFn: aiAddTransaction,
    invalidate: [keys.finance.all],
    onSuccess: (res: any) => {
      if (res.ok) {
        toast(`${res.transaction?.type === 'INCOME' ? '+' : '−'}${res.transaction?.amount}${res.transaction?.currency}`, 'success');
        setAiInput('');
      } else {
        toast(res.error || t('toast.error'), 'error');
      }
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const aiBusy = aiMut.isPending;

  const onConfirmPayment = async (p: Payment) => {
    const ok = await confirm({
      title: t('finance.payment.confirm') + '?',
      message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`,
      confirmText: t('finance.payment.confirm'),
    });
    if (!ok) return;
    confirmPayMut.mutate(p);
  };

  const onRejectPayment = async (p: Payment) => {
    const ok = await confirm({
      title: t('finance.payment.reject') + '?',
      message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`,
      danger: true,
      confirmText: t('finance.payment.reject'),
    });
    if (!ok) return;
    rejectPayMut.mutate(p);
  };

  const onAi = (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiInput.trim() || aiBusy) return;
    aiMut.mutate(aiInput);
  };

  const onDelete = async (tx: Transaction) => {
    const ok = await confirm({
      title: t('finance.confirm.delete'),
      message: `${tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')} ${fmtMoney(tx.amount, tx.currency)}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    deleteTxMut.mutate(tx.id);
  };

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">FINANCE · 08</span>
        <h2 className="crm-section-title">{t('finance.title')}</h2>
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
                {t('dashboard.finance.netProfit')}
              </div>
            </div>
          </motion.div>

          <KpiBento eyebrow="INCOME · 02" label={t('dashboard.finance.income')} value={fmtMoney(summary.totalIncome)} accent />
          <KpiBento eyebrow="EXPENSE · 03" label={t('dashboard.finance.expense')} value={fmtMoney(summary.totalExpense)} />
          <KpiBento eyebrow="COUNT · 04" label={t('finance.transactions')} value={String(summary.incomeCount + summary.expenseCount)} span="span-3" />
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
          }}>{t('finance.ai.title')}</div>
        </div>
        <input
          value={aiInput}
          onChange={(e) => setAiInput(e.target.value)}
          placeholder={t('finance.ai.placeholder')}
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
          {aiBusy ? t('common.saving') : t('common.add')} <Icon name="arrow_outward" size={14} />
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
          }}>{t('finance.chart.title')}</h3>
          <RevenueChart points={series} />
        </div>
      )}

      {/* Распределение 70/20/10 + Топ менеджеров */}
      {distribution && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 32 }}>
          <div className="card" style={{ padding: 24 }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
              color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
            }}>DISTRIBUTION · 70/20/10</div>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
              {t('finance.dist.title')}
            </h3>
            <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 12 }}>
              <b style={{ color: distribution.net >= 0 ? '#15803d' : '#b91c1c' }}>
                {distribution.net.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
              </b>
            </div>
            <DistRow label={t('finance.dist.business')} pct={70} amount={distribution.distribution.business} color="#3b82f6" />
            <DistRow label={t('finance.dist.debts')} pct={20} amount={distribution.distribution.debts} color="#f59e0b" />
            <DistRow label={t('finance.dist.reserve')} pct={10} amount={distribution.distribution.reserve} color="#10b981" />
          </div>

          <div className="card" style={{ padding: 24 }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
              color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
            }}>TOP MANAGERS · MONTH</div>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
              {t('finance.topManagers.title')}
            </h3>
            {topManagers.length === 0 ? (
              <div style={{ color: 'var(--text-soft)', textAlign: 'center', padding: 24 }}>
                {t('common.empty')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {topManagers.map((tm, i) => {
                  const total = topManagers.reduce((s, x) => s + x.amount, 0);
                  const pct = total > 0 ? (tm.amount / total) * 100 : 0;
                  return (
                    <div key={tm.manager.id}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontSize: 13 }}>
                          <b>#{i + 1}</b> {tm.manager.fullName} · {tm.count}
                        </span>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>
                          {tm.amount.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
                          <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>
                            ({pct.toFixed(0)}%)
                          </span>
                        </span>
                      </div>
                      <div style={{ height: 6, background: 'var(--bg-soft)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--primary)' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Диаграммы: источники дохода + доход по продуктам */}
      {(incomeSources.length > 0 || incomeByProduct.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 32 }}>
          {incomeSources.length > 0 && (
            <div className="card" style={{ padding: 24 }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
                color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
              }}>INCOME SOURCES · MONTH</div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
                Источники <em style={{ fontFamily: 'Times New Roman, Georgia, serif' }}>дохода.</em>
              </h3>
              <BarList
                items={incomeSources.map((s) => ({ label: s.label, value: s.amount, sub: `${s.count} шт` }))}
                colors={['#3b82f6', '#06b6d4', '#f59e0b', '#10b981', '#94a3b8']}
              />
            </div>
          )}
          {incomeByProduct.length > 0 && (
            <div className="card" style={{ padding: 24 }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
                color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
              }}>BY PRODUCT · MONTH</div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
                {t('finance.byProduct')}
              </h3>
              <BarList
                items={incomeByProduct.map((p) => ({ label: p.product, value: p.amount, sub: `${p.count} шт` }))}
                colors={['#7c3aed', '#db2777', '#0891b2', '#16a34a', '#ea580c', '#64748b']}
              />
            </div>
          )}
        </div>
      )}

      {/* Заявки на оплату от клиентов (от студентов) — ждут подтверждения бухгалтера */}
      {paymentRequests.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="crm-section-head">
            <span className="crm-section-eyebrow" style={{ color: 'var(--primary-dark)' }}>PAYMENT REQUESTS · WAITING FOR YOU</span>
            <h2 className="crm-section-title">{t('finance.paymentRequests')}</h2>
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
                  <th style={{ whiteSpace: 'nowrap' }}>{t('common.date')}</th>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('finance.col.student')}</th>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('common.amount')}</th>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('common.type')}</th>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('common.comment')}</th>
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
                          <Icon name="check" size={14} /> {t('finance.payment.confirm')}
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
            <h2 className="crm-section-title">{t('finance.outstanding')}</h2>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr><th>{t('finance.col.student')}</th><th>{t('sidebar.programs')}</th><th>{t('common.amount')}</th><th>{t('finance.col.manager')}</th><th></th></tr>
              </thead>
              <tbody>
                {pending.map((app) => (
                  <tr key={app.id}>
                    <td style={{ fontWeight: 500 }}>{app.fullName}</td>
                    <td>{app.program?.name || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                    <td style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 16 }}>
                      {app.program ? fmtMoney(app.program.cost, app.program.currency || 'TJS') : '—'}
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
                        {t('finance.recordPayment')}
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
        <h2 className="crm-section-title">{t('finance.ledger')}</h2>
      </div>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="pagination-controls" style={{ padding: 4 }}>
          <button
            className={!filterType ? 'active' : ''}
            onClick={() => setFilterType('')}
          >
            {t('common.all')}
          </button>
          <button
            className={filterType === 'INCOME' ? 'active' : ''}
            onClick={() => setFilterType('INCOME')}
          >
            {t('finance.income')}
          </button>
          <button
            className={filterType === 'EXPENSE' ? 'active' : ''}
            onClick={() => setFilterType('EXPENSE')}
          >
            {t('finance.expense')}
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>
          <Icon name="add" size={18} /> {t('finance.newTransaction')}
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
              <th>{t('finance.col.date')}</th>
              <th>{t('finance.col.type')}</th>
              <th>{t('finance.col.category')}</th>
              <th>{t('finance.col.amount')}</th>
              <th>{t('finance.col.student')}</th>
              <th>{t('finance.col.comment')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 && (
              <tr><td colSpan={7} className="empty">{t('finance.empty')}</td></tr>
            )}
            {transactions.map((tx) => (
              <tr key={tx.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fmtDate(tx.date)}</td>
                <td>
                  <span className={`badge ${tx.type === 'INCOME' ? 'badge-success' : 'badge-danger'}`}>
                    {tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')}
                  </span>
                </td>
                <td>{t(`finance.cat.${tx.category}`) !== `finance.cat.${tx.category}` ? t(`finance.cat.${tx.category}`) : TRANSACTION_CATEGORY_LABEL[tx.category]}</td>
                <td style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 500,
                  fontSize: 17,
                  letterSpacing: '-0.01em',
                  color: tx.type === 'INCOME' ? 'var(--primary-dark)' : 'var(--danger)',
                }}>
                  {tx.type === 'INCOME' ? '+' : '−'} {fmtMoney(tx.amount, tx.currency)}
                </td>
                <td style={{ fontSize: 13 }}>
                  {tx.student && <div>👤 {tx.student.fullName}</div>}
                  {tx.manager && <div style={{ color: 'var(--text-soft)' }}>💼 {tx.manager.fullName}</div>}
                  {!tx.student && !tx.manager && <span style={{ color: 'var(--text-light)' }}>—</span>}
                </td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{tx.comment || '—'}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => onDelete(tx)}>
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
  const { t } = useT();
  const [type, setType] = useState<TransactionType>('INCOME');
  const [category, setCategory] = useState<TransactionCategory>('TUITION_PAYMENT');
  const [amount, setAmount] = useState<string>(preselect?.amount ? String(preselect.amount) : '');
  const [currency, setCurrency] = useState(preselect?.currency || 'TJS');
  const [studentId, setStudentId] = useState<string>(preselect?.studentId || '');
  const [managerId, setManagerId] = useState<string>(preselect?.managerId || '');
  const [comment, setComment] = useState('');
  // Сегодня — по Asia/Dushanbe (toISOString даёт UTC-день, что после 19:00
  // ТJT уже завтра по UTC и форма открывалась бы с завтрашним числом).
  const [date, setDate] = useState(tjToday());
  const [submitting, setSubmitting] = useState(false);

  // Расширенные поля для финансового модуля
  const [paymentChannel, setPaymentChannel] = useState<string>('CASH');
  const [paymentKind, setPaymentKind] = useState<string>('FULL');
  const [productCategory, setProductCategory] = useState<string>('');
  const [payerName, setPayerName] = useState('');
  const [receiptKind, setReceiptKind] = useState<string>('RECEIPT');
  const [noReceiptReason, setNoReceiptReason] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);

  const cats = type === 'INCOME' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      toast(t('toast.error'), 'error');
      return;
    }
    if (type === 'EXPENSE') {
      if (receiptKind === 'REASON_ONLY') {
        if (!noReceiptReason.trim() || noReceiptReason.trim().length < 5) {
          toast(t('toast.error'), 'error');
          return;
        }
      } else if (!receiptFile) {
        toast(t('toast.error'), 'error');
        return;
      }
    }
    setSubmitting(true);
    try {
      // Сначала загружаем чек (если есть)
      let receiptUrl: string | undefined;
      if (receiptFile) {
        setUploadingReceipt(true);
        const m = await import('../api/finance');
        const uploaded = await m.uploadReceipt(receiptFile);
        receiptUrl = uploaded.url;
        setUploadingReceipt(false);
      }

      const dto: CreateTransactionDto = {
        type,
        category,
        amount: amt,
        currency,
        comment: comment.trim() || undefined,
        date,
        studentId: studentId || null,
        managerId: managerId || null,
        paymentChannel: paymentChannel as any,
        ...(type === 'INCOME' && { paymentKind: paymentKind as any }),
        ...(type === 'INCOME' && productCategory && { productCategory }),
        ...(payerName.trim() && { payerName: payerName.trim() }),
        ...(type === 'EXPENSE' && {
          receiptKind: receiptKind as any,
          receiptUrl,
          ...(receiptKind === 'REASON_ONLY' && { noReceiptReason: noReceiptReason.trim() }),
        }),
      };
      await createTransaction(dto);
      toast(t('toast.created'), 'success');
      onCreated();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSubmitting(false);
      setUploadingReceipt(false);
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
          {t('finance.newTransaction')}
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="form-group">
            <label>{t('common.type')}</label>
            <select value={type} onChange={(e) => {
              const tt = e.target.value as TransactionType;
              setType(tt);
              setCategory(tt === 'INCOME' ? 'TUITION_PAYMENT' : 'SALARY');
            }}>
              <option value="INCOME">{t('finance.income')}</option>
              <option value="EXPENSE">{t('finance.expense')}</option>
            </select>
          </div>
          <div className="form-group">
            <label>{t('finance.col.category')}</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as TransactionCategory)}>
              {cats.map((c) => (
                <option key={c} value={c}>{TRANSACTION_CATEGORY_LABEL[c]}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>{t('common.amount')}</label>
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
          </div>
          <div className="form-group">
            <label>{t('finance.col.currency')}</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="CNY">CNY</option>
              <option value="RUB">RUB</option>
              <option value="TJS">TJS</option>
            </select>
          </div>
          <div className="form-group">
            <label>{t('common.date')}</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.col.student')}</label>
              <select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                <option value="">—</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>{s.fullName}</option>
                ))}
              </select>
            </div>
          )}
          {(type === 'EXPENSE' && category === 'SALARY') && (
            <div className="form-group">
              <label>{t('salary.field.employee')}</label>
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                <option value="">—</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </select>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.col.manager')}</label>
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                <option value="">—</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label>{t('finance.paymentChannel')}</label>
            <select value={paymentChannel} onChange={(e) => setPaymentChannel(e.target.value)}>
              <option value="CASH">{t('finance.channel.CASH')}</option>
              <option value="ALIF_MOBILE">{t('finance.channel.ALIF_MOBILE')}</option>
              <option value="BANK_TRANSFER">{t('finance.channel.BANK_TRANSFER')}</option>
              <option value="CARD">{t('finance.channel.CARD')}</option>
              <option value="CRYPTO">Crypto</option>
              <option value="OTHER">{t('userDoc.OTHER')}</option>
            </select>
          </div>
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.paymentKind')}</label>
              <select value={paymentKind} onChange={(e) => setPaymentKind(e.target.value)}>
                <option value="FULL">{t('finance.kind.FULL')}</option>
                <option value="PREPAYMENT">{t('finance.kind.PREPAYMENT')}</option>
                <option value="ADDITIONAL">{t('finance.kind.ADDITIONAL')}</option>
                <option value="OWNER_INVESTMENT">{t('finance.kind.OWNER_INVESTMENT')}</option>
              </select>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.product')}</label>
              <select value={productCategory} onChange={(e) => setProductCategory(e.target.value)}>
                <option value="">—</option>
                {PRODUCT_CATEGORIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.payerName')}</label>
              <input type="text" value={payerName} onChange={(e) => setPayerName(e.target.value)} />
            </div>
          )}
          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
            <label>{t('app.field.comment')}</label>
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>

          {type === 'EXPENSE' && (
            <div className="form-group" style={{ gridColumn: '1 / -1', padding: 14, background: 'var(--bg-soft)', borderRadius: 12 }}>
              <label style={{ fontWeight: 600, marginBottom: 8 }}>
                Подтверждение расхода (обязательно)
              </label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <RadioBtn label="📄 Чек" active={receiptKind === 'RECEIPT'} onClick={() => setReceiptKind('RECEIPT')} />
                <RadioBtn label="💵 Фото наличных" active={receiptKind === 'CASH_PHOTO'} onClick={() => setReceiptKind('CASH_PHOTO')} />
                <RadioBtn label="📝 Только причина" active={receiptKind === 'REASON_ONLY'} onClick={() => setReceiptKind('REASON_ONLY')} />
              </div>
              {receiptKind === 'REASON_ONLY' ? (
                <input
                  type="text"
                  value={noReceiptReason}
                  onChange={(e) => setNoReceiptReason(e.target.value)}
                  placeholder="Почему нет чека (мин. 5 символов)"
                  required
                />
              ) : (
                <div>
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                    required
                  />
                  {receiptFile && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-soft)' }}>
                      {receiptFile.name} · {(receiptFile.size / 1024).toFixed(0)} КБ
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={submitting || uploadingReceipt}>
            {uploadingReceipt ? 'Загружаем чек...' : submitting ? 'Сохраняем...' : 'Сохранить'}
          </button>
        </div>
      </form>
    </motion.div>
  );
}

function RadioBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px',
        border: `1.5px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 999,
        background: active ? 'var(--primary-soft)' : 'white',
        color: active ? 'var(--primary-dark)' : 'var(--text)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
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

/** Универсальный список с прогресс-барами (для диаграмм). */
function BarList({ items, colors }: {
  items: Array<{ label: string; value: number; sub?: string }>;
  colors: string[];
}) {
  const total = items.reduce((s, x) => s + x.value, 0);
  if (total === 0) {
    return <div style={{ color: 'var(--text-soft)', textAlign: 'center', padding: 16 }}>Нет данных</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => {
        const pct = (it.value / total) * 100;
        const color = colors[i % colors.length];
        return (
          <div key={it.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontSize: 13 }}>
                {it.label}{it.sub && <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>{it.sub}</span>}
              </span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>
                {it.value.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
                <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>({pct.toFixed(0)}%)</span>
              </span>
            </div>
            <div style={{ height: 8, background: 'var(--bg-soft)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DistRow({ label, pct, amount, color }: { label: string; pct: number; amount: number; color: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 13 }}>
          <b style={{ color }}>{pct}%</b> · {label}
        </span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          {amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
        </span>
      </div>
      <div style={{ height: 8, background: 'var(--bg-soft)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
