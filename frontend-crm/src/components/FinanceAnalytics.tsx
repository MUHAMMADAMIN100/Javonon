import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell,
} from 'recharts';
import Icon from '../Icon';
import { useT } from '../lib/i18n';
import { fmtDateText, tjToday } from '../lib/tjTime';
import { prevRangeOf, compareValues, type Delta } from '../lib/periodCompare';
import {
  financeSummary, financeTimeseries, financeBreakdown, financeIncomeByProduct, financeByChannel, financeDistribution,
  pendingPayments, TRANSACTION_CATEGORY_LABEL, PAYMENT_CHANNEL_LABEL, PRODUCT_CATEGORY_TEXT,
  type FinanceSummary, type TimeseriesPoint, type PaymentChannel,
} from '../api/finance';

/**
 * «Финансы → Аналитика» (редизайн 2026, макет утверждён 09.11.2026).
 *
 * Все графики — за период переключателя вверху страницы (тот же, что у
 * «Обзора и журнала»): доходы/расходы/прибыль во времени со сравнением с
 * прошлым периодом, структура расходов и доходов, способы оплаты, выручка и
 * долги по менеджерам, распределение прибыли по схеме и долги по срокам.
 * Деньги — в TJS (валюта отчётов), как и во всех агрегатах финансов.
 *
 * У каждого графика есть текстовая расшифровка (подписи, таблица) — цвет
 * никогда не единственный носитель смысла.
 */

type Range = { from?: string; to?: string };
type Bucket = 'day' | 'week' | 'month';

const C = {
  income: '#01368B',
  expense: '#F0A35A',
  profit: '#0A0D1A',
  grid: '#E4E9F1',
  axis: '#5B6478',
};
const PALETTE = ['#01368B', '#1E5BB8', '#5A8BD6', '#A9C3EC', '#5B6478', '#C9D9F2', '#0A0D1A'];
const DEBT_SCALE = ['#E9B886', '#F0A35A', '#D9772B', '#9A4A0C'];

const money = (n: number) => Math.round(n).toLocaleString('ru-RU');
const moneyShort = (n: number, tThousand: string, tMillion: string) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${tMillion}`;
  if (a >= 1_000) return `${Math.round(n / 1_000).toLocaleString('ru-RU')} ${tThousand}`;
  return money(n);
};

function daysBetween(r: Range): number | null {
  if (!r.from || !r.to) return null;
  const d = (x: string) => Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10));
  return Math.round((d(r.to) - d(r.from)) / 86_400_000) + 1;
}

export default function FinanceAnalytics({ range, rangeOk, period }: { range: Range; rangeOk: boolean; period: string }) {
  const { t } = useT();
  const len = daysBetween(range);
  const [bucket, setBucket] = useState<Bucket>(() => (len == null || len > 120 ? 'month' : len > 35 ? 'week' : 'day'));
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const prev = prevRangeOf(range, period, tjToday());
  const keep = rangeOk ? keepPreviousData : undefined;
  const on = rangeOk;

  const sumQ = useQuery<FinanceSummary>({ queryKey: ['finance', 'summary', range], queryFn: () => financeSummary(range), enabled: on, placeholderData: keep });
  const prevQ = useQuery<FinanceSummary>({ queryKey: ['finance', 'summary', prev ?? { from: 'none' }], queryFn: () => financeSummary(prev!), enabled: on && !!prev, staleTime: 60_000 });
  const tsQ = useQuery<TimeseriesPoint[]>({ queryKey: ['finance', 'timeseries', range, bucket], queryFn: () => financeTimeseries({ ...range, bucket }), enabled: on, placeholderData: keep });
  const brQ = useQuery({ queryKey: ['finance', 'breakdown', range], queryFn: () => financeBreakdown(range), enabled: on, placeholderData: keep });
  const prodQ = useQuery({ queryKey: ['finance', 'income-by-product', range], queryFn: () => financeIncomeByProduct(range), enabled: on, placeholderData: keep });
  const chQ = useQuery({ queryKey: ['finance', 'by-channel', range], queryFn: () => financeByChannel(range), enabled: on, placeholderData: keep });
  const distQ = useQuery({ queryKey: ['finance', 'distribution', range], queryFn: () => financeDistribution(range), enabled: on, placeholderData: keep });
  const debtQ = useQuery<any[]>({ queryKey: ['finance', 'pending'], queryFn: () => pendingPayments(), enabled: on });

  const thousand = t('analytics.thousand');
  const million = t('analytics.million');

  // ── Показатели ──
  const s = sumQ.data;
  const p = prevQ.data;
  const debts = debtQ.data ?? [];
  const debtTotal = debts.reduce((acc, a) => acc + (a.debt?.amount != null && (a.debt.currency || 'TJS') === 'TJS' ? Number(a.debt.amount) : 0), 0);
  const overdueClients = debts.filter((a) => (a.debt?.overdueDays ?? 0) > 0).length;
  const avg = s && s.incomeCount > 0 ? s.totalIncome / s.incomeCount : null;
  const prevAvg = p && p.incomeCount > 0 ? p.totalIncome / p.incomeCount : null;
  const margin = s && s.totalIncome > 0 ? Math.round((s.netProfit / s.totalIncome) * 100) : null;
  const vs = prev ? t('dashboard.v2.vsPrev') : '';

  // ── Динамика ──
  // Сервер отдаёт только точки с операциями — дни/недели/месяцы без денег
  // дорисовываем нулями, иначе пустой месяц просто пропадал с графика.
  const series = useMemo(
    () => fillBuckets(tsQ.data ?? [], range, bucket, tjToday()).map((x) => ({ ...x, label: bucketLabel(x.key, bucket) })),
    [tsQ.data, bucket, range.from, range.to], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const hasSeries = series.some((x) => x.income || x.expense);
  const best = series.reduce<(typeof series)[number] | null>((b, x) => (!b || x.income > b.income ? x : b), null);

  // ── Структура ──
  const expenseItems = useMemo(() => {
    const rows = (brQ.data?.byExpenseCategory ?? []).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
    return topWithOther(rows.map((x) => ({ label: (TRANSACTION_CATEGORY_LABEL as any)[x.category] ?? String(x.category), amount: x.amount })), 5, t('analytics.other'));
  }, [brQ.data, t]);
  const productItems = useMemo(() => {
    const rows = (prodQ.data ?? []).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
    return topWithOther(rows.map((x) => ({ label: x.product ? (PRODUCT_CATEGORY_TEXT[x.product] ?? x.product) : t('analytics.noProduct'), amount: x.amount })), 5, t('analytics.other'));
  }, [prodQ.data, t]);
  const channels = (chQ.data ?? []).filter((x) => x.amount > 0);
  const channelTotal = channels.reduce((a, x) => a + x.amount, 0);

  // ── Люди ──
  const managers = (brQ.data?.byManager ?? []).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 8)
    .map((x) => ({ name: x.manager?.fullName ?? t('details.noManager'), amount: x.amount, count: x.count }));
  const debtByManager = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of debts) {
      if (a.debt?.amount == null || (a.debt.currency || 'TJS') !== 'TJS') continue;
      const name = a.manager?.fullName ?? t('details.noManager');
      m.set(name, (m.get(name) ?? 0) + Number(a.debt.amount));
    }
    return [...m.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount).slice(0, 8);
  }, [debts, t]);

  // ── Долги по срокам ──
  const aging = useMemo(() => {
    const buckets = [
      { label: t('analytics.aging.ok'), amount: 0, count: 0 },
      { label: t('analytics.aging.30'), amount: 0, count: 0 },
      { label: t('analytics.aging.60'), amount: 0, count: 0 },
      { label: t('analytics.aging.more'), amount: 0, count: 0 },
    ];
    for (const a of debts) {
      if (a.debt?.amount == null || (a.debt.currency || 'TJS') !== 'TJS') continue;
      const d = a.debt.overdueDays ?? 0;
      const i = d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : 3;
      buckets[i].amount += Number(a.debt.amount);
      buckets[i].count += 1;
    }
    return buckets;
  }, [debts, t]);
  const agingMax = Math.max(1, ...aging.map((x) => x.amount));

  // ── Распределение ──
  const dist = distQ.data;
  const split = (dist?.scheme?.buckets ?? []).filter((b) => b.allocated > 0).sort((a, b) => a.order - b.order);
  const splitTotal = split.reduce((a, b) => a + b.allocated, 0);

  if (!rangeOk) return null;

  return (
    <div className="fa" data-testid="finance-analytics">
      {/* Итоги периода */}
      <section className="dash-kpis fa-kpis" aria-label={t('analytics.kpis')}>
        <Kpi label={t('analytics.kpi.income')} value={s ? money(s.totalIncome) : '—'} delta={compareValues(s?.totalIncome, p?.totalIncome)} note={vs} testId="fa-kpi-income" />
        <Kpi label={t('analytics.kpi.expense')} value={s ? money(s.totalExpense) : '—'} delta={compareValues(s?.totalExpense, p?.totalExpense, false)} note={vs} testId="fa-kpi-expense" />
        <Kpi label={t('analytics.kpi.profit')} value={s ? money(s.netProfit) : '—'} delta={compareValues(s?.netProfit, p?.netProfit)} note={margin != null ? t('analytics.margin').replace('{n}', String(margin)) : vs} testId="fa-kpi-profit" accent />
        <Kpi label={t('analytics.kpi.avg')} value={avg != null ? money(avg) : '—'} delta={compareValues(avg, prevAvg)} note={s ? t('analytics.payments').replace('{n}', String(s.incomeCount)) : ''} testId="fa-kpi-avg" />
        <Kpi label={t('analytics.kpi.debts')} value={money(debtTotal)} delta={overdueClients > 0 ? { text: t('analytics.overdueClients').replace('{n}', String(overdueClients)), tone: 'bad' } : undefined} note={t('analytics.clients').replace('{n}', String(debts.length))} testId="fa-kpi-debts" warn={overdueClients > 0} />
      </section>

      {/* Доходы, расходы, прибыль */}
      <section className="card fa-card" data-testid="fa-timeseries">
        <div className="fa-head">
          <div>
            <h2 className="fa-title">{t('analytics.ts.title')}</h2>
            <p className="fa-sub">{t('analytics.ts.sub')}</p>
          </div>
          <div className="fa-tools">
            <Seg
              label={t('analytics.ts.step')}
              value={bucket}
              onChange={(v) => setBucket(v as Bucket)}
              options={[['day', t('analytics.step.day')], ['week', t('analytics.step.week')], ['month', t('analytics.step.month')]]}
              testId="fa-bucket"
            />
            <Seg
              label={t('analytics.view')}
              value={view}
              onChange={(v) => setView(v as 'chart' | 'table')}
              options={[['chart', t('analytics.view.chart')], ['table', t('analytics.view.table')]]}
              testId="fa-view"
            />
          </div>
        </div>
        <div className="fa-legend">
          <LegendDot color={C.income} label={t('analytics.income')} />
          <LegendDot color={C.expense} label={t('analytics.expense')} />
          <LegendDot color={C.profit} label={t('analytics.profit')} line />
          {best && best.income > 0 && (
            <span className="fa-note">{t('analytics.ts.best').replace('{label}', best.label).replace('{sum}', money(best.income))}</span>
          )}
        </div>
        {tsQ.isLoading ? (
          <div className="fa-empty">{t('common.loading')}</div>
        ) : !hasSeries ? (
          <div className="fa-empty">{t('analytics.empty')}</div>
        ) : view === 'chart' ? (
          <div className="fa-chart" role="img" aria-label={t('analytics.ts.aria').replace('{n}', String(series.length))}>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                <CartesianGrid stroke={C.grid} strokeDasharray="4 4" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: C.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: C.grid }} interval="preserveStartEnd" minTickGap={12} />
                <YAxis tick={{ fill: C.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => moneyShort(v, thousand, million)} />
                <Tooltip cursor={{ fill: 'rgba(1,54,139,0.06)' }} content={<MoneyTooltip t={t} />} />
                <Bar dataKey="income" name={t('analytics.income')} fill={C.income} radius={[4, 4, 0, 0]} maxBarSize={22} animationDuration={500} />
                <Bar dataKey="expense" name={t('analytics.expense')} fill={C.expense} radius={[4, 4, 0, 0]} maxBarSize={22} animationDuration={500} />
                <Line dataKey="profit" name={t('analytics.profit')} stroke={C.profit} strokeWidth={2.5} dot={series.length <= 16 ? { r: 3, fill: C.profit } : false} type="monotone" animationDuration={500} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="fa-table-wrap">
            <table className="table fa-table" data-testid="fa-ts-table">
              <thead>
                <tr><th>{t('analytics.col.period')}</th><th>{t('analytics.income')}</th><th>{t('analytics.expense')}</th><th>{t('analytics.profit')}</th><th>{t('analytics.col.margin')}</th></tr>
              </thead>
              <tbody>
                {series.map((x) => (
                  <tr key={x.key}>
                    <td>{x.label}</td>
                    <td>{money(x.income)}</td>
                    <td>{money(x.expense)}</td>
                    <td style={{ fontWeight: 600 }}>{money(x.profit)}</td>
                    <td>{x.income > 0 ? `${Math.round((x.profit / x.income) * 100)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Структура */}
      <section className="fa-grid-3">
        <DonutCard title={t('analytics.expenseCats')} items={expenseItems} loading={brQ.isLoading} t={t} testId="fa-expense-cats" />
        <DonutCard title={t('analytics.incomeProducts')} items={productItems} loading={prodQ.isLoading} t={t} testId="fa-income-products" />
        <div className="card fa-card" data-testid="fa-channels">
          <h2 className="fa-title">{t('analytics.channels')}</h2>
          <p className="fa-sub">{t('analytics.channels.sub')}</p>
          {chQ.isLoading ? (
            <div className="fa-empty">{t('common.loading')}</div>
          ) : channels.length === 0 ? (
            <div className="fa-empty">{t('analytics.empty')}</div>
          ) : (
            <>
              <div className="fa-stack" role="img" aria-label={channels.map((x) => `${channelLabel(x.channel, t)} ${Math.round((x.amount / channelTotal) * 100)}%`).join(', ')}>
                {channels.map((x, i) => (
                  <span key={x.channel} style={{ width: `${(x.amount / channelTotal) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
                ))}
              </div>
              <ul className="fa-legend-list">
                {channels.map((x, i) => (
                  <li key={x.channel}>
                    <span className="fa-swatch" style={{ background: PALETTE[i % PALETTE.length] }} />
                    <span className="fa-ll-label">{channelLabel(x.channel, t)}</span>
                    <span className="fa-ll-num">{money(x.amount)}</span>
                    <span className="fa-ll-pct">{Math.round((x.amount / channelTotal) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      {/* Люди */}
      <section className="fa-grid-2">
        <BarsCard
          title={t('analytics.managers')}
          sub={t('analytics.managers.sub')}
          rows={managers.map((m) => ({ name: m.name, amount: m.amount }))}
          color={C.income}
          loading={brQ.isLoading}
          t={t}
          testId="fa-managers"
        />
        <BarsCard
          title={t('analytics.debtsByManager')}
          sub={t('analytics.debtsByManager.sub')}
          rows={debtByManager}
          color="#E08A3C"
          loading={debtQ.isLoading}
          t={t}
          testId="fa-debts-managers"
          emptyText={debts.length > 0 ? t('finance.debt.noAmountHint') : t('finance.outstanding.empty')}
        />
      </section>

      {/* Распределение и долги */}
      <section className="fa-grid-2">
        <div className="card fa-card" data-testid="fa-distribution">
          <h2 className="fa-title">{t('analytics.distribution')}</h2>
          <p className="fa-sub">{t('analytics.distribution.sub')}</p>
          {distQ.isLoading ? (
            <div className="fa-empty">{t('common.loading')}</div>
          ) : !dist?.scheme ? (
            <div className="fa-empty">
              {t('analytics.distribution.none')} <Link to="/settings">{t('analytics.distribution.setup')}</Link>
            </div>
          ) : (
            <>
              <div className="fa-flow">
                <div className="fa-flow-box"><span>{t('analytics.income')}</span><strong>{money(dist.incomeTotal)}</strong></div>
                <Icon name="arrow_forward" size={18} />
                <div className="fa-flow-box is-exp"><span>{t('analytics.distribution.byScheme')}</span><strong>− {money(splitTotal)}</strong></div>
                <Icon name="arrow_forward" size={18} />
                <div className={`fa-flow-box ${dist.netAfterDistribution < 0 ? 'is-neg' : 'is-profit'}`}><span>{t('analytics.distribution.left')}</span><strong>{money(dist.netAfterDistribution)}</strong></div>
              </div>
              {split.length > 0 ? (
                <>
                  <div className="fa-stack is-tall" role="img" aria-label={split.map((b) => `${b.name} ${money(b.allocated)}`).join(', ')}>
                    {split.map((b, i) => (
                      <span key={b.id} style={{ width: `${(b.allocated / splitTotal) * 100}%`, background: visibleColor(b.color, i) }} />
                    ))}
                  </div>
                  <ul className="fa-legend-list is-2col">
                    {split.map((b, i) => (
                      <li key={b.id}>
                        <span className="fa-swatch" style={{ background: visibleColor(b.color, i) }} />
                        <span className="fa-ll-label">{b.name}{b.kind === 'PERCENTAGE' && b.percent != null ? ` · ${b.percent}%` : ''}</span>
                        <span className="fa-ll-num">{money(b.allocated)}</span>
                      </li>
                    ))}
                  </ul>
                  {dist.netAfterDistribution < 0 && (
                    <div className="fa-note is-warn">{t('analytics.distribution.over')}</div>
                  )}
                </>
              ) : (
                <div className="fa-empty">{t('analytics.empty')}</div>
              )}
            </>
          )}
        </div>

        <div className="card fa-card" data-testid="fa-aging">
          <div className="fa-head">
            <div>
              <h2 className="fa-title">{t('analytics.aging')}</h2>
              <p className="fa-sub">{t('analytics.aging.sub').replace('{n}', String(debts.length))}</p>
            </div>
            <strong className="fa-total">{money(debtTotal)} TJS</strong>
          </div>
          {debtQ.isLoading ? (
            <div className="fa-empty">{t('common.loading')}</div>
          ) : debtTotal === 0 ? (
            <div className="fa-empty">{debts.length > 0 ? t('finance.debt.noAmountHint') : t('finance.outstanding.empty')}</div>
          ) : (
            <div className="fa-aging">
              {aging.map((b, i) => (
                <div key={b.label} className="fa-aging-col">
                  <span className="fa-aging-sum">{money(b.amount)}</span>
                  <span className="fa-aging-bar" style={{ height: `${Math.max(b.amount > 0 ? 6 : 2, (b.amount / agingMax) * 140)}px`, background: DEBT_SCALE[i] }} />
                  <span className="fa-aging-label">{b.label}</span>
                  <span className="fa-aging-count">{t('analytics.clients').replace('{n}', String(b.count))}</span>
                </div>
              ))}
            </div>
          )}
          <Link to="/finance#finance-debts" className="dash-link">{t('analytics.openDebtors')} <Icon name="arrow_forward" size={16} /></Link>
        </div>
      </section>
    </div>
  );
}

/** Все точки периода по шагу (до сегодня), с нулями там, где операций не было. */
function fillBuckets(points: TimeseriesPoint[], range: Range, bucket: Bucket, today: string): TimeseriesPoint[] {
  if (!range.from || !range.to || points.length === 0 && !range.from) return points;
  const end = range.to < today ? range.to : today;
  if (end < range.from) return points;
  const byKey = new Map(points.map((x) => [x.key, x]));
  const keys: string[] = [];
  const DAY = 86_400_000;
  const toDate = (s: string) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (bucket === 'month') {
    let y = +range.from.slice(0, 4), m = +range.from.slice(5, 7);
    const ey = +end.slice(0, 4), em = +end.slice(5, 7);
    while (y < ey || (y === ey && m <= em)) {
      keys.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
      if (keys.length > 240) break;
    }
  } else if (bucket === 'week') {
    const start = toDate(range.from);
    const wd = start.getUTCDay() || 7;
    let d = new Date(start.getTime() - (wd - 1) * DAY);
    const last = toDate(end);
    while (d <= last && keys.length < 400) { keys.push(iso(d)); d = new Date(d.getTime() + 7 * DAY); }
  } else {
    let d = toDate(range.from);
    const last = toDate(end);
    while (d <= last && keys.length < 800) { keys.push(iso(d)); d = new Date(d.getTime() + DAY); }
  }
  // Точки, которых нет в сетке (неожиданный ключ с сервера), не теряем.
  for (const p of points) if (!keys.includes(p.key)) keys.push(p.key);
  keys.sort();
  return keys.map((k) => byKey.get(k) ?? { key: k, income: 0, expense: 0, profit: 0 });
}

/** Цвет статьи схемы: основатель мог оставить белый (по умолчанию) — тогда из палитры. */
function visibleColor(c: string | null | undefined, i: number): string {
  const hex = (c || '').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return PALETTE[i % PALETTE.length];
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.88 ? PALETTE[i % PALETTE.length] : `#${m[1]}`;
}

/** Подпись точки по шагу: «9 ноя», «нед. 03.11», «ноя 2026». */
function bucketLabel(key: string, bucket: Bucket): string {
  if (bucket === 'month') {
    const d = new Date(`${key}-15T12:00:00Z`);
    return `${fmtDateText(d, { month: 'short', timeZone: 'UTC' }).replace('.', '')} ${key.slice(0, 4)}`;
  }
  const d = new Date(`${key}T12:00:00Z`);
  if (bucket === 'week') return fmtDateText(d, { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  return fmtDateText(d, { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
}

function channelLabel(ch: string, t: (k: string) => string): string {
  if (ch === 'UNKNOWN') return t('analytics.channel.unknown');
  return (PAYMENT_CHANNEL_LABEL as Record<string, string>)[ch as PaymentChannel] ?? ch;
}

/** Первые N строк + «Прочее» — чтобы кольцо не дробилось на десяток тонких долей. */
function topWithOther(rows: Array<{ label: string; amount: number }>, n: number, otherLabel: string) {
  if (rows.length <= n) return rows;
  const head = rows.slice(0, n - 1);
  const rest = rows.slice(n - 1).reduce((a, x) => a + x.amount, 0);
  return [...head, { label: otherLabel, amount: rest }];
}

function Kpi({ label, value, delta, note, testId, accent, warn }: {
  label: string; value: string; delta?: Delta; note?: string; testId?: string; accent?: boolean; warn?: boolean;
}) {
  return (
    <div className={`dash-kpi${accent ? ' is-accent' : ''}${warn ? ' is-warn' : ''}`} data-testid={testId}>
      <div className="dash-kpi-label"><span>{label}</span></div>
      <div className="fa-kpi-value">{value}<span>TJS</span></div>
      <div className="dash-kpi-foot">
        {delta && <span className={`dash-delta is-${delta.tone}`}>{delta.text}</span>}
        {note && <span>{note}</span>}
      </div>
    </div>
  );
}

function Seg({ label, value, onChange, options, testId }: {
  label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]>; testId?: string;
}) {
  return (
    <div className="fa-seg" role="group" aria-label={label} data-testid={testId}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} className={value === v ? 'is-on' : ''} onClick={() => onChange(v)} data-testid={testId ? `${testId}-${v}` : undefined}>
          {text}
        </button>
      ))}
    </div>
  );
}

function LegendDot({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="fa-legend-item">
      {line ? <span className="fa-legend-line" style={{ borderTopColor: color }} /> : <span className="fa-swatch" style={{ background: color }} />}
      {label}
    </span>
  );
}

function MoneyTooltip({ active, payload, label, t }: { active?: boolean; payload?: any[]; label?: string; t: (k: string) => string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as TimeseriesPoint | undefined;
  return (
    <div className="fa-tooltip">
      <div className="fa-tooltip-title">{label}</div>
      {payload.map((x) => (
        <div key={x.dataKey} className="fa-tooltip-row">
          <span className="fa-swatch" style={{ background: x.color || x.stroke }} />
          <span>{x.name}</span>
          <strong>{money(Number(x.value) || 0)}</strong>
        </div>
      ))}
      {row && row.income > 0 && (
        <div className="fa-tooltip-foot">{t('analytics.col.margin')}: {Math.round((row.profit / row.income) * 100)}%</div>
      )}
    </div>
  );
}

function DonutCard({ title, items, loading, t, testId }: {
  title: string; items: Array<{ label: string; amount: number }>; loading: boolean; t: (k: string) => string; testId?: string;
}) {
  const total = items.reduce((a, x) => a + x.amount, 0);
  return (
    <div className="card fa-card" data-testid={testId}>
      <h2 className="fa-title">{title}</h2>
      {loading ? (
        <div className="fa-empty">{t('common.loading')}</div>
      ) : total === 0 ? (
        <div className="fa-empty">{t('analytics.empty')}</div>
      ) : (
        <div className="fa-donut-row">
          <div className="fa-donut" role="img" aria-label={items.map((x) => `${x.label} ${Math.round((x.amount / total) * 100)}%`).join(', ')}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={items} dataKey="amount" nameKey="label" innerRadius="62%" outerRadius="100%" paddingAngle={items.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
                  {items.map((x, i) => <Cell key={x.label} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="fa-donut-center"><strong>{moneyShort(total, t('analytics.thousand'), t('analytics.million'))}</strong><span>TJS</span></div>
          </div>
          <ul className="fa-legend-list">
            {items.map((x, i) => (
              <li key={x.label}>
                <span className="fa-swatch" style={{ background: PALETTE[i % PALETTE.length] }} />
                <span className="fa-ll-label">{x.label}</span>
                <span className="fa-ll-num">{money(x.amount)}</span>
                <span className="fa-ll-pct">{Math.round((x.amount / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BarsCard({ title, sub, rows, color, loading, t, testId, emptyText }: {
  title: string; sub: string; rows: Array<{ name: string; amount: number }>; color: string; loading: boolean; t: (k: string) => string; testId?: string;
  emptyText?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  const total = rows.reduce((a, r) => a + r.amount, 0);
  return (
    <div className="card fa-card" data-testid={testId}>
      <div className="fa-head">
        <div>
          <h2 className="fa-title">{title}</h2>
          <p className="fa-sub">{sub}</p>
        </div>
        {total > 0 && <strong className="fa-total">{money(total)} TJS</strong>}
      </div>
      {loading ? (
        <div className="fa-empty">{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <div className="fa-empty">{emptyText ?? t('analytics.empty')}</div>
      ) : (
        <ul className="fa-bars">
          {rows.map((r, i) => (
            <li key={`${r.name}-${i}`}>
              <span className="fa-bar-name" title={r.name}>{r.name}</span>
              <span className="fa-bar-track"><span style={{ width: `${(r.amount / max) * 100}%`, background: color }} /></span>
              <span className="fa-bar-num">{money(r.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

