import { lazy, Suspense, useMemo, useRef, useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
// Графики — отдельным куском сборки: Recharts грузится, только когда открыли «Аналитику».
const FinanceAnalytics = lazy(() => import('../components/FinanceAnalytics'));
import FinanceDetails, { type FinanceDetailKind } from '../components/FinanceDetails';
import PeriodSwitcher, { useDashboardPeriod } from '../components/PeriodSwitcher';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import FinanceSubnav from '../components/finance/FinanceSubnav';
import TransactionForm, { preselectedStudent, setPreselectedStudent } from '../components/finance/TransactionForm';
import TransactionDetailModal from '../components/finance/TransactionDetailModal';
import RevenueDistributionCard from '../components/finance/RevenueDistributionCard';
import { TransferForm, TransferDetailModal } from '../components/finance/Transfers';
import {
  AccountMark,
  fmtDate,
  fmtMoney,
  MonthNav,
  monthLabel,
  monthRange,
  periodLabel,
  shiftYm,
  useYmParam,
} from '../components/finance/financeShared';
import {
  type Transaction,
  type TransactionType,
  type FinanceTransfer,
  TRANSACTION_CATEGORY_LABEL,
  financeByCategory,
  financeOverview,
  financeTimeseries,
  listAccounts,
  listTransfers,
  loadAllTransactions,
  pendingPayments,
  deleteTransaction,
} from '../api/finance';
import { listPayments, confirmPayment, rejectPayment, type Payment, PAYMENT_METHOD_LABEL } from '../api/payments';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useOptimisticMutation } from '../lib/optimistic';
import { useT } from '../lib/i18n';
import { tjDateInput } from '../lib/tjTime';
import { useRealtime } from '../realtime';
import { useAuth } from '../store/auth';
import { hasRole, isElevated } from '../lib/roles';
import { roleCan } from '../lib/permissions';

/**
 * «Финансы → Обзор» (перенос раздела из Sabt, макет утверждён 10.11.2026).
 *
 * Вкладка «Месяц»: деньги на счетах, доход / расход / результат месяца,
 * быстрые карточки с окнами «подробнее», денежный поток за 12 месяцев,
 * заявки на оплату, задолженность студентов, распределение по схеме и
 * последние операции. Вкладка «Аналитика» — прежние графики со своим
 * периодом. Полный журнал — на «Финансы → Транзакции».
 */

const PRODUCT_ORDER = ['CONTRACT', 'ACADEMY', 'MASTERCLASS', 'OTHER'] as const;
const PRODUCT_COLOR: Record<string, string> = { CONTRACT: '#01368B', ACADEMY: '#0E7C86', MASTERCLASS: '#7C3AED', OTHER: '#64748B' };
const EXPENSE_COLOR: Record<string, string> = {
  SALARY: '#C2410C', RENT: '#4F46E5', UTILITIES: '#0891B2', MARKETING: '#BE185D', TARGETED_ADS: '#DB2777',
  OFFICE: '#0E7C86', MISC_EXPENSE: '#64748B', OTHER_EXPENSE: '#475569',
};

export default function Finance() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const mySelfId = me?.id ?? '';
  // Права — как на сервере (finance.controller.ts / payments.controller.ts).
  const elevated = isElevated(me);
  const hasCustomRole = !!me?.customRole && me.customRole.isActive !== false;
  const managerBaseRole = hasRole(me, 'SALES_MANAGER', 'CLIENT_MANAGER');
  const canCreateTx = roleCan(me, 'finance:create', elevated || (!hasCustomRole && managerBaseRole));
  const canExpense = roleCan(me, 'finance:create', hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT'));
  const canDeleteTx = roleCan(me, 'finance:delete', elevated);
  const canEditTx = roleCan(me, 'finance:update', hasRole(me, 'FOUNDER'));
  const canReviewPayments = roleCan(me, 'finance:payments', elevated);
  const canTransfer = roleCan(me, 'finance:create', elevated);
  const canManageAccounts = roleCan(me, 'finance:update', elevated);

  // Вкладки «Месяц» / «Аналитика» — в ссылке (?tab=analytics).
  const [tabParams, setTabParams] = useSearchParams();
  const tab: 'overview' | 'analytics' = tabParams.get('tab') === 'analytics' ? 'analytics' : 'overview';
  const setTab = (next: 'overview' | 'analytics') =>
    setTabParams((prev) => {
      const n = new URLSearchParams(prev);
      if (next === 'analytics') n.set('tab', 'analytics');
      else n.delete('tab');
      return n;
    }, { replace: true });
  const [ym, setYm] = useYmParam();
  const range = monthRange(ym);
  // Период «Аналитики» — свой (тот же переключатель, что на дашборде).
  const period = useDashboardPeriod();

  const [detail, setDetail] = useState<FinanceDetailKind | null>(null);
  const [formType, setFormType] = useState<TransactionType | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  const [openTx, setOpenTx] = useState<Transaction | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [openTransfer, setOpenTransfer] = useState<FinanceTransfer | null>(null);

  const monthOn = tab === 'overview';
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts, enabled: monthOn });
  const overviewQ = useQuery({ queryKey: keys.finance.overview(range), queryFn: () => financeOverview(range), enabled: monthOn });
  const allTimeQ = useQuery({ queryKey: keys.finance.overview({}), queryFn: () => financeOverview({}), enabled: monthOn });
  const categoryQ = useQuery({ queryKey: keys.finance.byCategory(range), queryFn: () => financeByCategory(range), enabled: monthOn });
  const flowFrom = monthRange(shiftYm(ym, -11)).from;
  const flowQ = useQuery({
    queryKey: keys.finance.timeseries({ from: flowFrom, to: range.to, bucket: 'month' }),
    queryFn: () => financeTimeseries({ from: flowFrom, to: range.to, bucket: 'month' }),
    enabled: monthOn,
  });
  const txQ = useQuery({ queryKey: keys.finance.transactions(range), queryFn: () => loadAllTransactions(range), enabled: monthOn });
  const transfersQ = useQuery({ queryKey: keys.finance.transfers(range), queryFn: () => listTransfers(range), enabled: monthOn });
  const pendingQ = useQuery({ queryKey: keys.finance.pending(), queryFn: () => pendingPayments(), enabled: monthOn });
  const pending = pendingQ.data ?? [];
  // Распределение по схеме основателя — во вкладке «Аналитика», за её период
  // (месяц, квартал, год, всё время, свой).
  const distRange = period.range;
  const distributionQ = useQuery({
    queryKey: ['finance', 'distribution', distRange.from ?? '', distRange.to ?? ''],
    queryFn: async () => (await import('../api/finance')).financeDistribution(distRange),
    enabled: tab === 'analytics' && !period.invalid,
  });
  const paymentsKey = keys.payments.list({ status: 'PENDING' });
  const paymentsQ = useQuery({ queryKey: paymentsKey, queryFn: () => listPayments('PENDING'), enabled: monthOn && canReviewPayments });
  const paymentRequests = paymentsQ.data ?? [];

  const overview = overviewQ.data ?? null;

  // Realtime: чужие правки обновляют экран без перезагрузки (раз в 400 мс пачкой).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flags = useRef({ finance: false, payments: false });
  const schedule = (b: { finance?: boolean; payments?: boolean }) => {
    if (b.finance) flags.current.finance = true;
    if (b.payments) flags.current.payments = true;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const f = flags.current;
      flags.current = { finance: false, payments: false };
      if (f.finance) qc.invalidateQueries({ queryKey: keys.finance.all });
      if (f.payments) qc.invalidateQueries({ queryKey: keys.payments.all });
    }, 400);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useRealtime({
    'transaction:new': () => schedule({ finance: true }),
    'transaction:updated': () => schedule({ finance: true }),
    'transaction:deleted': () => schedule({ finance: true }),
    'transaction:reversed': () => schedule({ finance: true }),
    'finance:accounts': () => schedule({ finance: true }),
    'payment:pending': () => schedule({ payments: true, finance: true }),
    'payment:confirmed': () => schedule({ payments: true, finance: true }),
  });

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
  const onConfirmPayment = async (p: Payment) => {
    const ok = await confirm({ title: t('finance.payment.confirm') + '?', message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`, confirmText: t('finance.payment.confirm') });
    if (ok) confirmPayMut.mutate(p);
  };
  const onRejectPayment = async (p: Payment) => {
    const ok = await confirm({ title: t('finance.payment.reject') + '?', message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`, danger: true, confirmText: t('finance.payment.reject') });
    if (ok) rejectPayMut.mutate(p);
  };
  const onDeleteTx = async (tx: Transaction) => {
    const ok = await confirm({
      title: t('finance.confirm.delete'),
      message: `${tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')} ${fmtMoney(tx.amount, tx.currency)}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await deleteTransaction(tx.id);
      toast(t('toast.deleted'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const paymentsSort = useTableSort(
    paymentRequests,
    [
      { key: 'date', label: t('common.date'), type: 'date', value: (p) => p.createdAt },
      { key: 'student', label: t('finance.col.student'), value: (p) => p.student?.fullName },
      { key: 'amount', label: t('common.amount'), type: 'number', value: (p) => Number(p.amount) },
      { key: 'type', label: t('common.type'), value: (p) => PAYMENT_METHOD_LABEL[p.method] },
      { key: 'comment', label: t('common.comment'), value: (p) => p.comment },
    ],
    { param: 'sortRequests' },
  );
  const pendingSort = useTableSort(
    pending,
    [
      { key: 'student', label: t('finance.col.debtor'), value: (a) => a.fullName },
      { key: 'program', label: t('sidebar.programs'), value: (a) => a.debt?.programName ?? a.program?.name },
      { key: 'amount', label: t('finance.debt.col'), type: 'number', value: (a) => a.debt?.amount ?? null },
      { key: 'manager', label: t('finance.col.manager'), value: (a) => a.manager?.fullName },
    ],
    { param: 'sortDebts' },
  );

  // Последние операции месяца: операции и переводы вместе, новые сверху.
  const recent = useMemo(() => {
    type Row = { key: string; date: string; created: string; tx?: Transaction; tr?: FinanceTransfer };
    const rows: Row[] = [
      ...(txQ.data ?? []).map((tx) => ({ key: `tx-${tx.id}`, date: tx.date, created: tx.createdAt, tx })),
      ...(transfersQ.data ?? []).filter((x) => !x.reversedAt).map((tr) => ({ key: `tr-${tr.id}`, date: tr.date, created: tr.createdAt, tr })),
    ];
    rows.sort((a, b) => (tjDateInput(b.date) + b.created).localeCompare(tjDateInput(a.date) + a.created));
    return rows.slice(0, 7);
  }, [txQ.data, transfersQ.data]);

  const catLabel = (cat: string) => {
    const k = `finance.cat.${cat}`;
    return t(k) !== k ? t(k) : (TRANSACTION_CATEGORY_LABEL as any)[cat] ?? cat;
  };

  return (
    <>
      <FinanceSubnav />
      <div className="fin-toolbar">
        <div className="page-tabs" role="tablist" aria-label={t('finance.title')}>
          {(['overview', 'analytics'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={`page-tab${tab === k ? ' is-active' : ''}`}
              onClick={() => setTab(k)}
              data-testid={`finance-tab-${k}`}
            >
              <Icon name={k === 'overview' ? 'calendar_month' : 'monitoring'} size={18} />
              {t(k === 'overview' ? 'finance.tab.month' : 'finance.tab.analytics')}
            </button>
          ))}
        </div>
        {tab === 'overview' && <MonthNav ym={ym} onChange={setYm} busy={overviewQ.isFetching || txQ.isFetching} />}
        <div className="fin-toolbar-actions">
          {canTransfer && (
            <button type="button" className="btn btn-secondary" onClick={() => setShowTransfer(true)} data-testid="finance-new-transfer">
              <Icon name="swap_horiz" size={18} /> {t('finance.tr.new')}
            </button>
          )}
          {canCreateTx && (
            <button type="button" className="btn btn-primary" onClick={() => setFormType('INCOME')} data-testid="finance-new">
              <Icon name="add" size={18} /> {t('finance.newOperation')}
            </button>
          )}
        </div>
      </div>

      {tab === 'analytics' ? (
        <>
          <PeriodSwitcher state={period} />
          <Suspense fallback={<div className="card" style={{ padding: 24, color: 'var(--text-light)' }}>{t('common.loading')}</div>}>
            <FinanceAnalytics range={period.range} rangeOk={!period.invalid} period={period.period} />
          </Suspense>
          {distributionQ.data && (
            <section className="fin-block" style={{ marginTop: 18 }}>
              <RevenueDistributionCard breakdown={distributionQ.data} />
            </section>
          )}
        </>
      ) : (
        <>
          <AccountsStrip
            data={accountsQ.data}
            loading={accountsQ.isLoading}
            error={accountsQ.isError}
            canManage={canManageAccounts}
          />

          {/* Нет доступа к сводке (менеджер открыл страницу по ссылке) — карточек нет, а не пустые прочерки. */}
          {!overviewQ.isError && (
            <div className="fin-month" data-testid="owner-kpis">
              <div className="fin-month-cards">
                <MonthIncomeCard
                  overview={overview}
                  allTime={allTimeQ.data?.totalIncome}
                  transactions={txQ.data}
                  periodText={periodLabel(range, t)}
                  onOpen={() => setDetail('revenue')}
                />
                <MonthExpenseCard
                  overview={overview}
                  allTime={allTimeQ.data?.totalExpense}
                  categories={categoryQ.data}
                  catLabel={catLabel}
                  onOpenSalary={() => setDetail('salary')}
                  onOpenOther={() => setDetail('expenses')}
                />
                <MonthResultCard overview={overview} onOpen={() => setDetail('profit')} />
              </div>
              <QuickCards overview={overview} debts={pending} onOpen={setDetail} />
            </div>
          )}

          <CashFlow data={flowQ.data} ym={ym} loading={flowQ.isLoading} onPick={setYm} />

          {/* Заявки на оплату от студентов — подтверждают основатель, админ и бухгалтер. */}
          {canReviewPayments && paymentRequests.length > 0 && (
            <section className="fin-block">
              <div className="crm-section-head">
                <span className="crm-section-eyebrow" style={{ color: 'var(--primary-dark)' }}>{t('eyebrow.paymentRequests')}</span>
                <h2 className="crm-section-title">{t('finance.paymentRequests')}</h2>
              </div>
              <SortSelect sort={paymentsSort} />
              <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
                <table className="table" style={{ width: '100%', tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '19%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '22%' }} />
                    <col style={{ width: '21%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {paymentsSort.columns.map((c) => <SortTh key={c.key} sort={paymentsSort} col={c.key} style={{ whiteSpace: 'nowrap' }} />)}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentsSort.sorted.map((p) => (
                      <tr key={p.id}>
                        <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{fmtDate(p.createdAt)}</td>
                        <td data-label={paymentsSort.label('student')} style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.student?.fullName}</td>
                        <td data-label={paymentsSort.label('amount')} className="fin-money is-in" style={{ whiteSpace: 'nowrap' }}>{fmtMoney(p.amount, p.currency)}</td>
                        <td data-label={paymentsSort.label('type')} style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{PAYMENT_METHOD_LABEL[p.method]}</td>
                        <td data-label={paymentsSort.label('comment')} className="td-stack" style={{ color: 'var(--text-soft)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 0 }} title={p.comment || ''}>
                          {p.comment || '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-sm btn-primary" onClick={() => onConfirmPayment(p)}>
                              <Icon name="check" size={14} /> {t('finance.payment.confirm')}
                            </button>
                            <button className="btn btn-sm btn-danger" onClick={() => onRejectPayment(p)} aria-label={t('finance.payment.reject')}>
                              <Icon name="close" size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Задолженность студентов: блок есть всегда — «должников нет» тоже ответ. */}
          <section id="finance-debts" className="fin-block" style={{ scrollMarginTop: 90 }}>
            <div className="crm-section-head">
              <span className="crm-section-eyebrow" style={{ color: '#b45309' }}>{t('eyebrow.outstandingPayment')}</span>
              <h2 className="crm-section-title">{t('finance.outstanding')}</h2>
            </div>
            {pendingQ.isError ? (
              <div className="error-banner">{t('finance.outstanding.error')}</div>
            ) : pendingQ.isLoading ? (
              <div className="card" style={{ color: 'var(--text-light)' }}>{t('common.loading')}</div>
            ) : pending.length === 0 ? (
              <div className="card" style={{ color: 'var(--text-light)' }}>{t('finance.outstanding.empty')}</div>
            ) : (
              <>
                <SortSelect sort={pendingSort} />
                <div className="card" style={{ padding: 0 }}>
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        {pendingSort.columns.map((c) => <SortTh key={c.key} sort={pendingSort} col={c.key} />)}
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingSort.sorted.map((app) => (
                        <tr key={app.id}>
                          <td style={{ fontWeight: 500 }}>
                            <Link to={`/applications/${app.id}`} style={{ color: 'inherit' }} data-testid="debt-open">{app.fullName}</Link>
                          </td>
                          <td data-label={pendingSort.label('program')}>{app.debt?.programName || app.program?.name || <span style={{ color: 'var(--text-light)' }}>{t('finance.debt.noProgram')}</span>}</td>
                          <td data-label={pendingSort.label('amount')} data-testid="debt-amount">
                            {app.debt?.amount != null ? (
                              <>
                                <span className="fin-money">{fmtMoney(app.debt.amount, app.debt.currency || 'TJS')}</span>
                                <div style={{ fontSize: 11, color: 'var(--text-soft)' }}>
                                  {app.debt.source === 'deal' ? t('finance.debt.fromDeal') : t('finance.debt.fromProgram')}
                                </div>
                              </>
                            ) : (
                              <span style={{ color: 'var(--text-light)' }} title={t('finance.debt.noAmountHint')}>{t('finance.debt.noAmount')}</span>
                            )}
                          </td>
                          <td data-label={pendingSort.label('manager')}>{app.manager?.fullName || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                          <td>
                            {/* «Внести оплату» — у кого есть право вносить операции; менеджер — только по своему студенту. */}
                            {canCreateTx && (elevated || !app.managerId || app.managerId === mySelfId) && (
                              <button
                                className="btn btn-sm btn-secondary"
                                onClick={() => {
                                  setPreselectedStudent({
                                    studentId: app.studentId,
                                    managerId: elevated ? app.managerId : mySelfId,
                                    amount: app.debt?.amount ?? app.program?.cost,
                                    currency: app.debt?.currency ?? app.program?.currency,
                                  });
                                  setFormType('INCOME');
                                }}
                              >
                                {t('finance.recordPayment')}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <section className="fin-card fin-recent" data-testid="fin-recent">
            <div className="fin-card-head">
              <h2 className="fin-card-title">{t('finance.recent.title')}</h2>
              <Link to={`/finance/transactions${ym ? `?ym=${ym}` : ''}`} className="fin-link" data-testid="fin-recent-all">{t('finance.recent.all')}</Link>
            </div>
            {txQ.isLoading ? (
              <p className="fin-empty-line">{t('common.loading')}</p>
            ) : recent.length === 0 ? (
              <p className="fin-empty-line">{t('finance.recent.empty').replace('{month}', monthLabel(ym).toLowerCase())}</p>
            ) : (
              <div className="fin-table-wrap">
                <table className="table fin-recent-table">
                  <thead>
                    <tr>
                      <th>{t('finance.col.date')}</th>
                      <th>{t('finance.col.type')}</th>
                      <th>{t('finance.recent.what')}</th>
                      <th>{t('finance.acc.field')}</th>
                      <th>{t('finance.recent.who')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.col.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => r.tx ? (
                      <tr key={r.key} className="tx-row" role="button" tabIndex={0} onClick={() => setOpenTx(r.tx!)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenTx(r.tx!); } }}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 13 }}>{fmtDate(r.tx.date)}</td>
                        <td data-label={t('finance.col.type')}><span className={`badge ${r.tx.type === 'INCOME' ? 'badge-success' : 'badge-danger'}`}>{r.tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')}</span></td>
                        <td data-label={t('finance.recent.what')}><div style={{ fontWeight: 600 }}>{catLabel(r.tx.category)}</div>{r.tx.comment && <div className="fin-muted-line">{r.tx.comment}</div>}</td>
                        <td data-label={t('finance.acc.field')} style={{ fontSize: 13 }}>{r.tx.account ? <span className="fin-acc-inline"><AccountMark account={r.tx.account} size={20} />{r.tx.account.name}</span> : <span style={{ color: 'var(--text-light)' }}>{t('finance.acc.byChannelShort')}</span>}</td>
                        <td data-label={t('finance.recent.who')} style={{ fontSize: 13 }}>{r.tx.student?.fullName || r.tx.manager?.fullName || '—'}</td>
                        <td data-label={t('finance.col.amount')} className={`fin-money ${r.tx.type === 'INCOME' ? 'is-in' : 'is-out'}`} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{r.tx.type === 'INCOME' ? '+' : '−'}{fmtMoney(r.tx.amount, r.tx.currency)}</td>
                      </tr>
                    ) : (
                      <tr key={r.key} className="tx-row" role="button" tabIndex={0} onClick={() => setOpenTransfer(r.tr!)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenTransfer(r.tr!); } }}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 13 }}>{fmtDate(r.tr!.date)}</td>
                        <td data-label={t('finance.col.type')}><span className="badge badge-info">{t('finance.tr.one')}</span></td>
                        <td data-label={t('finance.recent.what')}><div style={{ fontWeight: 600 }}>{t('finance.tr.one')}</div>{r.tr!.comment && <div className="fin-muted-line">{r.tr!.comment}</div>}</td>
                        <td data-label={t('finance.acc.field')} style={{ fontSize: 13 }}>{r.tr!.fromAccount.name} → {r.tr!.toAccount.name}</td>
                        <td data-label={t('finance.recent.who')}>—</td>
                        <td data-label={t('finance.col.amount')} className="fin-money" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtMoney(r.tr!.amount, r.tr!.fromAccount.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <FinanceDetails kind={detail} range={range} periodLabel={periodLabel(range, t)} overview={overview} onClose={() => setDetail(null)} />

      <AnimatePresence>
        {formType && (
          <TransactionForm
            preselect={preselectedStudent}
            canExpense={canExpense}
            initialType={formType}
            onClose={() => { setFormType(null); setPreselectedStudent(null); }}
            onCreated={() => {
              setFormType(null);
              setPreselectedStudent(null);
              qc.invalidateQueries({ queryKey: keys.finance.all });
              qc.invalidateQueries({ queryKey: keys.payments.all });
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showTransfer && <TransferForm onClose={() => setShowTransfer(false)} onDone={() => setShowTransfer(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {openTx && (
          <TransactionDetailModal
            key={openTx.id}
            tx={openTx}
            canEdit={canEditTx}
            onClose={() => setOpenTx(null)}
            onEdit={(tx) => { setOpenTx(null); setEditing(tx); }}
            onDelete={(tx) => { setOpenTx(null); setTimeout(() => canDeleteTx && onDeleteTx(tx), 0); }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {editing && (
          <TransactionForm
            key={`edit-${editing.id}`}
            preselect={null}
            canExpense={canExpense}
            editTx={editing}
            onClose={() => setEditing(null)}
            onCreated={() => { setEditing(null); qc.invalidateQueries({ queryKey: keys.finance.all }); }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {openTransfer && (
          <TransferDetailModal key={openTransfer.id} tr={openTransfer} canReverse={canDeleteTx} onClose={() => setOpenTransfer(null)} />
        )}
      </AnimatePresence>
    </>
  );
}

// ───────────────────────── Деньги на счетах ─────────────────────────

function AccountsStrip({ data, loading, error, canManage }: {
  data?: import('../api/finance').AccountsResponse;
  loading: boolean;
  error: boolean;
  canManage: boolean;
}) {
  const { t } = useT();
  if (error) return null;
  const accounts = (data?.accounts ?? []).filter((a) => !a.archived);
  const totals = Object.entries(data?.totals ?? {});
  const unassigned = data?.unassigned?.count ?? 0;
  if (loading) {
    return (
      <section className="fin-accounts" aria-busy="true">
        <div className="fin-acc-grid">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="fin-acc-card is-skeleton" />)}
        </div>
      </section>
    );
  }
  if (accounts.length === 0) {
    return (
      <section className="fin-card fin-acc-empty" data-testid="fin-accounts-empty">
        <Icon name="account_balance" size={28} />
        <div>
          <h2 className="fin-card-title">{t('finance.acc.emptyTitle')}</h2>
          <p className="fin-muted-line">{t('finance.acc.emptyText')}</p>
        </div>
        {canManage && <Link to="/finance/settings" className="btn btn-primary" data-testid="fin-accounts-setup">{t('finance.acc.setup')}</Link>}
      </section>
    );
  }
  return (
    <section className="fin-accounts" aria-label={t('finance.acc.title')} data-testid="fin-accounts">
      <div className="fin-acc-head">
        <h2 className="fin-card-title">{t('finance.acc.title')}</h2>
        <span className="fin-card-note">
          {t('finance.acc.total')}{' '}
          {totals.map(([cur, v], i) => (
            <span key={cur}>{i > 0 && ` ${t('finance.acc.and')} `}<b className="fin-num">{fmtMoney(v, cur)}</b></span>
          ))}
          {' · '}{t('finance.acc.now')}
          {data?.balanceSince && (
            <span data-testid="fin-accounts-since">{' · '}{t('finance.since.short').replace('{date}', fmtDate(data.balanceSince))}</span>
          )}
        </span>
      </div>
      <div className="fin-acc-grid">
        {accounts.map((a) => (
          <div key={a.id} className="fin-acc-card" data-testid={`fin-acc-${a.id}`}>
            <div className="fin-acc-top">
              <AccountMark account={a} size={30} />
              <span className="fin-acc-name">{a.name}</span>
              <span className="fin-cur-chip">{a.currency}</span>
            </div>
            <span className={`fin-acc-balance${a.balance < 0 ? ' is-out' : ''}`} data-testid="fin-acc-balance">{fmtMoney(a.balance, a.currency)}</span>
          </div>
        ))}
      </div>
      {unassigned > 0 && (
        <Link to="/finance/settings" className="fin-warn-line" data-testid="fin-unassigned">
          <Icon name="info" size={18} />
          {t('finance.acc.unassigned').replace('{n}', String(unassigned))}
        </Link>
      )}
    </section>
  );
}

// ───────────────────────── Карточки месяца ─────────────────────────

function nonTjsList(overview: import('../api/finance').FinanceOverview | null, kind: 'income' | 'expense'): string[] {
  return Object.entries(overview?.nonTjsTotals || {})
    .filter(([, b]) => b[kind] > 0)
    .map(([c, b]) => fmtMoney(b[kind], c));
}

function MonthIncomeCard({ overview, allTime, transactions, periodText, onOpen }: {
  overview: import('../api/finance').FinanceOverview | null;
  allTime?: number;
  /** Операции месяца — доход по продуктам считаем по ним (в сомони, как итог карточки). */
  transactions?: Transaction[];
  periodText: string;
  onOpen: () => void;
}) {
  const { t } = useT();
  const cur = overview?.currency || 'TJS';
  const sums: Record<string, number> = { CONTRACT: 0, ACADEMY: 0, MASTERCLASS: 0, OTHER: 0 };
  for (const tx of transactions ?? []) {
    if (tx.type !== 'INCOME' || tx.currency !== cur) continue;
    // Без продукта: оплата по сделке — контракт, остальное — «Прочее».
    const k = tx.productCategoryEnum ?? (tx.category === 'TUITION_PAYMENT' ? 'CONTRACT' : 'OTHER');
    sums[k] = (sums[k] ?? 0) + tx.amount;
  }
  const rows = PRODUCT_ORDER.map((k) => ({ k, amount: sums[k] ?? 0 }));
  const usd = nonTjsList(overview, 'income');
  return (
    <section className="fin-card fin-mcard" data-testid="kpi-revenue">
      <div className="fin-card-head">
        <h2 className="fin-card-title">{t('finance.month.income')}</h2>
        <button type="button" className="fin-link" onClick={onOpen} data-testid="kpi-revenue-open">{t('finance.month.details')}</button>
      </div>
      <div className="fin-big is-in" data-testid="kpi-revenue-value">{overview ? fmtMoney(overview.totalIncome, cur) : '—'}</div>
      <div className="fin-muted-line">{periodText}{usd.length > 0 && <> · {t('finance.kpi.alsoCurrencies').replace('{list}', usd.join(', '))}</>}</div>
      <ul className="fin-rows">
        {rows.map((r) => (
          <li key={r.k} className="fin-row">
            <span className="fin-dot" style={{ background: PRODUCT_COLOR[r.k] }} aria-hidden="true" />
            <span className="fin-row-label">{t(`finance.productEnum.${r.k}`)}</span>
            <b className="fin-num">{fmtMoney(r.amount, cur)}</b>
          </li>
        ))}
      </ul>
      <div className="fin-card-foot">
        <span>{t('finance.month.allTimeIncome')}</span>
        <b className="fin-num is-in">{allTime != null ? fmtMoney(allTime, cur) : '—'}</b>
      </div>
    </section>
  );
}

function MonthExpenseCard({ overview, allTime, categories, catLabel, onOpenSalary, onOpenOther }: {
  overview: import('../api/finance').FinanceOverview | null;
  allTime?: number;
  categories?: Array<{ type: string; category: string; amount: number; count: number }>;
  catLabel: (c: string) => string;
  onOpenSalary: () => void;
  onOpenOther: () => void;
}) {
  const { t } = useT();
  const cur = overview?.currency || 'TJS';
  const rows = (categories ?? []).filter((c) => c.type === 'EXPENSE' && c.amount > 0).sort((a, b) => b.amount - a.amount);
  const top = rows.slice(0, 5);
  const restSum = rows.slice(5).reduce((s, r) => s + r.amount, 0);
  const usd = nonTjsList(overview, 'expense');
  return (
    <section className="fin-card fin-mcard" data-testid="kpi-total-expense">
      <div className="fin-card-head">
        <h2 className="fin-card-title">{t('finance.month.expense')}</h2>
        <span className="fin-card-note">{t('finance.month.byCategory')}</span>
      </div>
      <div className="fin-big is-out" data-testid="kpi-total-expense-value">{overview ? fmtMoney(overview.totalExpense, cur) : '—'}</div>
      {usd.length > 0 && <div className="fin-muted-line">{t('finance.kpi.alsoCurrencies').replace('{list}', usd.join(', '))}</div>}
      {top.length === 0 ? (
        <p className="fin-empty-line">{t('finance.month.noExpense')}</p>
      ) : (
        <ul className="fin-rows">
          {top.map((r) => (
            <li key={r.category} className="fin-row">
              <span className="fin-dot" style={{ background: EXPENSE_COLOR[r.category] || '#64748B' }} aria-hidden="true" />
              <span className="fin-row-label">{catLabel(r.category)}</span>
              <b className="fin-num">{fmtMoney(r.amount, cur)}</b>
            </li>
          ))}
          {restSum > 0 && (
            <li className="fin-row">
              <span className="fin-dot" style={{ background: '#94A3B8' }} aria-hidden="true" />
              <span className="fin-row-label">{t('finance.month.restCats')}</span>
              <b className="fin-num">{fmtMoney(restSum, cur)}</b>
            </li>
          )}
        </ul>
      )}
      <div className="fin-card-foot">
        <span>{t('finance.month.allTimeExpense')}</span>
        <b className="fin-num is-out">{allTime != null ? fmtMoney(allTime, cur) : '—'}</b>
      </div>
      <div className="fin-card-links">
        <button type="button" className="fin-link" onClick={onOpenSalary}>{t('finance.kpi.salary')} →</button>
        <button type="button" className="fin-link" onClick={onOpenOther}>{t('finance.kpi.expenses')} →</button>
      </div>
    </section>
  );
}

function MonthResultCard({ overview, onOpen }: { overview: import('../api/finance').FinanceOverview | null; onOpen: () => void }) {
  const { t } = useT();
  const cur = overview?.currency || 'TJS';
  const inc = overview?.totalIncome ?? 0;
  const exp = overview?.totalExpense ?? 0;
  const profit = overview?.netProfit ?? 0;
  const max = Math.max(inc, exp, 1);
  const pct = inc > 0 ? Math.round((exp / inc) * 100) : null;
  const note = !overview ? '' : inc === 0 && exp === 0
    ? t('finance.month.noOps')
    : inc <= 0
      ? t('finance.month.noIncome')
      : exp > inc
        ? t('finance.month.over').replace('{sum}', fmtMoney(exp - inc, cur))
        : t('finance.month.share').replace('{n}', String(pct));
  const hasForeign = Object.keys(overview?.nonTjsTotals || {}).length > 0;
  return (
    <section className="fin-card fin-mcard fin-result" data-testid="kpi-profit">
      <div className="fin-card-head">
        <h2 className="fin-card-title">{t('finance.month.result')}</h2>
        <button type="button" className="fin-link" onClick={onOpen} data-testid="kpi-profit-open">{t('finance.month.details')}</button>
      </div>
      <div className={`fin-big ${profit >= 0 ? 'is-in' : 'is-out'}`} data-testid="kpi-profit-value">{overview ? fmtMoney(profit, cur) : '—'}</div>
      <div className="fin-muted-line">{profit >= 0 ? t('finance.month.profit') : t('finance.month.loss')} · {note}</div>
      <div className="fin-bars">
        <div className="fin-bar-row">
          <span>{t('finance.income')}</span><b className="fin-num">{fmtMoney(inc, cur)}</b>
          <span className="fin-bar"><span style={{ width: `${Math.max(inc > 0 ? 3 : 0, (inc / max) * 100)}%`, background: '#16A34A' }} /></span>
        </div>
        <div className="fin-bar-row">
          <span>{t('finance.expense')}</span><b className="fin-num">{fmtMoney(exp, cur)}</b>
          <span className="fin-bar"><span style={{ width: `${Math.max(exp > 0 ? 3 : 0, (exp / max) * 100)}%`, background: '#DC2626' }} /></span>
        </div>
      </div>
      {overview && (
        <p className="fin-formula">
          {t('finance.kpi.profitFormula').replace('{salary}', fmtMoney(overview.salaryExpense, cur)).replace('{other}', fmtMoney(overview.otherExpense, cur))}
        </p>
      )}
      {hasForeign && <p className="fin-note-box">{t('finance.month.foreignNote')}</p>}
    </section>
  );
}

function QuickCards({ overview, debts, onOpen }: {
  overview: import('../api/finance').FinanceOverview | null;
  debts: any[];
  onOpen: (k: FinanceDetailKind) => void;
}) {
  const { t } = useT();
  const cur = overview?.currency || 'TJS';
  // Долги: суммы по валютам; главная — в валюте отчётов, иначе в той, где долг есть.
  const byCur: Record<string, number> = {};
  let noAmount = 0;
  for (const a of debts) {
    if (a.debt?.amount == null) { noAmount++; continue; }
    const c = a.debt.currency || cur;
    byCur[c] = (byCur[c] || 0) + Number(a.debt.amount);
  }
  const list = Object.entries(byCur).filter(([, v]) => v > 0);
  const main = list.find(([c]) => c === cur) ?? list[0] ?? [cur, 0];
  const other = list.filter(([c]) => c !== main[0]);
  const card = (k: FinanceDetailKind, icon: string, title: string, value: string, sub: React.ReactNode, tone = '') => (
    <button type="button" className="fin-qcard" onClick={() => onOpen(k)} data-testid={`kpi-${k}`}>
      <span className="fin-qcard-head"><span>{title}</span><Icon name={icon} size={18} /></span>
      <span className={`fin-qcard-value ${tone}`} data-testid={`kpi-${k}-value`}>{value}</span>
      <span className="fin-qcard-sub">{sub}</span>
    </button>
  );
  return (
    <div className="fin-qcards">
      {card('salary', 'groups', t('finance.kpi.salary'), overview ? fmtMoney(overview.salaryExpense, cur) : '—',
        overview && overview.salaryAccruedUnpaid > 0 ? t('finance.kpi.salaryUnpaid').replace('{sum}', fmtMoney(overview.salaryAccruedUnpaid, cur)) : t('finance.kpi.salaryHint'))}
      {card('expenses', 'south_east', t('finance.kpi.expenses'), overview ? fmtMoney(overview.otherExpense, cur) : '—', t('finance.kpi.expensesHint'), 'is-out')}
      {card('avg', 'receipt_long', t('finance.kpi.avgCheck'), overview ? fmtMoney(overview.avgCheck, cur) : '—',
        t('finance.kpi.avgCheckHint').replace('{n}', String(overview?.incomeCount ?? 0)))}
      {card('debts', 'hourglass_top', t('finance.kpi.debts'),
        list.length === 0 && noAmount > 0 ? t('finance.debt.noAmount') : fmtMoney(Number(main[1]), String(main[0])),
        <>
          {t('finance.kpi.debtsHint').replace('{n}', String(debts.length))}
          {other.map(([c, v]) => <span key={c}> · + {fmtMoney(v, c)}</span>)}
          {noAmount > 0 && list.length > 0 && <span> · {t('finance.debt.someNoAmount').replace('{n}', String(noAmount))}</span>}
        </>)}
    </div>
  );
}

// ───────────────────────── Денежный поток за 12 месяцев ─────────────────────────

function CashFlow({ data, ym, loading, onPick }: {
  data?: Array<{ key: string; income: number; expense: number; profit: number }>;
  ym: string;
  loading: boolean;
  onPick: (ym: string) => void;
}) {
  const { t } = useT();
  const months = Array.from({ length: 12 }, (_, i) => shiftYm(ym, i - 11));
  const byKey = new Map((data ?? []).map((p) => [p.key.slice(0, 7), p]));
  const series = months.map((m) => ({ ym: m, income: byKey.get(m)?.income ?? 0, expense: byKey.get(m)?.expense ?? 0 }));
  const max = Math.max(1, ...series.map((s) => Math.max(s.income, s.expense)));
  const totInc = series.reduce((s, x) => s + x.income, 0);
  const totExp = series.reduce((s, x) => s + x.expense, 0);
  const empty = !loading && totInc === 0 && totExp === 0;
  return (
    <section className="fin-card fin-flow" data-testid="fin-flow">
      <div className="fin-card-head">
        <div>
          <h2 className="fin-card-title">{t('finance.flow.title')}</h2>
          <span className="fin-card-note">{t('finance.flow.note')}</span>
        </div>
        <div className="fin-flow-totals">
          <span>{t('finance.income')} <b className="fin-num is-in">{fmtMoney(totInc)}</b></span>
          <span>{t('finance.expense')} <b className="fin-num is-out">{fmtMoney(totExp)}</b></span>
          <span>{t('finance.month.result')} <b className="fin-num">{fmtMoney(totInc - totExp)}</b></span>
        </div>
      </div>
      {empty ? (
        <p className="fin-empty-line">{t('finance.flow.empty')}</p>
      ) : (
        <div className="fin-flow-chart" role="img" aria-label={`${t('finance.flow.title')}: ${t('finance.income')} ${fmtMoney(totInc)}, ${t('finance.expense')} ${fmtMoney(totExp)}`}>
          {series.map((s, i) => (
            <button
              key={s.ym}
              type="button"
              className={`fin-flow-col${s.ym === ym ? ' is-current' : ''}${(11 - i) % 2 === 1 ? ' is-skip' : ''}`}
              onClick={() => onPick(s.ym)}
              title={`${monthLabel(s.ym)} · ${t('finance.income')} ${fmtMoney(s.income)} · ${t('finance.expense')} ${fmtMoney(s.expense)}`}
              aria-label={`${monthLabel(s.ym)}: ${t('finance.income')} ${fmtMoney(s.income)}, ${t('finance.expense')} ${fmtMoney(s.expense)}`}
            >
              <span className="fin-flow-bars">
                <span className="fin-flow-in" style={{ height: `${(s.income / max) * 100}%` }} />
                <span className="fin-flow-out" style={{ height: `${(s.expense / max) * 100}%` }} />
              </span>
              <span className="fin-flow-label">{monthLabel(s.ym, 'short')}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
