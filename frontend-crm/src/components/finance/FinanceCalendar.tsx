import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../Icon';
import { useT } from '../../lib/i18n';
import { fmtDateText, tjToday } from '../../lib/tjTime';
import { TRANSACTION_CATEGORY_LABEL, type BalanceDays, type FinanceTransfer, type Transaction } from '../../api/finance';
import { fmtMoney, monthRange } from './financeShared';

/** День операции по Душанбе, «ГГГГ-ММ-ДД». */
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dushanbe', year: 'numeric', month: '2-digit', day: '2-digit' });
export function dayOf(iso: string): string {
  return DAY_FMT.format(new Date(iso));
}

function useNarrow(px: number): boolean {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

const compact = (n: number) => Math.round(n).toLocaleString('ru-RU');

// ───────────────────────── Кривая остатка ─────────────────────────

/**
 * Остаток в сомони на конец каждого дня месяца (только факт, будущих дней
 * нет). Подпись — итог одной фразой, наведение показывает день.
 */
export function BalanceCurve({ data, loading }: { data?: BalanceDays; loading?: boolean }) {
  const { t } = useT();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const days = data?.days ?? [];
  const pts = days.map((d, i) => ({ i, d })).filter((p) => p.d.balance !== null) as Array<{ i: number; d: { date: string; balance: number; income: number; expense: number } }>;
  const W = 1000, H = 150, PAD = 12;
  const n = Math.max(days.length, 1);
  const values = pts.map((p) => p.d.balance);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / Math.max(n - 1, 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);
  const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.d.balance).toFixed(1)}`).join(' ');
  const area = pts.length ? `${x(pts[0].i).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} ${line} ${x(pts[pts.length - 1].i).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)}` : '';
  const low = pts.reduce<typeof pts[number] | null>((m, p) => (!m || p.d.balance < m.d.balance ? p : m), null);
  const last = pts[pts.length - 1];
  const negative = values.some((v) => v < 0);

  let summary = '';
  if (!data?.hasAccounts) summary = t('finance.curve.noAccounts');
  else if (pts.length < 1) summary = t('finance.curve.future');
  else {
    summary = negative ? t('finance.curve.below') : t('finance.curve.above');
    if (low) summary += ` · ${t('finance.curve.low').replace('{sum}', fmtMoney(low.d.balance)).replace('{day}', String(Number(low.d.date.slice(8))))}`;
    if (last) summary += ` · ${t('finance.curve.now').replace('{sum}', fmtMoney(last.d.balance))}`;
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !pts.length) return;
    const rel = ((e.clientX - box.left) / box.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.i) - rel) < Math.abs(x(best.i) - rel)) best = p;
    setHover(best.i);
  };
  const hp = hover !== null ? pts.find((p) => p.i === hover) : null;

  return (
    <section className="fin-card fin-curve" data-testid="balance-curve">
      <div className="fin-card-head">
        <h2 className="fin-card-title">{t('finance.curve.title')}</h2>
        <span className="fin-card-note" data-testid="balance-curve-summary">{loading ? t('common.loading') : summary}</span>
      </div>
      {pts.length >= 2 ? (
        <div className="fin-curve-box">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            width="100%"
            height={H}
            role="img"
            aria-label={summary}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {negative && <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="#DC2626" strokeDasharray="6 6" strokeWidth={1} />}
            <polygon points={area} fill="rgba(1, 54, 139, 0.10)" />
            <polyline points={line} fill="none" stroke="#01368B" strokeWidth={2.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {last && <circle cx={x(last.i)} cy={y(last.d.balance)} r={5} fill="#01368B" vectorEffect="non-scaling-stroke" />}
            {hp && <line x1={x(hp.i)} x2={x(hp.i)} y1={0} y2={H} stroke="#9DB6DC" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
          </svg>
          {hp && (
            <div className="fin-curve-tip" style={{ left: `${(x(hp.i) / W) * 100}%` }} role="status">
              <b>{fmtDateText(`${hp.d.date}T00:00:00Z`, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</b>
              <span>{t('finance.curve.balance')} {fmtMoney(hp.d.balance)}</span>
              {(hp.d.income > 0 || hp.d.expense > 0) && (
                <span>
                  {hp.d.income > 0 && <span className="is-in">+{compact(hp.d.income)}</span>}
                  {hp.d.income > 0 && hp.d.expense > 0 && ' / '}
                  {hp.d.expense > 0 && <span className="is-out">−{compact(hp.d.expense)}</span>}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        !loading && <p className="fin-empty-line">{summary}</p>
      )}
    </section>
  );
}

// ───────────────────────── Календарь месяца ─────────────────────────

interface CalItem {
  key: string;
  kind: 'tx' | 'transfer';
  tx?: Transaction;
  tr?: FinanceTransfer;
  name: string;
  title: string;
  amount: string;
  tone: 'in' | 'out' | 'move';
  movable: boolean;
}

const DAY_LIMIT = 4;

/**
 * Календарь операций месяца. Нажатие — карточка операции; «+» в дне —
 * новая операция этой датой; перетаскивание — перенос даты (у кого есть
 * право править операции; платёж по сделке не двигается).
 */
export function TxCalendar({
  ym,
  transactions,
  transfers,
  canAdd,
  canMove,
  onOpenTx,
  onOpenTransfer,
  onAddDay,
  onMoveTx,
}: {
  ym: string;
  transactions: Transaction[];
  transfers: FinanceTransfer[];
  canAdd: boolean;
  canMove: boolean;
  onOpenTx: (tx: Transaction) => void;
  onOpenTransfer: (tr: FinanceTransfer) => void;
  onAddDay: (date: string) => void;
  onMoveTx: (tx: Transaction, date: string) => void;
}) {
  const { t } = useT();
  const narrow = useNarrow(720);
  const today = tjToday();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const catLabel = (tx: Transaction) => {
    const k = `finance.cat.${tx.category}`;
    return t(k) !== k ? t(k) : TRANSACTION_CATEGORY_LABEL[tx.category];
  };

  const byDay = useMemo(() => {
    const m = new Map<string, CalItem[]>();
    const push = (day: string, it: CalItem) => {
      const arr = m.get(day) ?? [];
      arr.push(it);
      m.set(day, arr);
    };
    for (const tx of transactions) {
      // Имя строки: студент; у зарплаты — сотрудник; иначе комментарий или статья.
      const who = tx.student?.fullName || (tx.category === 'SALARY' ? tx.manager?.fullName : null);
      const name = who ? (tx.category === 'SALARY' ? `${catLabel(tx)} · ${who}` : who) : tx.comment || catLabel(tx);
      push(dayOf(tx.date), {
        key: `tx-${tx.id}`,
        kind: 'tx',
        tx,
        name,
        title: `${catLabel(tx)} · ${name}`,
        amount: `${tx.type === 'INCOME' ? '+' : '−'}${fmtMoney(tx.amount, tx.currency)}`,
        tone: tx.type === 'INCOME' ? 'in' : 'out',
        movable: canMove && tx.category !== 'TUITION_PAYMENT',
      });
    }
    for (const tr of transfers) {
      if (tr.reversedAt) continue;
      push(dayOf(tr.date), {
        key: `tr-${tr.id}`,
        kind: 'transfer',
        tr,
        name: `${tr.fromAccount.name} → ${tr.toAccount.name}`,
        title: t('finance.tr.card'),
        amount: fmtMoney(tr.amount, tr.fromAccount.currency),
        tone: 'move',
        movable: false,
      });
    }
    return m;
  }, [transactions, transfers, canMove]); // eslint-disable-line react-hooks/exhaustive-deps

  // Итог месяца — только сомони, только живые операции (переводы не входят).
  const totals = useMemo(() => {
    let inc = 0, exp = 0;
    for (const tx of transactions) {
      if (tx.currency !== 'TJS') continue;
      if (tx.type === 'INCOME') inc += tx.amount;
      else exp += tx.amount;
    }
    return { inc, exp };
  }, [transactions]);

  const { to } = monthRange(ym);
  const daysInMonth = Number(to.slice(8));
  const [y, m] = ym.split('-').map(Number);
  const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // пн = 0
  const cells: Array<string | null> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${ym}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const weekdays = t('finance.cal.weekdays').split(',');

  const open1 = (it: CalItem) => (it.kind === 'tx' ? onOpenTx(it.tx!) : onOpenTransfer(it.tr!));
  const daySum = (items: CalItem[]) => {
    let inc = 0, exp = 0;
    for (const it of items) {
      if (it.kind !== 'tx' || it.tx!.currency !== 'TJS') continue;
      if (it.tone === 'in') inc += it.tx!.amount;
      else exp += it.tx!.amount;
    }
    return { inc, exp };
  };

  const head = (
    <div className="fin-cal-head">
      <span>
        <b className="is-in">+{compact(totals.inc)}</b> · <b className="is-out">−{compact(totals.exp)}</b> · {t('finance.cal.result')}{' '}
        <b className={totals.inc - totals.exp >= 0 ? 'is-in' : 'is-out'}>{totals.inc - totals.exp >= 0 ? '+' : '−'}{compact(Math.abs(totals.inc - totals.exp))} {t('finance.cal.tjs')}</b>
      </span>
      <span className="fin-card-note">{t('finance.cal.count').replace('{n}', String(transactions.length))}</span>
    </div>
  );

  const itemRow = (it: CalItem, small = false) => (
    <button
      key={it.key}
      type="button"
      className={`fin-cal-item tone-${it.tone}${small ? ' is-small' : ''}`}
      title={it.title}
      draggable={it.movable}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', it.key); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => open1(it)}
      data-testid={`cal-item-${it.key}`}
    >
      <span className="fin-cal-dot" aria-hidden="true" />
      <span className="fin-cal-name">{it.name}</span>
      <span className="fin-cal-amt">{it.amount}</span>
    </button>
  );

  if (narrow) {
    const sel = picked ?? (ym === today.slice(0, 7) ? today : cells.find((c) => c && byDay.has(c)) ?? `${ym}-01`);
    const items = byDay.get(sel) ?? [];
    return (
      <section className="fin-card fin-cal is-narrow" data-testid="tx-calendar">
        {head}
        <div className="fin-cal-mini" role="grid" aria-label={t('finance.cal.title')}>
          {weekdays.map((w, i) => <span key={w} className={`fin-cal-wd${i >= 5 ? ' is-wknd' : ''}`}>{w}</span>)}
          {cells.map((c, i) => {
            if (!c) return <span key={`e${i}`} />;
            const list = byDay.get(c) ?? [];
            const hasIn = list.some((x) => x.tone === 'in');
            const hasOut = list.some((x) => x.tone === 'out');
            const hasMove = list.some((x) => x.tone === 'move');
            return (
              <button
                key={c}
                type="button"
                className={`fin-cal-miniday${c === sel ? ' is-picked' : ''}${c === today ? ' is-today' : ''}`}
                onClick={() => setPicked(c)}
                aria-pressed={c === sel}
                aria-label={fmtDateText(`${c}T00:00:00Z`, { day: 'numeric', month: 'long', timeZone: 'UTC' })}
              >
                <span>{Number(c.slice(8))}</span>
                <span className="fin-cal-dots" aria-hidden="true">
                  {hasIn && <i className="tone-in" />}
                  {hasOut && <i className="tone-out" />}
                  {hasMove && <i className="tone-move" />}
                </span>
              </button>
            );
          })}
        </div>
        <div className="fin-cal-daylist" data-testid="cal-daylist">
          <h3 className="fin-subtitle">{fmtDateText(`${sel}T00:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</h3>
          {items.length === 0 ? <p className="fin-empty-line">{t('finance.cal.noOps')}</p> : items.map((it) => itemRow(it))}
          {canAdd && (
            <button type="button" className="btn btn-secondary fin-cal-addday" onClick={() => onAddDay(sel)} data-testid="cal-add-day">
              <Icon name="add" size={18} /> {t('finance.cal.addOn').replace('{day}', fmtDateText(`${sel}T00:00:00Z`, { day: 'numeric', month: 'long', timeZone: 'UTC' }))}
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="fin-card fin-cal" data-testid="tx-calendar">
      {head}
      <div className="fin-cal-grid">
        {weekdays.map((w, i) => <span key={w} className={`fin-cal-wd${i >= 5 ? ' is-wknd' : ''}`}>{w}</span>)}
        {cells.map((c, i) => {
          if (!c) return <div key={`e${i}`} className="fin-cal-day is-empty" aria-hidden="true" />;
          const list = byDay.get(c) ?? [];
          const expanded = !!open[c];
          const shown = expanded ? list : list.slice(0, DAY_LIMIT);
          const s = daySum(list);
          return (
            <div
              key={c}
              className={`fin-cal-day${c === today ? ' is-today' : ''}${c < today ? ' is-past' : ''}${dragOver === c ? ' is-drop' : ''}`}
              data-testid={`cal-day-${c}`}
              onDragOver={(e) => { if (canMove) { e.preventDefault(); setDragOver(c); } }}
              onDragLeave={() => setDragOver((v) => (v === c ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const key = e.dataTransfer.getData('text/plain');
                for (const arr of byDay.values()) {
                  const it = arr.find((x) => x.key === key);
                  if (it?.tx && it.movable && dayOf(it.tx.date) !== c) onMoveTx(it.tx, c);
                }
              }}
            >
              <div className="fin-cal-daytop">
                <span className="fin-cal-num">{Number(c.slice(8))}</span>
                {(s.inc > 0 || s.exp > 0) && (
                  <span className="fin-cal-sum">
                    {s.inc > 0 && <span className="is-in">+{compact(s.inc)}</span>}
                    {s.exp > 0 && <span className="is-out"> −{compact(s.exp)}</span>}
                  </span>
                )}
                {canAdd && (
                  <button type="button" className="fin-cal-add" onClick={() => onAddDay(c)} aria-label={t('finance.cal.addOn').replace('{day}', String(Number(c.slice(8))))} title={t('finance.cal.add')}>
                    <Icon name="add" size={16} />
                  </button>
                )}
              </div>
              {shown.map((it) => itemRow(it, true))}
              {list.length > DAY_LIMIT && (
                <button type="button" className="fin-cal-more" onClick={() => setOpen((o) => ({ ...o, [c]: !expanded }))}>
                  {expanded ? t('finance.cal.less') : t('finance.cal.more').replace('{n}', String(list.length - DAY_LIMIT))}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="fin-card-note">{canMove ? t('finance.cal.hintMove') : t('finance.cal.hint')}</p>
    </section>
  );
}

