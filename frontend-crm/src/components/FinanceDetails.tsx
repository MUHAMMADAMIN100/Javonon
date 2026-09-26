import { AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  listTransactions,
  pendingPayments,
  TRANSACTION_CATEGORY_LABEL,
  type FinanceOverview,
  type Transaction,
} from '../api/finance';
import { keys } from '../lib/queryKeys';
import { useT } from '../lib/i18n';
import { tjFormatDate } from '../lib/tjTime';
import DetailsModal, { groupBy, type DetailsColumn, type DetailsGroup } from './DetailsModal';
import { withDismissed } from './DismissedMark';

/**
 * Окна карточек «Финансов» (выручка, прибыль, зарплата, прочие расходы,
 * средний чек, долги). Каждое берёт операции за ТОТ ЖЕ период и делит их
 * ТЕМИ ЖЕ правилами, что /finance/overview: только TJS, без удалённых;
 * зарплата — расходы категории «Зарплата», прочие — остальные расходы.
 * Поэтому итог в окне сходится с карточкой по построению. Разбивки здесь
 * заменяют бывшие круговые диаграммы страницы.
 */
export type FinanceDetailKind = 'revenue' | 'profit' | 'salary' | 'expenses' | 'avg' | 'debts';

const REPORTING_CURRENCY = 'TJS';

function fmtMoney(n: number, c = REPORTING_CURRENCY) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

export default function FinanceDetails({
  kind,
  range,
  periodLabel,
  overview,
  onClose,
}: {
  kind: FinanceDetailKind | null;
  range: { from?: string; to?: string };
  periodLabel: string;
  overview: FinanceOverview | null;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {kind === 'debts' ? (
        <DebtsDetails key={kind} onClose={onClose} />
      ) : kind ? (
        <MoneyDetails key={kind} kind={kind} range={range} periodLabel={periodLabel} overview={overview} onClose={onClose} />
      ) : null}
    </AnimatePresence>
  );
}

function MoneyDetails({
  kind,
  range,
  periodLabel,
  overview,
  onClose,
}: {
  kind: Exclude<FinanceDetailKind, 'debts'>;
  range: { from?: string; to?: string };
  periodLabel: string;
  overview: FinanceOverview | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const params = { from: range.from || undefined, to: range.to || undefined, take: 1000 };
  const query = useQuery({
    queryKey: keys.finance.transactions({ ...params, details: true }),
    queryFn: () => listTransactions(params),
  });
  const all = query.data ?? [];
  const isSalary = (tx: Transaction) => tx.type === 'EXPENSE' && tx.category === 'SALARY';
  const inKind = (tx: Transaction) => {
    if (kind === 'revenue' || kind === 'avg') return tx.type === 'INCOME';
    if (kind === 'salary') return isSalary(tx);
    if (kind === 'expenses') return tx.type === 'EXPENSE' && !isSalary(tx);
    return true; // прибыль — все операции
  };
  // Карточки считают только TJS; остальные валюты — отдельной строкой.
  const rows = query.data ? all.filter((tx) => inKind(tx) && tx.currency === REPORTING_CURRENCY) : undefined;
  const otherCurrency = all.filter((tx) => inKind(tx) && tx.currency !== REPORTING_CURRENCY).length;
  const sumOf = (list: Transaction[]) => list.reduce((s, tx) => s + Number(tx.amount), 0);
  const list = rows ?? [];
  const income = sumOf(list.filter((tx) => tx.type === 'INCOME'));
  const salary = sumOf(list.filter(isSalary));
  const other = sumOf(list.filter((tx) => tx.type === 'EXPENSE' && !isSalary(tx)));

  const categoryLabel = (tx: Transaction) => {
    const k = `finance.cat.${tx.category}`;
    return t(k) !== k ? t(k) : TRANSACTION_CATEGORY_LABEL[tx.category];
  };
  const sourceLabel = (tx: Transaction) => {
    if (!tx.incomeSource) return t('details.noValue');
    const k = `finance.source.${tx.incomeSource}`;
    return t(k) !== k ? t(k) : String(tx.incomeSource);
  };
  const managerLabel = (tx: Transaction) => (tx.manager ? withDismissed(tx.manager.fullName, tx.manager, t('users.dismissed')) : t('details.noManager'));
  const more = (n: number) => t('details.more').replace('{n}', String(n));
  const money = (n: number) => fmtMoney(n);
  const signed = (tx: Transaction) => (tx.type === 'INCOME' ? 1 : -1) * Number(tx.amount);

  const title = t(`finance.kpi.${kind === 'revenue' ? 'revenue' : kind === 'avg' ? 'avgCheck' : kind}`);

  // Итог под заголовком — только то, чего нет на самой карточке.
  let summary: { label: string; value: string }[] | undefined;
  let groups: DetailsGroup[] | undefined;
  if (rows) {
    if (kind === 'revenue') {
      summary = [{ label: t('finance.details.receipts'), value: String(list.length) }];
      groups = [
        { title: t('finance.details.bySource'), items: groupBy(list, sourceLabel, { sum: (tx) => Number(tx.amount), format: money, more }) },
        { title: t('details.byManager'), items: groupBy(list, managerLabel, { sum: (tx) => Number(tx.amount), format: money, more }) },
      ];
    } else if (kind === 'profit') {
      summary = [
        { label: t('finance.kpi.revenue'), value: money(income) },
        { label: t('finance.kpi.salary'), value: `− ${money(salary)}` },
        { label: t('finance.kpi.expenses'), value: `− ${money(other)}` },
        { label: t('finance.kpi.profit'), value: money(income - salary - other) },
      ];
      groups = [{
        title: t('details.byCategory'),
        items: groupBy(list, categoryLabel, { sum: signed, format: money, more }),
      }];
    } else if (kind === 'salary') {
      summary = [
        { label: t('finance.details.payouts'), value: String(list.length) },
        ...(overview && overview.salaryAccruedUnpaid > 0
          ? [{ label: t('finance.details.unpaid'), value: money(overview.salaryAccruedUnpaid) }]
          : []),
      ];
      groups = [{ title: t('finance.details.byEmployee'), items: groupBy(list, managerLabel, { sum: (tx) => Number(tx.amount), format: money, more }) }];
    } else if (kind === 'expenses') {
      summary = [{ label: t('finance.details.operations'), value: String(list.length) }];
      groups = [{ title: t('details.byCategory'), items: groupBy(list, categoryLabel, { sum: (tx) => Number(tx.amount), format: money, more }) }];
    } else if (kind === 'avg') {
      summary = [
        { label: t('finance.details.receipts'), value: String(list.length) },
        { label: t('finance.kpi.revenue'), value: money(income) },
      ];
      // Средний чек каждого менеджера: сумма ÷ его поступления.
      const byManager = new Map<string, { sum: number; n: number }>();
      for (const tx of list) {
        const k = managerLabel(tx);
        const cur = byManager.get(k) ?? { sum: 0, n: 0 };
        byManager.set(k, { sum: cur.sum + Number(tx.amount), n: cur.n + 1 });
      }
      groups = [{
        title: t('finance.details.avgByManager'),
        items: [...byManager.entries()]
          .sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)
          .slice(0, 8)
          .map(([label, v]) => ({ label: `${label} · ${v.n}`, value: money(v.sum / v.n) })),
      }];
    }
  }

  const columns: DetailsColumn<Transaction>[] = [
    { key: 'date', label: t('finance.col.date'), type: 'date', value: (tx) => tx.date, render: (tx) => tjFormatDate(tx.date) },
    ...(kind === 'profit'
      ? [{ key: 'type', label: t('finance.col.type'), value: (tx: Transaction) => (tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')) }]
      : []),
    kind === 'revenue' || kind === 'avg'
      ? { key: 'source', label: t('finance.details.source'), value: sourceLabel }
      : { key: 'category', label: t('finance.col.category'), value: categoryLabel },
    {
      key: 'amount',
      label: t('finance.col.amount'),
      type: 'number',
      align: 'right',
      value: (tx) => Number(tx.amount),
      render: (tx) => (
        <span style={{ fontWeight: 600, whiteSpace: 'nowrap', color: signed(tx) >= 0 ? 'var(--primary-dark)' : 'var(--danger)' }}>
          {signed(tx) >= 0 ? '+' : '−'} {fmtMoney(Number(tx.amount), tx.currency)}
        </span>
      ),
    },
    {
      key: 'who',
      label: kind === 'salary' ? t('finance.details.employee') : t('finance.col.student'),
      value: (tx) => (kind === 'salary' ? tx.manager?.fullName : tx.student?.fullName || tx.manager?.fullName || tx.payerName),
    },
    { key: 'comment', label: t('finance.col.comment'), value: (tx) => tx.comment },
  ];

  return (
    <DetailsModal
      testId={`details-${kind}`}
      title={title}
      subtitle={periodLabel}
      summary={summary}
      groups={groups}
      note={otherCurrency > 0 ? t('details.otherCurrency').replace('{n}', String(otherCurrency)) : undefined}
      rows={rows}
      loading={query.isLoading}
      error={query.isError}
      columns={columns}
      rowKey={(tx) => tx.id}
      searchOf={(tx) => [tx.student?.fullName, tx.manager?.fullName, tx.payerName, tx.comment, categoryLabel(tx)]}
      listHref={kind === 'salary' ? '/salary' : undefined}
      emptyText={t('common.empty')}
      onClose={onClose}
    />
  );
}

/** Должники — тот же список, что раздел «Задолженность» (Application.paymentPending). */
function DebtsDetails({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const query = useQuery<any[]>({
    queryKey: keys.finance.pending(),
    queryFn: () => pendingPayments(),
  });
  const rows = query.data;
  const more = (n: number) => t('details.more').replace('{n}', String(n));
  // Сумма по валютам программ — одна строка на валюту.
  const byCur = new Map<string, number>();
  for (const a of rows ?? []) {
    if (!a.program) continue;
    const c = a.program.currency || REPORTING_CURRENCY;
    byCur.set(c, (byCur.get(c) ?? 0) + Number(a.program.cost || 0));
  }
  const summary = rows
    ? [
        { label: t('finance.details.debtors'), value: String(rows.length) },
        ...[...byCur.entries()].map(([c, v]) => ({ label: t('finance.details.debtSum').replace('{cur}', c), value: fmtMoney(v, c) })),
      ]
    : undefined;
  const columns: DetailsColumn<any>[] = [
    { key: 'fullName', label: t('finance.col.student'), value: (a) => a.fullName, render: (a) => <strong>{a.fullName}</strong> },
    { key: 'program', label: t('sidebar.programs'), value: (a) => a.program?.name },
    {
      key: 'amount',
      label: t('common.amount'),
      type: 'number',
      align: 'right',
      value: (a) => (a.program ? Number(a.program.cost) : null),
      render: (a) => (a.program ? fmtMoney(Number(a.program.cost), a.program.currency || REPORTING_CURRENCY) : '—'),
    },
    { key: 'manager', label: t('finance.col.manager'), value: (a) => a.manager?.fullName },
  ];
  return (
    <DetailsModal
      testId="details-debts"
      title={t('finance.kpi.debts')}
      subtitle={t('finance.details.now')}
      summary={summary}
      groups={rows ? [{ title: t('details.byManager'), items: groupBy(rows, (a) => (a.manager ? withDismissed(a.manager.fullName, a.manager, t('users.dismissed')) : t('details.noManager')), { more }) }] : undefined}
      rows={rows}
      loading={query.isLoading}
      error={query.isError}
      columns={columns}
      rowKey={(a) => a.id}
      rowHref={(a) => `/applications/${a.id}`}
      searchOf={(a) => [a.fullName, a.program?.name, a.manager?.fullName]}
      emptyText={t('finance.outstanding.empty')}
      onClose={onClose}
    />
  );
}
