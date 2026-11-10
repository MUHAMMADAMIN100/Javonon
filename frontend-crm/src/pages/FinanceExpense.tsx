import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import FinanceSubnav from '../components/finance/FinanceSubnav';
import { MonthNav, fmtMoney, monthLabel, useYmParam } from '../components/finance/financeShared';
import { EXPENSE_GROUP_META, useMonthIn } from '../components/finance/ExpenseShared';
import { getExpenseChart, getExpensePlan, getExpenseSummary, type ExpenseGroup, type ExpenseSummary } from '../api/finance';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { useRealtime } from '../realtime';

/**
 * «Финансы → Расход» (часть 2, макет утверждён 10.11.2026): пять статей за
 * месяц (карточка ведёт в статью), «Расход по месяцам» (прошлое — факт,
 * текущий — факт и что осталось, дальше — план) и «Что осталось оплатить» на
 * 3 / 6 / 12 месяцев вперёд.
 */

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
/** «53,5 тыс.» над столбиком; меньше тысячи — как есть. */
const fmtK = (n: number, k: string) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')} ${k}` : String(Math.round(n)));

export default function FinanceExpense() {
  const { t } = useT();
  const qc = useQueryClient();
  const [ym, setYm] = useYmParam();
  const [months, setMonths] = useState<3 | 6 | 12>(3);
  const sumQ = useQuery({ queryKey: keys.finance.expense('summary', ym), queryFn: () => getExpenseSummary(ym), placeholderData: keepPreviousData });
  const chartQ = useQuery({ queryKey: keys.finance.expense('chart', ym), queryFn: () => getExpenseChart(ym), placeholderData: keepPreviousData });
  const planQ = useQuery({ queryKey: keys.finance.expense('plan', months), queryFn: () => getExpensePlan(months), placeholderData: keepPreviousData });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      qc.invalidateQueries({ queryKey: keys.finance.all });
    }, 400);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useRealtime({
    'transaction:new': refresh,
    'transaction:updated': refresh,
    'transaction:deleted': refresh,
    'transaction:reversed': refresh,
    'finance:accounts': refresh,
  });

  return (
    <>
      <FinanceSubnav />
      <div className="fin-toolbar">
        <p className="fin-muted-line inc-lead">{t('finance.exp.lead')}</p>
        <MonthNav ym={ym} onChange={setYm} busy={sumQ.isFetching || chartQ.isFetching} />
      </div>
      {sumQ.isError ? (
        <div className="fin-card fin-block"><p className="fin-empty-line">{t('toast.error')}</p></div>
      ) : (
        <ExpenseCards data={sumQ.data} />
      )}
      <ExpenseChartCard data={chartQ.data} />
      <section className="fin-card fin-block" data-testid="exp-plan">
        <div className="fin-card-head">
          <div>
            <h2 className="fin-card-title">{t('finance.exp.planTitle').replace('{n}', t(`finance.exp.months.${months}`))}</h2>
            <p className="fin-muted-line">{t('finance.exp.planHint')}</p>
          </div>
          <div className="exp-segs" role="radiogroup" aria-label={t('finance.exp.planTitleShort')}>
            {([3, 6, 12] as const).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={months === n} className={months === n ? 'is-active' : ''} onClick={() => setMonths(n)} data-testid={`exp-seg-${n}`}>
                {t(`finance.exp.seg.${n}`)}
              </button>
            ))}
          </div>
        </div>
        <PlanTable months={months} data={planQ.data} />
      </section>
    </>
  );
}

function ExpenseCards({ data }: { data?: ExpenseSummary }) {
  const { t } = useT();
  const monthIn = useMonthIn();
  if (!data) {
    return (
      <section className="exp-cards fin-block" aria-busy="true">
        {EXPENSE_GROUP_META.map((g) => <div key={g.key} className="exp-card is-skeleton" />)}
      </section>
    );
  }
  const c = data.cards;
  const prevName = monthLabel(c.salary.forYm).split(' ')[0].toLowerCase();
  const card = (key: ExpenseGroup) => {
    const meta = EXPENSE_GROUP_META.find((g) => g.key === key)!;
    let value = 0;
    let sub = '';
    let bar: number | null = null;
    let note = '';
    let noteCls = '';
    if (key === 'salary') {
      value = c.salary.toPay > 0.005 ? c.salary.toPay : c.salary.paid;
      sub = c.salary.toPay > 0.005
        ? t('finance.exp.salarySub').replace('{month}', prevName).replace('{n}', String(c.salary.employees))
        : t('finance.exp.salaryPaidSub').replace('{month}', monthIn(data.ym));
      if (c.salary.employees) {
        bar = pct(c.salary.paidCount, c.salary.employees);
        note = t('finance.exp.paidOf').replace('{a}', String(c.salary.paidCount)).replace('{b}', String(c.salary.employees));
      }
    } else if (key === 'rent') {
      value = c.rent.toPay;
      sub = c.rent.count ? t('finance.exp.rentSub').replace('{month}', monthIn(data.ym)).replace('{n}', String(c.rent.count)) : t('finance.exp.rentNone');
      if (c.rent.count) {
        bar = pct(c.rent.paidCount, c.rent.count);
        note = t('finance.exp.paidOfRent').replace('{a}', String(c.rent.paidCount)).replace('{b}', String(c.rent.count));
      }
    } else if (key === 'partners') {
      value = c.partners.waiting;
      sub = t('finance.exp.partnersSub').replace('{n}', String(c.partners.partners));
      note = c.partners.requests ? t('finance.exp.requestsN').replace('{n}', String(c.partners.requests)) : t('finance.exp.requestsNone');
      noteCls = c.partners.requests ? 'is-warn' : '';
    } else if (key === 'debts') {
      value = c.debts.toPay;
      sub = c.debts.toPay > 0.005
        ? `${t('finance.exp.debtsSub').replace('{month}', monthIn(data.ym))}${c.debts.dueNames.length ? ` · ${c.debts.dueNames.join(', ')}` : ''}`
        : c.debts.paid > 0.005
          ? t('finance.exp.debtsPaid').replace('{month}', monthIn(data.ym)).replace('{sum}', fmtMoney(c.debts.paid))
          : t('finance.exp.debtsNothing').replace('{month}', monthIn(data.ym));
      note = c.debts.remaining > 0.005 ? t('finance.exp.debtsTotal').replace('{sum}', fmtMoney(c.debts.remaining)) : t('finance.exp.debtsNone');
      noteCls = c.debts.overdue > 0.005 ? 'is-bad' : '';
    } else {
      value = c.other.spent;
      sub = t('finance.exp.otherSub');
      note = (c.other.planSource === 'own' ? t('finance.exp.planOwn') : t('finance.exp.planAvg')).replace('{sum}', fmtMoney(c.other.plan));
    }
    return (
      <Link key={key} to={key === 'salary' ? `${meta.to}?ym=${c.salary.forYm}` : `${meta.to}?ym=${data.ym}`} className="exp-card" style={{ ['--grp' as any]: meta.color }} data-testid={`exp-card-${key}`}>
        <span className="exp-card-head">
          <span className="inc-dir-icon exp-icon" aria-hidden="true"><Icon name={meta.icon} size={20} /></span>
          {t(`finance.exp.g.${key}`)}
        </span>
        <span className="exp-card-value fin-num" data-testid={`exp-card-${key}-value`}>{fmtMoney(value)}</span>
        <span className="exp-card-sub">{sub}</span>
        {bar !== null && <span className="exp-bar" aria-hidden="true"><span style={{ width: `${bar}%` }} /></span>}
        {note && <span className={`exp-card-note ${noteCls}`}>{note}</span>}
        <span className="exp-card-open">{t('finance.exp.open')} →</span>
      </Link>
    );
  };
  return (
    <section className="exp-cards fin-block" aria-label={t('finance.exp.groups')}>
      {EXPENSE_GROUP_META.map((g) => card(g.key))}
    </section>
  );
}

function ExpenseChartCard({ data }: { data?: { ym: string; current: string; rows: Array<{ ym: string; kind: string; groups: Record<ExpenseGroup, number>; total: number }> } }) {
  const { t } = useT();
  const monthIn = useMonthIn();
  if (!data) return <section className="fin-card fin-block exp-chart is-skeleton" />;
  const max = Math.max(1, ...data.rows.map((r) => r.total));
  const sel = data.rows.find((r) => r.ym === data.ym);
  const biggest = sel ? EXPENSE_GROUP_META.map((g) => ({ g, v: sel.groups[g.key] })).sort((a, b) => b.v - a.v)[0] : null;
  const top = [...data.rows].sort((a, b) => b.total - a.total)[0];
  const legend = EXPENSE_GROUP_META.map((g) => ({ ...g, sum: data.rows.reduce((x, r) => x + r.groups[g.key], 0) }));
  return (
    <section className="fin-card fin-block exp-chart" data-testid="exp-chart">
      <div className="fin-card-head">
        <div>
          <h2 className="fin-card-title">{t('finance.exp.chartTitle')}</h2>
          <p className="fin-muted-line" data-testid="exp-chart-summary">
            {sel && sel.total > 0 && biggest
              ? t('finance.exp.chartSentence')
                  .replace('{month}', monthIn(data.ym))
                  .replace('{sum}', fmtMoney(sel.total))
                  .replace('{group}', t(`finance.exp.g.${biggest.g.key}`).toLowerCase())
                  .replace('{pct}', String(pct(biggest.v, sel.total)))
              : t('finance.exp.chartEmpty').replace('{month}', monthIn(data.ym))}
            {top && top.total > 0 ? ` ${t('finance.exp.chartTop').replace('{month}', monthLabel(top.ym).toLowerCase()).replace('{sum}', fmtMoney(top.total))}` : ''}
          </p>
        </div>
        <span className="fin-card-note">{t('finance.exp.chartRange').replace('{from}', monthLabel(data.rows[0].ym).toLowerCase()).replace('{to}', monthLabel(data.rows[data.rows.length - 1].ym).toLowerCase())}</span>
      </div>
      <div className="exp-bars" role="img" aria-label={t('finance.exp.chartTitle')}>
        {data.rows.map((r, i) => (
          <div
            key={r.ym}
            className={`exp-col is-${r.kind}${r.ym === data.ym ? ' is-selected' : ''}${i % 2 ? ' is-odd' : ''}`}
            title={`${monthLabel(r.ym)}: ${fmtMoney(r.total)}${r.kind === 'plan' ? ` (${t('finance.exp.plan')})` : ''}`}
            data-testid={`exp-col-${r.ym}`}
          >
            <span className="exp-col-total">{r.total > 0 ? fmtK(r.total, t('finance.exp.k')) : ''}</span>
            <span className="exp-stack" style={{ height: `${Math.round((r.total / max) * 100)}%` }}>
              {EXPENSE_GROUP_META.map((g) => (r.groups[g.key] > 0 ? <span key={g.key} style={{ flexGrow: r.groups[g.key], background: g.color }} /> : null))}
            </span>
            <span className="exp-col-label">{monthLabel(r.ym, 'short')}</span>
          </div>
        ))}
      </div>
      <div className="exp-legend">
        {legend.map((g) => (
          <span key={g.key}><i style={{ background: g.color }} />{t(`finance.exp.g.${g.key}`)} <b className="fin-num">{fmtMoney(g.sum)}</b></span>
        ))}
        <span className="exp-legend-note">{t('finance.exp.planLegend')}</span>
      </div>
    </section>
  );
}

function PlanTable({ months, data }: { months: number; data?: import('../api/finance').ExpensePlan }) {
  const { t } = useT();
  if (!data || data.months !== months) return <p className="fin-empty-line">{t('common.loading')}</p>;
  const rows = data.rows;
  const total = (g: ExpenseGroup) => rows.reduce((x, r) => x + r[g], 0);
  const colTotal = (r: (typeof rows)[number]) => EXPENSE_GROUP_META.reduce((x, g) => x + r[g.key], 0);
  return (
    <>
      <div className="fin-table-wrap">
        <table className="table exp-plan-table" data-testid="exp-plan-table">
          <thead>
            <tr>
              <th>{t('finance.exp.colGroup')}</th>
              {rows.map((r) => <th key={r.ym} style={{ textAlign: 'right' }}>{monthLabel(r.ym, 'short')}</th>)}
              <th style={{ textAlign: 'right' }}>{t(`finance.exp.forN.${months}`)}</th>
            </tr>
          </thead>
          <tbody>
            {EXPENSE_GROUP_META.map((g) => (
              <tr key={g.key} data-testid={`exp-plan-${g.key}`}>
                <td><span className="exp-dot" style={{ background: g.color }} />{t(`finance.exp.g.${g.key}`)}</td>
                {rows.map((r) => {
                  const est = g.key === 'other' && r.otherSource === 'avg' && r[g.key] > 0;
                  return (
                    <td key={r.ym} className={`fin-num${est ? ' exp-est' : ''}`} style={{ textAlign: 'right' }} title={est ? t('finance.exp.estHint') : undefined}>
                      {r[g.key] > 0 ? `${est ? '≈ ' : ''}${fmtMoney(r[g.key])}` : '—'}
                    </td>
                  );
                })}
                <td className="fin-num" style={{ textAlign: 'right', fontWeight: 700 }}>{fmtMoney(total(g.key))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{t('finance.exp.total')}</td>
              {rows.map((r) => <td key={r.ym} className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(colTotal(r))}</td>)}
              <td className="fin-num" style={{ textAlign: 'right' }} data-testid="exp-plan-total">{fmtMoney(rows.reduce((x, r) => x + colTotal(r), 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="fin-note-box">
        {t('finance.exp.planNote')
          .replace('{avg}', fmtMoney(data.average.avg))
          .replace('{range}', data.average.from ? `${monthLabel(data.average.from).toLowerCase()} — ${monthLabel(data.average.to!).toLowerCase()}` : t('finance.exp.noHistory'))}
      </p>
    </>
  );
}
