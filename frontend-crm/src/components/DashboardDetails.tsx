import { AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { listApplications } from '../api/applications';
import { listStudents } from '../api/students';
import { listTransactions, pendingPayments, TRANSACTION_CATEGORY_LABEL, type Transaction } from '../api/finance';
import { isFinishedApplicationStatus, isNewLeadApplicationStatus, type Application, type Student } from '../api/types';
import { keys } from '../lib/queryKeys';
import { useT } from '../lib/i18n';
import { tjFormatDate } from '../lib/tjTime';
import { useApplicationStatusLabel, useCountryLabel, useDirectionLabel } from '../lib/labels';
import DetailsModal, { groupBy, type DetailsColumn } from './DetailsModal';

/**
 * Окна «подробнее» у карточек дашборда. Каждое берёт записи за ТОТ ЖЕ
 * период и сворачивает их ТЕМИ ЖЕ правилами, что и цифра на карточке, —
 * поэтому число в окне сходится с карточкой по построению:
 *  • заявки 01–03, 05 — тот же список заявок за период, разложенный теми же
 *    предикатами статусов (isNewLead / isFinished), что и byStatus карточек;
 *  • 04 «Активные клиенты» — оплатившие студенты за период со статусом
 *    ACTIVE (как students/stats);
 *  • 06–08 деньги — операции за период ТОЛЬКО в TJS и вместе с отменёнными
 *    парами: сводка /finance/summary считает ровно так;
 *  • 09 «Долги» — тот же список текущих должников.
 */
export type DashboardDetailKind =
  | 'total' | 'new' | 'pipeline' | 'active' | 'enrolled'
  | 'profit' | 'income' | 'expense' | 'debt';

const REPORTING_CURRENCY = 'TJS';

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

export default function DashboardDetails({
  kind,
  range,
  periodLabel,
  onClose,
}: {
  kind: DashboardDetailKind | null;
  range: { from?: string; to?: string };
  periodLabel: string;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {kind === 'total' || kind === 'new' || kind === 'pipeline' || kind === 'enrolled' ? (
        <ApplicationsDetails key={kind} kind={kind} range={range} periodLabel={periodLabel} onClose={onClose} />
      ) : kind === 'active' ? (
        <StudentsDetails key={kind} range={range} periodLabel={periodLabel} onClose={onClose} />
      ) : kind === 'profit' || kind === 'income' || kind === 'expense' ? (
        <MoneyDetails key={kind} kind={kind} range={range} periodLabel={periodLabel} onClose={onClose} />
      ) : kind === 'debt' ? (
        <DebtDetails key={kind} onClose={onClose} />
      ) : null}
    </AnimatePresence>
  );
}

/** Ссылка в раздел с тем же периодом (как у строк разрезов на дашборде). */
function withRange(path: string, params: Record<string, string>, range: { from?: string; to?: string }) {
  const q = new URLSearchParams(params);
  if (range.from) q.set('from', range.from);
  if (range.to) q.set('to', range.to);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

function ApplicationsDetails({
  kind,
  range,
  periodLabel,
  onClose,
}: {
  kind: 'total' | 'new' | 'pipeline' | 'enrolled';
  range: { from?: string; to?: string };
  periodLabel: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const statusLabel = useApplicationStatusLabel();
  const countryLabel = useCountryLabel();
  const filters = { from: range.from || undefined, to: range.to || undefined };
  const query = useQuery({
    queryKey: keys.applications.list(filters),
    queryFn: () => listApplications(filters),
  });
  const pred: (s: string) => boolean =
    kind === 'new' ? isNewLeadApplicationStatus
      : kind === 'enrolled' ? isFinishedApplicationStatus
        : kind === 'pipeline' ? (s) => !isNewLeadApplicationStatus(s) && !isFinishedApplicationStatus(s)
          : () => true;
  const rows = query.data?.filter((a) => pred(a.status));
  const title = t(`dashboard.kpi.${kind === 'enrolled' ? 'enrolled' : kind === 'pipeline' ? 'pipeline' : kind}`);
  const managerOf = (a: Application) => a.manager?.fullName || t('details.noManager');
  const columns: DetailsColumn<Application>[] = [
    { key: 'fullName', label: t('app.field.fullName'), value: (a) => a.fullName, render: (a) => <strong>{a.fullName}</strong> },
    { key: 'phone', label: t('app.field.phone'), value: (a) => a.phone },
    { key: 'country', label: t('app.field.country'), value: (a) => (a.country ? countryLabel(a.country) : null) },
    { key: 'manager', label: t('app.field.manager'), value: (a) => a.manager?.fullName },
    { key: 'status', label: t('common.status'), value: (a) => statusLabel(a.status) },
    { key: 'createdAt', label: t('reports.col.date'), type: 'date', value: (a) => a.createdAt, render: (a) => tjFormatDate(a.createdAt) },
  ];
  const more = (n: number) => t('details.more').replace('{n}', String(n));
  const listParams: Record<string, string> =
    kind === 'new' ? { status: 'NEW_LEAD' } : kind === 'enrolled' ? { status: 'SUCCESSFUL_LEAD' } : {};
  return (
    <DetailsModal
      testId={`details-${kind}`}
      title={title}
      subtitle={periodLabel}
      groups={rows ? [
        { title: t('details.byManager'), items: groupBy(rows, managerOf, { more }) },
        ...(kind === 'total' || kind === 'pipeline'
          ? [{ title: t('details.byStatus'), items: groupBy(rows, (a) => statusLabel(a.status), { more }) }]
          : []),
        { title: t('details.byCountry'), items: groupBy(rows, (a) => (a.country ? countryLabel(a.country) : t('details.noValue')), { more }) },
      ] : undefined}
      rows={rows}
      loading={query.isLoading}
      error={query.isError}
      columns={columns}
      rowKey={(a) => a.id}
      rowHref={(a) => `/applications/${a.id}`}
      searchOf={(a) => [a.fullName, a.manager?.fullName]}
      phonesOf={(a) => [a.phone, a.whatsappPhone]}
      listHref={withRange('/applications', listParams, range)}
      emptyText={t('common.empty')}
      onClose={onClose}
    />
  );
}

function StudentsDetails({
  range,
  periodLabel,
  onClose,
}: {
  range: { from?: string; to?: string };
  periodLabel: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const directionLabel = useDirectionLabel();
  const filters = { paid: true, from: range.from || undefined, to: range.to || undefined };
  const query = useQuery({
    queryKey: keys.students.list(filters),
    queryFn: () => listStudents(filters),
  });
  const rows = query.data?.filter((s) => s.status === 'ACTIVE');
  const title = t('dashboard.kpi.active');
  const more = (n: number) => t('details.more').replace('{n}', String(n));
  const columns: DetailsColumn<Student>[] = [
    { key: 'fullName', label: t('app.field.fullName'), value: (s) => s.fullName, render: (s) => <strong>{s.fullName}</strong> },
    { key: 'phone', label: t('app.field.phone'), value: (s) => s.phones?.[0] },
    { key: 'direction', label: t('app.field.direction'), value: (s) => (s.directionConfirmed === false ? null : directionLabel(s.direction)) },
    { key: 'manager', label: t('app.field.manager'), value: (s) => s.manager?.fullName },
    { key: 'createdAt', label: t('reports.col.date'), type: 'date', value: (s) => s.createdAt, render: (s) => tjFormatDate(s.createdAt) },
  ];
  return (
    <DetailsModal
      testId="details-active"
      title={title}
      subtitle={periodLabel}
      groups={rows ? [
        { title: t('details.byManager'), items: groupBy(rows, (s) => s.manager?.fullName || t('details.noManager'), { more }) },
        { title: t('details.byDirection'), items: groupBy(rows, (s) => (s.directionConfirmed === false ? t('details.noValue') : directionLabel(s.direction)), { more }) },
      ] : undefined}
      rows={rows}
      loading={query.isLoading}
      error={query.isError}
      columns={columns}
      rowKey={(s) => s.id}
      rowHref={(s) => `/students/${s.id}`}
      searchOf={(s) => [s.fullName, s.manager?.fullName]}
      phonesOf={(s) => s.phones ?? []}
      listHref={withRange('/students', {}, range)}
      emptyText={t('common.empty')}
      onClose={onClose}
    />
  );
}

function MoneyDetails({
  kind,
  range,
  periodLabel,
  onClose,
}: {
  kind: 'profit' | 'income' | 'expense';
  range: { from?: string; to?: string };
  periodLabel: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const params = { from: range.from || undefined, to: range.to || undefined, take: 1000, includeReversed: true };
  const query = useQuery({
    queryKey: keys.finance.transactions({ ...params, details: true }),
    queryFn: () => listTransactions(params),
  });
  const all = query.data ?? [];
  const inKind = (tx: Transaction) =>
    kind === 'income' ? tx.type === 'INCOME' : kind === 'expense' ? tx.type === 'EXPENSE' : true;
  // Сводка карточек — только TJS; остальные валюты в сумму не входят.
  const rows = query.data ? all.filter((tx) => inKind(tx) && tx.currency === REPORTING_CURRENCY) : undefined;
  const otherCurrency = all.filter((tx) => inKind(tx) && tx.currency !== REPORTING_CURRENCY).length;
  const hasReversed = (rows ?? []).some((tx) => !!tx.reversedAt);
  const sum = (type: 'INCOME' | 'EXPENSE') =>
    (rows ?? []).filter((tx) => tx.type === type).reduce((s, tx) => s + Number(tx.amount), 0);
  const income = sum('INCOME');
  const expense = sum('EXPENSE');
  const categoryLabel = (tx: Transaction) => {
    const k = `finance.cat.${tx.category}`;
    return t(k) !== k ? t(k) : TRANSACTION_CATEGORY_LABEL[tx.category];
  };
  const title = kind === 'income' ? t('dashboard.finance.income') : kind === 'expense' ? t('dashboard.finance.expense') : t('dashboard.finance.netProfit');
  // Сумма «Дохода»/«Расхода» уже на карточке; у «Прибыли» — показываем, из чего она.
  const summary = kind === 'profit'
    ? [
        { label: t('dashboard.finance.income'), value: fmtMoney(income) },
        { label: t('dashboard.finance.expense'), value: fmtMoney(expense) },
        { label: t('dashboard.finance.netProfit'), value: fmtMoney(income - expense) },
      ]
    : undefined;
  const signed = (tx: Transaction) => (tx.type === 'INCOME' ? 1 : -1) * Number(tx.amount);
  const columns: DetailsColumn<Transaction>[] = [
    { key: 'date', label: t('finance.col.date'), type: 'date', value: (tx) => tx.date, render: (tx) => tjFormatDate(tx.date) },
    ...(kind === 'profit'
      ? [{ key: 'type', label: t('finance.col.type'), value: (tx: Transaction) => (tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')) }]
      : []),
    { key: 'category', label: t('finance.col.category'), value: categoryLabel },
    {
      key: 'amount',
      label: t('finance.col.amount'),
      type: 'number',
      align: 'right',
      value: (tx) => Number(tx.amount),
      render: (tx) => (
        <span className={tx.reversedAt ? 'details-reversed' : undefined} style={{ fontWeight: 600, whiteSpace: 'nowrap', color: tx.reversedAt ? undefined : signed(tx) >= 0 ? 'var(--primary-dark)' : 'var(--danger)' }}>
          {signed(tx) >= 0 ? '+' : '−'} {fmtMoney(Number(tx.amount), tx.currency)}
          {tx.reversedAt && <span style={{ marginLeft: 6, fontSize: 11 }}>({t('details.reversed')})</span>}
        </span>
      ),
    },
    { key: 'who', label: t('finance.col.student'), value: (tx) => tx.student?.fullName || tx.manager?.fullName || tx.payerName },
    { key: 'comment', label: t('finance.col.comment'), value: (tx) => tx.comment },
  ];
  return (
    <DetailsModal
      testId={`details-${kind}`}
      title={title}
      subtitle={periodLabel}
      summary={summary}
      groups={rows ? [{
        title: t('details.byCategory'),
        items: groupBy(rows, categoryLabel, {
          sum: (tx) => (kind === 'profit' ? signed(tx) : Number(tx.amount)),
          format: (n) => fmtMoney(n),
          more: (n) => t('details.more').replace('{n}', String(n)),
        }),
      }] : undefined}
      note={
        (hasReversed || otherCurrency > 0) ? (
          <>
            {hasReversed && <div>{t('details.reversedHint')}</div>}
            {otherCurrency > 0 && <div>{t('details.otherCurrency').replace('{n}', String(otherCurrency))}</div>}
          </>
        ) : undefined
      }
      rows={rows}
      loading={query.isLoading}
      error={query.isError}
      columns={columns}
      rowKey={(tx) => tx.id}
      searchOf={(tx) => [tx.student?.fullName, tx.manager?.fullName, tx.payerName, tx.comment, categoryLabel(tx)]}
      listHref={withRange('/finance', {}, range)}
      emptyText={t('common.empty')}
      onClose={onClose}
    />
  );
}

function DebtDetails({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const query = useQuery<any[]>({
    queryKey: keys.finance.pending(),
    queryFn: () => pendingPayments(),
  });
  const rows = query.data;
  const title = t('dashboard.finance.debtNow');
  const more = (n: number) => t('details.more').replace('{n}', String(n));
  const columns: DetailsColumn<any>[] = [
    { key: 'fullName', label: t('finance.col.student'), value: (a) => a.fullName, render: (a) => <strong>{a.fullName}</strong> },
    { key: 'program', label: t('sidebar.programs'), value: (a) => a.program?.name },
    {
      key: 'amount',
      label: t('common.amount'),
      type: 'number',
      align: 'right',
      value: (a) => (a.program ? Number(a.program.cost) : null),
      render: (a) => (a.program ? fmtMoney(Number(a.program.cost), a.program.currency || 'TJS') : null),
    },
    { key: 'manager', label: t('finance.col.manager'), value: (a) => a.manager?.fullName },
  ];
  return (
    <DetailsModal
      testId="details-debt"
      title={title}
      groups={rows ? [{ title: t('details.byManager'), items: groupBy(rows, (a) => a.manager?.fullName || t('details.noManager'), { more }) }] : undefined}
      rows={rows}
      loading={query.isLoading}
      error={query.isError}
      columns={columns}
      rowKey={(a) => a.id}
      rowHref={(a) => `/applications/${a.id}`}
      searchOf={(a) => [a.fullName, a.program?.name, a.manager?.fullName]}
      listHref="/finance"
      emptyText={t('finance.outstanding.empty')}
      onClose={onClose}
    />
  );
}
