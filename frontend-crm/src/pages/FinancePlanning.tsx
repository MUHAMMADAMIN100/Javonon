import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import FinanceSubnav from '../components/finance/FinanceSubnav';
import TransactionForm from '../components/finance/TransactionForm';
import { MonthNav, fmtMoney, monthLabel, useYmParam } from '../components/finance/financeShared';
import { ExpensePayModal, useMonthIn } from '../components/finance/ExpenseShared';
import { AcceptPaymentModal } from './FinanceIncome';
import { getFinancePlanning, listAccounts, type ContractRow, type PlanItem } from '../api/finance';
import { updatePaymentStage } from '../api/installments';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { useRealtime } from '../realtime';
import { useAuth } from '../store/auth';
import { hasRole, isFounder } from '../lib/roles';
import { roleCan } from '../lib/permissions';
import { useMediaQuery } from '../lib/useMediaQuery';
import { fmtDateText } from '../lib/tjTime';

/**
 * «Финансы → Планирование» (часть 3, 11.11.2026): календарь месяца — что
 * пришло и ушло, что ждём, просрочки. «Получено» / «Оплачено» прямо из
 * календаря; срок этапа сделки переносится перетаскиванием.
 */

type Filter = 'all' | 'in' | 'out' | 'todo';
const money = (m: Record<string, number>) => {
  const e = Object.entries(m).filter(([, v]) => Math.abs(v) > 0.005);
  return e.length ? e.map(([c, v]) => fmtMoney(v, c)).join(' + ') : fmtMoney(0);
};
const short = (d: string) => fmtDateText(`${d}T00:00:00Z`, { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function FinancePlanning() {
  const { t } = useT();
  const qc = useQueryClient();
  const monthIn = useMonthIn();
  const me = useAuth((s) => s.user);
  const narrow = useMediaQuery('(max-width: 720px)');
  const canPay = roleCan(me, 'finance:create', hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT'));
  const canMoveStage = roleCan(me, 'submissions:stages', hasRole(me, 'FOUNDER', 'ADMIN'));
  const [ym, setYm] = useYmParam();
  const [filter, setFilter] = useState<Filter>('all');
  const [card, setCard] = useState<PlanItem | null>(null);
  const [accept, setAccept] = useState<ContractRow | null>(null);
  const [pay, setPay] = useState<PlanItem | null>(null);
  const [add, setAdd] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const q = useQuery({ queryKey: keys.finance.expense('planning', ym), queryFn: () => getFinancePlanning(ym), placeholderData: keepPreviousData });
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts, enabled: canPay });
  const { toast } = useUI();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; qc.invalidateQueries({ queryKey: keys.finance.all }); }, 400);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useRealtime({ 'transaction:new': refresh, 'transaction:updated': refresh, 'transaction:deleted': refresh, 'transaction:reversed': refresh, 'finance:accounts': refresh });

  const d = q.data;
  const label = (it: PlanItem) => {
    const r = (it.ref ?? {}) as any;
    if (it.kind === 'stage') return `${r.name} · ${t('finance.inc.stageOf').replace('{k}', String(r.stageOrder)).replace('{n}', String(r.stagesCount))}`;
    if (it.kind === 'salary') return t('finance.plan.salaryFor').replace('{month}', monthLabel(String(r.ym)).toLowerCase());
    if (it.kind === 'expense' && r.group && r.count) return `${t(`finance.exp.g.${r.group}`)}${r.count > 1 ? ` · ${r.count}` : ''}`;
    return it.name;
  };
  const visible = useMemo(() => (d?.items ?? []).filter((i) =>
    filter === 'all' ? true : filter === 'todo' ? i.status !== 'done' : i.dir === filter), [d, filter]);
  const byDay = useMemo(() => {
    const m = new Map<string, PlanItem[]>();
    for (const i of visible) m.set(i.date, [...(m.get(i.date) ?? []), i]);
    return m;
  }, [visible]);

  const cells = useMemo(() => {
    const [y, mo] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const lead = (first + 6) % 7;
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const out: Array<string | null> = Array.from({ length: lead }, () => null);
    for (let i = 1; i <= days; i++) out.push(`${ym}-${String(i).padStart(2, '0')}`);
    while (out.length % 7) out.push(null);
    return out;
  }, [ym]);

  const mark = (s: PlanItem['status']) => (s === 'done' ? '✓' : s === 'late' ? '!' : '○');
  const sign = (i: PlanItem) => `${i.dir === 'in' ? '+' : '−'}${fmtMoney(i.amount, i.currency)}`;
  const itemBtn = (i: PlanItem) => (
    <button
      key={i.id}
      type="button"
      className={`plan-item is-${i.dir} is-${i.status}`}
      draggable={i.kind === 'stage' && canMoveStage}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', i.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => setCard(i)}
      title={`${label(i)} · ${sign(i)}`}
      data-testid={`plan-item-${i.id}`}
    >
      <span className="plan-mark" aria-hidden="true">{mark(i.status)}</span>
      <span className="plan-name">{label(i)}</span>
      <span className="plan-amt">{sign(i)}</span>
    </button>
  );

  const moveStage = async (it: PlanItem, date: string) => {
    if (it.kind !== 'stage' || it.date === date) return;
    try {
      await updatePaymentStage(String((it.ref as any).stageId), { dueDate: date });
      toast(t('finance.plan.moved').replace('{date}', short(date)), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const act = (it: PlanItem) => {
    const r = (it.ref ?? {}) as any;
    setCard(null);
    if (it.kind === 'stage') {
      setAccept({
        submissionId: r.submissionId, group: 'waiting', name: r.name, studentId: null, program: null, manager: r.managerId ? { id: r.managerId, name: '' } : null,
        total: 0, currency: r.currency, status: 'ACTIVE', stagesCount: r.stagesCount, stageOrder: r.stageOrder, paidTotal: 0, left: r.left, payments: [],
        dueDate: it.date, dueDays: null, dueAmount: r.dueAmount, waiting: r.dueAmount, overdue: 0, paidInMonth: 0, lastPaidAt: null, nextDueDate: null, pendingCount: 0, pendingSum: 0,
      });
    } else setPay(it);
  };

  return (
    <>
      <FinanceSubnav />
      <div className="fin-toolbar">
        <p className="fin-muted-line inc-lead">{t('finance.plan.lead')}</p>
        <MonthNav ym={ym} onChange={setYm} busy={q.isFetching} />
        {canPay && (
          <button type="button" className="btn btn-primary" onClick={() => setAdd(true)} data-testid="plan-add">
            <Icon name="add" size={18} /> {t('finance.plan.add')}
          </button>
        )}
      </div>
      {d && (
        <div className="inc-tiles fin-block">
          <div className="inc-tile" data-testid="plan-tile-in">
            <span className="inc-tile-label">{t('finance.plan.inIn').replace('{month}', monthIn(ym))}</span>
            <span className="inc-tile-value fin-num is-in">+{money(mergeSum(d.kpi.in.done, d.kpi.in.wait))}</span>
            <span className="inc-tile-sub">{t('finance.plan.doneWait').replace('{done}', money(d.kpi.in.done)).replace('{wait}', money(d.kpi.in.wait))}</span>
          </div>
          <div className="inc-tile" data-testid="plan-tile-out">
            <span className="inc-tile-label">{t('finance.plan.outIn').replace('{month}', monthIn(ym))}</span>
            <span className="inc-tile-value fin-num is-out">−{money(mergeSum(d.kpi.out.done, d.kpi.out.wait))}</span>
            <span className="inc-tile-sub">{t('finance.plan.doneLeft').replace('{done}', money(d.kpi.out.done)).replace('{wait}', money(d.kpi.out.wait))}</span>
          </div>
          <div className={`inc-tile${d.overdue.length ? ' plan-late-tile' : ''}`} data-testid="plan-tile-overdue">
            <span className="inc-tile-label">{t('finance.plan.overdue').replace('{n}', String(d.overdue.length))}</span>
            {d.overdue.length ? d.overdue.slice(0, 3).map((o) => (
              <span key={o.id} className="inc-tile-sub is-bad">{short(o.date)}: {label(o)} · {sign(o)} · {t('finance.inc.daysShort').replace('{n}', String(o.days))}</span>
            )) : <span className="inc-tile-sub">{t('finance.plan.noOverdue')}</span>}
          </div>
        </div>
      )}
      <div className="plan-filters fin-block">
        <div className="act-groups" role="radiogroup" aria-label={t('finance.act.filter')}>
          {(['all', 'in', 'out', 'todo'] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={`fin-subnav-chip act-chip${filter === f ? ' is-active' : ''}`} onClick={() => setFilter(f)} data-testid={`plan-filter-${f}`}>
              {t(`finance.plan.f.${f}`)}
            </button>
          ))}
        </div>
        <span className="plan-legend">✓ {t('finance.plan.legendDone')} · ○ {t('finance.plan.legendWait')} · ! {t('finance.plan.legendLate')}</span>
      </div>
      <section className="fin-card fin-block" data-testid="plan-calendar">
        {!d ? <p className="fin-empty-line">{t('common.loading')}</p> : narrow ? (
          <div className="plan-list">
            {[...byDay.entries()].map(([day, list]) => (
              <div key={day} className={`plan-day-row${day === d.today ? ' is-today' : ''}`} data-testid={`plan-day-${day}`}>
                <div className="plan-day-head">{fmtDateText(`${day}T00:00:00Z`, { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' })}</div>
                {list.map(itemBtn)}
              </div>
            ))}
            {byDay.size === 0 && <p className="fin-empty-line">{t('finance.plan.empty')}</p>}
          </div>
        ) : (
          <div className="plan-grid">
            {t('finance.cal.weekdays').split(',').map((w) => <span key={w} className="fin-cal-wd">{w}</span>)}
            {cells.map((c, i) => c ? (
              <div
                key={c}
                className={`plan-day${c === d.today ? ' is-today' : ''}${c < d.today ? ' is-past' : ''}${dragOver === c ? ' is-drop' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(c); }}
                onDragLeave={() => setDragOver((v) => (v === c ? null : v))}
                onDrop={(e) => { e.preventDefault(); setDragOver(null); const it = d.items.find((x) => x.id === e.dataTransfer.getData('text/plain')); if (it) void moveStage(it, c); }}
                data-testid={`plan-day-${c}`}
              >
                <span className="plan-num">{Number(c.slice(8))}</span>
                {(byDay.get(c) ?? []).map(itemBtn)}
              </div>
            ) : <div key={`e${i}`} className="plan-day is-empty" aria-hidden="true" />)}
          </div>
        )}
        <div className="fin-note-box plan-notes">
          <p>{t('finance.plan.hintClick')}</p>
          <p>{t('finance.plan.hintIn')}</p>
          <p>{t('finance.plan.hintOut')}</p>
          <p>{t('finance.plan.hintRemind')}</p>
        </div>
      </section>

      <AnimatePresence>
        {card && (
          <FormModal open title={label(card)} onClose={() => setCard(null)} dirty={false} busy={false} width={440} testId="plan-card">
            <dl className="tx-detail-list">
              <div className="tx-detail-row"><dt>{t('common.amount')}</dt><dd className={card.dir === 'in' ? 'is-in' : 'is-out'}>{sign(card)}</dd></div>
              <div className="tx-detail-row"><dt>{t('common.date')}</dt><dd>{short(card.date)}</dd></div>
              <div className="tx-detail-row"><dt>{t('common.status')}</dt><dd>{t(`finance.plan.st.${card.status}`)}</dd></div>
            </dl>
            <div className="form-actions">
              {card.status !== 'done' && canPay && (card.kind === 'stage' || card.kind === 'subscription' || card.kind === 'debt') && (
                <button type="button" className="btn btn-primary" onClick={() => act(card)} data-testid="plan-card-do">
                  {card.kind === 'stage' ? t('finance.plan.received') : t('finance.plan.paidBtn')}
                </button>
              )}
              {card.kind === 'salary' && <Link className="btn btn-primary" to={`/finance/expense/salary?ym=${(card.ref as any).ym}`} data-testid="plan-card-link">{t('finance.plan.toPayroll')}</Link>}
              {card.kind === 'payout' && <Link className="btn btn-primary" to="/finance/expense/partners" data-testid="plan-card-link">{t('finance.plan.toPartners')}</Link>}
              {card.kind === 'stage' && <Link className="btn btn-secondary" to={`/submissions/${(card.ref as any).submissionId}`}>{t('finance.inc.deal')}</Link>}
              <button type="button" className="btn btn-secondary" onClick={() => setCard(null)}>{t('common.close')}</button>
            </div>
          </FormModal>
        )}
        {accept && (
          <AcceptPaymentModal
            key={accept.submissionId}
            row={accept}
            accounts={(accountsQ.data?.accounts ?? []).filter((a) => !a.archived)}
            canApprove={roleCan(me, 'submissions:approve', isFounder(me as any)) && (accept.manager?.id !== me?.id || isFounder(me as any))}
            onClose={() => setAccept(null)}
          />
        )}
        {pay && (() => {
          const r = (pay.ref ?? {}) as any;
          return (
            <ExpensePayModal
              key={pay.id}
              title={t('finance.exp.payTitle').replace('{name}', r.name)}
              currency={r.currency}
              defaultAmount={pay.amount}
              maxAmount={pay.kind === 'debt' ? r.left : r.left}
              category={pay.kind === 'debt' ? 'LOAN_PAYMENT' : r.kind === 'RENT' ? 'RENT' : 'SUBSCRIPTION'}
              link={pay.kind === 'debt' ? { debtId: r.id } : { subscriptionId: r.id }}
              defaultAccountId={r.accountId}
              commentPrefix={r.name}
              onClose={() => setPay(null)}
              onDone={(a) => { toast(t('finance.exp.paidToast').replace('{name}', r.name).replace('{sum}', fmtMoney(a, r.currency)), 'success'); setPay(null); }}
            />
          );
        })()}
        {add && (
          <TransactionForm key="plan-add" preselect={null} canExpense={roleCan(me, 'finance:create', hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT'))}
            onClose={() => setAdd(false)} onCreated={() => { setAdd(false); qc.invalidateQueries({ queryKey: keys.finance.all }); }} />
        )}
      </AnimatePresence>
    </>
  );
}

function mergeSum(a: Record<string, number>, b: Record<string, number>) {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.round(((out[k] ?? 0) + v) * 100) / 100;
  return out;
}
