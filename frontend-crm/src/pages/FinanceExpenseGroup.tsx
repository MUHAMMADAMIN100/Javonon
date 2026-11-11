import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import CrmSelect from '../components/CrmSelect';
import CrmDatePicker from '../components/CrmDatePicker';
import FinanceSubnav from '../components/finance/FinanceSubnav';
import TransactionForm from '../components/finance/TransactionForm';
import { MonthNav, fmtMoney, monthLabel, useYmParam, currentYm } from '../components/finance/financeShared';
import { EXPENSE_GROUP_META, ExpensePayModal, parseAmount, useMonthIn } from '../components/finance/ExpenseShared';
import PayrollSection from '../components/finance/PayrollSection';
import {
  createDebt,
  createSubscription,
  deleteDebt,
  deleteTransaction,
  getDebts,
  getPayroll,
  getOtherExpense,
  getPartnersBoard,
  getSubscriptions,
  listAccounts,
  payPartnerPayout,
  setOtherPlan,
  updateDebt,
  updateSubscription,
  uploadReceipt,
  TRANSACTION_CATEGORY_LABEL,
  type DebtInput,
  type DebtRow,
  type ExpensePaymentRef,
  type PartnersBoard,
  type SubscriptionInput,
  type SubscriptionRow,
} from '../api/finance';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { useRealtime } from '../realtime';
import { useAuth } from '../store/auth';
import { hasRole, isElevated } from '../lib/roles';
import { roleCan } from '../lib/permissions';
import { useMediaQuery } from '../lib/useMediaQuery';
import { fmtDateText, tjDateInput, tjToday } from '../lib/tjTime';

/**
 * «Финансы → Расход → статья» (часть 2, 10.11.2026): Аренда и подписки,
 * Долги и кредиты, Комиссии партнёрам, Прочее. Зарплата — своя страница.
 */

type Kind = 'salary' | 'rent' | 'debts' | 'partners' | 'other';
const KINDS: Kind[] = ['salary', 'rent', 'debts', 'partners', 'other'];
const CURRENCIES = ['TJS', 'USD', 'EUR', 'CNY', 'RUB'];

function day(d: string | null): string {
  if (!d) return '—';
  return fmtDateText(`${tjDateInput(d)}T00:00:00Z`, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function useCan() {
  const me = useAuth((s) => s.user);
  return {
    manage: roleCan(me, 'finance:update', isElevated(me)),
    pay: roleCan(me, 'finance:create', hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT')),
    remove: roleCan(me, 'finance:delete', isElevated(me)),
  };
}

/** Список оплат с «отменить» — отмена = удаление операции (деньги возвращаются на счёт). */
function Payments({ items, currency, canRemove }: { items: ExpensePaymentRef[]; currency: string; canRemove: boolean }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  if (!items.length) return null;
  const cancel = async (p: ExpensePaymentRef) => {
    const ok = await confirm({
      title: t('finance.exp.cancelQ'),
      message: t('finance.exp.cancelMsg').replace('{sum}', fmtMoney(p.amount, currency)).replace('{date}', day(p.date)).replace('{acc}', p.account?.name ?? '—'),
      danger: true,
      confirmText: t('finance.exp.cancelBtn'),
    });
    if (!ok) return;
    try {
      await deleteTransaction(p.id);
      toast(t('finance.exp.cancelled'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };
  return (
    <ul className="exp-pays">
      {items.map((p) => (
        <li key={p.id} data-testid={`exp-payment-${p.id}`}>
          <span>✓ {day(p.date)}{p.account ? ` · ${p.account.name}` : ''}</span>
          <b className="fin-num">{fmtMoney(p.amount, currency)}</b>
          {canRemove && (
            <button type="button" className="fin-link exp-cancel" onClick={() => cancel(p)} data-testid="exp-payment-cancel">{t('finance.exp.cancel')}</button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function FinanceExpenseGroup() {
  const { kind } = useParams<{ kind: string }>();
  const { t } = useT();
  const qc = useQueryClient();
  const [ym, setYm] = useYmParam();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      qc.invalidateQueries({ queryKey: keys.finance.all });
    }, 400);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useRealtime({ 'transaction:new': refresh, 'transaction:updated': refresh, 'transaction:deleted': refresh, 'transaction:reversed': refresh, 'finance:accounts': refresh });
  // Зарплата без месяца в ссылке — основной открытый месяц (прошлый, пока не закрыт).
  const [params] = useSearchParams();
  const needDefault = kind === 'salary' && !params.get('ym');
  const defQ = useQuery({ queryKey: keys.finance.expense('payroll', 'default'), queryFn: () => getPayroll(), enabled: needDefault });
  useEffect(() => {
    if (needDefault && defQ.data?.ym) setYm(defQ.data.ym);
  }, [needDefault, defQ.data?.ym]);
  if (!KINDS.includes(kind as Kind)) return <Navigate to="/finance/expense" replace />;
  const k = kind as Kind;
  const meta = EXPENSE_GROUP_META.find((g) => g.key === k)!;
  return (
    <>
      <FinanceSubnav />
      <Link to={`/finance/expense?ym=${ym}`} className="exp-back" data-testid="exp-back">‹ {t('finance.exp.title')}</Link>
      <div className="fin-toolbar">
        <h2 className="exp-group-title" style={{ ['--grp' as any]: meta.color }} data-testid="exp-group-title">
          <span className="inc-dir-icon exp-icon" aria-hidden="true"><Icon name={meta.icon} size={20} /></span>
          {t(`finance.exp.g.${k}`)}
        </h2>
        <MonthNav ym={ym} onChange={setYm} />
      </div>
      {k === 'salary' && (needDefault ? <div className="fin-card"><p className="fin-empty-line">{t('common.loading')}</p></div> : <PayrollSection ym={ym} onYm={setYm} />)}
      {k === 'rent' && <RentSection ym={ym} />}
      {k === 'debts' && <DebtsSection ym={ym} />}
      {k === 'partners' && <PartnersSection ym={ym} />}
      {k === 'other' && <OtherSection ym={ym} />}
    </>
  );
}

// ═════════ Аренда и подписки ═════════
function RentSection({ ym }: { ym: string }) {
  const { t } = useT();
  const { toast } = useUI();
  const can = useCan();
  const monthIn = useMonthIn();
  const narrow = useMediaQuery('(max-width: 720px)');
  const q = useQuery({ queryKey: keys.finance.expense('subscriptions', ym), queryFn: () => getSubscriptions(ym), placeholderData: keepPreviousData });
  const [edit, setEdit] = useState<SubscriptionRow | 'new' | null>(null);
  const [pay, setPay] = useState<SubscriptionRow | null>(null);
  const d = q.data;
  const status = (r: SubscriptionRow) => {
    if (!r.active) return <span className="exp-chip">{r.archived ? t('finance.exp.archived') : t('finance.exp.notActive')}</span>;
    if (r.status === 'paid') return <span className="exp-chip is-ok">✓ {t('finance.exp.paid')} {day(r.payments[r.payments.length - 1]?.date ?? null)}</span>;
    if (r.status === 'partial') return <span className="exp-chip is-warn">{t('finance.exp.partial').replace('{paid}', fmtMoney(r.paid, r.currency)).replace('{left}', fmtMoney(r.left, r.currency))}</span>;
    return <span className="exp-chip is-bad">{t('finance.exp.notPaid')}</span>;
  };
  const actions = (r: SubscriptionRow) => (
    <div className="exp-actions">
      {can.pay && r.active && r.left > 0.005 && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setPay(r)} data-testid="exp-sub-pay">
          {r.paid > 0 ? t('finance.exp.payMore') : t('finance.exp.pay')}
        </button>
      )}
      {can.manage && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEdit(r)} data-testid="exp-sub-edit" aria-label={t('common.edit')}>
          <Icon name="edit" size={16} />
        </button>
      )}
    </div>
  );
  return (
    <>
      <div className="inc-tiles fin-block">
        <div className="inc-tile" data-testid="exp-rent-monthly">
          <span className="inc-tile-label">{t('finance.exp.rentMonthly')}</span>
          <span className="inc-tile-value fin-num">{fmtMoney(d?.monthly.tjs ?? 0)}</span>
        </div>
        <div className="inc-tile" data-testid="exp-rent-topay">
          <span className="inc-tile-label">{t('finance.exp.leftIn').replace('{month}', monthIn(ym))}</span>
          <span className="inc-tile-value fin-num is-out">{fmtMoney(d?.toPay.tjs ?? 0)}</span>
        </div>
        {can.manage && (
          <button type="button" className="inc-tile exp-add-tile" onClick={() => setEdit('new')} data-testid="exp-sub-new">
            <Icon name="add" size={22} /> {t('finance.exp.newSub')}
          </button>
        )}
      </div>
      <section className="fin-card fin-block" data-testid="exp-subs">
        {!d ? (
          <p className="fin-empty-line">{t('common.loading')}</p>
        ) : d.rows.length === 0 ? (
          <p className="fin-empty-line" data-testid="exp-subs-empty">{t('finance.exp.subsEmpty')}</p>
        ) : narrow ? (
          <div className="inc-cards">
            {d.rows.map((r) => (
              <article key={r.id} className={`inc-card${r.active ? '' : ' is-muted'}`} data-testid={`exp-sub-${r.id}`}>
                <div className="inc-card-top"><b>{r.name}</b><span className="fin-num">{fmtMoney(r.amount, r.currency)}</span></div>
                <div className="fin-muted-line">{t(`finance.exp.subKind.${r.kind}`)}{r.payDay ? ` · ${t('finance.exp.payDayN').replace('{n}', String(r.payDay))}` : ''}</div>
                <div>{status(r)}</div>
                <Payments items={r.payments} currency={r.currency} canRemove={can.remove} />
                {actions(r)}
              </article>
            ))}
          </div>
        ) : (
          <div className="fin-table-wrap">
            <table className="table" data-testid="exp-subs-table">
              <thead>
                <tr>
                  <th>{t('finance.exp.colItem')}</th>
                  <th>{t('finance.exp.colKind')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.exp.colMonthly')}</th>
                  <th>{t('finance.exp.colPayDay')}</th>
                  <th>{t('finance.exp.colStatus')}</th>
                  <th><span className="sr-only">{t('common.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id} className={r.active ? '' : 'is-muted'} data-testid={`exp-sub-${r.id}`}>
                    <td><b>{r.name}</b>{r.note && <div className="fin-muted-line">{r.note}</div>}</td>
                    <td>{t(`finance.exp.subKind.${r.kind}`)}</td>
                    <td className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(r.amount, r.currency)}</td>
                    <td>{r.payDay ? t('finance.exp.payDayN').replace('{n}', String(r.payDay)) : '—'}</td>
                    <td>{status(r)}<Payments items={r.payments} currency={r.currency} canRemove={can.remove} /></td>
                    <td>{actions(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d && d.hidden > 0 && <p className="fin-muted-line">{t('finance.exp.hiddenSubs').replace('{n}', String(d.hidden))}</p>}
      </section>
      <AnimatePresence>
        {edit && <SubscriptionModal key={edit === 'new' ? 'new' : edit.id} row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
        {pay && (
          <ExpensePayModal
            key={pay.id}
            title={t('finance.exp.payTitle').replace('{name}', pay.name)}
            summary={<>{t('finance.exp.accrued').replace('{month}', monthLabel(ym).toLowerCase())} <b>{fmtMoney(pay.amount, pay.currency)}</b>{pay.paid > 0 && <> · {t('finance.exp.alreadyPaid')} {fmtMoney(pay.paid, pay.currency)}</>} · {t('finance.exp.left')} <b>{fmtMoney(pay.left, pay.currency)}</b></>}
            currency={pay.currency}
            defaultAmount={pay.left}
            maxAmount={pay.left}
            category={pay.kind === 'RENT' ? 'RENT' : 'SUBSCRIPTION'}
            link={{ subscriptionId: pay.id }}
            defaultAccountId={pay.account?.id}
            commentPrefix={pay.name}
            onClose={() => setPay(null)}
            onDone={(a) => { toast(t('finance.exp.paidToast').replace('{name}', pay.name).replace('{sum}', fmtMoney(a, pay.currency)), 'success'); setPay(null); }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function AccountPick({ value, onChange, currency, testId }: { value: string; onChange: (v: string) => void; currency: string; testId: string }) {
  const { t } = useT();
  const q = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts });
  const opts = (q.data?.accounts ?? []).filter((a) => !a.archived && a.currency === currency);
  return (
    <CrmSelect className="crm-select" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
      <option value="">{t('finance.exp.noDefaultAccount')}</option>
      {opts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </CrmSelect>
  );
}

function SubscriptionModal({ row, onClose }: { row: SubscriptionRow | null; onClose: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const [name, setName] = useState(row?.name ?? '');
  const [kind, setKind] = useState<'RENT' | 'SUBSCRIPTION'>(row?.kind ?? 'SUBSCRIPTION');
  const [amount, setAmount] = useState(row ? String(row.amount) : '');
  const [currency, setCurrency] = useState(row?.currency ?? 'TJS');
  const [payDay, setPayDay] = useState(row?.payDay ? String(row.payDay) : '');
  const [startYm, setStartYm] = useState(row?.startYm ?? currentYm());
  const [endYm, setEndYm] = useState(row?.endYm ?? '');
  const [accountId, setAccountId] = useState(row?.account?.id ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (extra?: SubscriptionInput) => {
    setErr('');
    const dto: SubscriptionInput = extra ?? {
      name: name.trim(), kind, amount: parseAmount(amount), currency, payDay: payDay ? Number(payDay) : null,
      startYm, endYm: endYm || null, accountId: accountId || null, note: note.trim() || null,
    };
    if (!extra) {
      if (!dto.name) return setErr(t('finance.exp.errName'));
      if (!(dto.amount! > 0)) return setErr(t('finance.err.amountPositive'));
    }
    setBusy(true);
    try {
      if (row) await updateSubscription(row.id, dto);
      else await createSubscription(dto);
      toast(t('toast.saved'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open title={row ? row.name : t('finance.exp.newSub')} onClose={onClose} dirty={!row && !!(name || amount)} busy={busy} width={560} testId="exp-sub-modal">
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="form-grid-2">
          <div className="form-group form-span-2">
            <label>{t('finance.exp.fName')}</label>
            <input className="crm-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t('finance.exp.fNamePh')} data-testid="exp-sub-name" />
          </div>
          <div className="form-group">
            <label>{t('finance.exp.colKind')}</label>
            <CrmSelect className="crm-select" value={kind} onChange={(e) => setKind(e.target.value as any)} data-testid="exp-sub-kind">
              <option value="RENT">{t('finance.exp.subKind.RENT')}</option>
              <option value="SUBSCRIPTION">{t('finance.exp.subKind.SUBSCRIPTION')}</option>
            </CrmSelect>
          </div>
          <div className="form-group">
            <label>{t('finance.exp.fPayDay')}</label>
            <input className="crm-input" inputMode="numeric" value={payDay} onChange={(e) => setPayDay(e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="10" data-testid="exp-sub-payday" />
          </div>
          <div className="form-group">
            <label>{t('finance.exp.colMonthly')}</label>
            <input className="crm-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" data-testid="exp-sub-amount" />
          </div>
          <div className="form-group">
            <label>{t('finance.col.currency')}</label>
            <CrmSelect className="crm-select" value={currency} onChange={(e) => { setCurrency(e.target.value); setAccountId(''); }} data-testid="exp-sub-currency">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </CrmSelect>
          </div>
          <div className="form-group">
            <label>{t('finance.exp.fStart')}</label>
            <input className="crm-input" type="month" value={startYm} onChange={(e) => setStartYm(e.target.value)} data-testid="exp-sub-start" />
          </div>
          <div className="form-group">
            <label>{t('finance.exp.fEnd')}</label>
            <input className="crm-input" type="month" value={endYm} onChange={(e) => setEndYm(e.target.value)} data-testid="exp-sub-end" />
          </div>
          <div className="form-group form-span-2">
            <label>{t('finance.exp.fAccount')}</label>
            <AccountPick value={accountId} onChange={setAccountId} currency={currency} testId="exp-sub-account" />
          </div>
          <div className="form-group form-span-2">
            <label>{t('finance.exp.fNote')}</label>
            <input className="crm-input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} data-testid="exp-sub-note" />
          </div>
          <p className="form-hint form-span-2">{t('finance.exp.subHint')}</p>
        </div>
        {err && <div className="form-error-text" role="alert" data-testid="exp-sub-error">{err}</div>}
        <div className="form-actions">
          {row && (
            <button type="button" className="btn btn-secondary" style={{ marginRight: 'auto' }} onClick={() => save({ archived: !row.archived })} disabled={busy} data-testid="exp-sub-archive">
              {row.archived ? t('finance.acc.unarchive') : t('finance.acc.archive')}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="exp-sub-save">{t('common.save')}</button>
        </div>
      </form>
    </FormModal>
  );
}

// ═════════ Долги и кредиты ═════════
function DebtsSection({ ym }: { ym: string }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const can = useCan();
  const monthIn = useMonthIn();
  const q = useQuery({ queryKey: keys.finance.expense('debts', ym), queryFn: () => getDebts(ym), placeholderData: keepPreviousData });
  const [edit, setEdit] = useState<DebtRow | 'new' | null>(null);
  const [pay, setPay] = useState<DebtRow | null>(null);
  const d = q.data;
  const remove = async (r: DebtRow) => {
    const ok = await confirm({ title: t('finance.exp.debtDeleteQ').replace('{name}', r.name), message: t('finance.exp.debtDeleteMsg'), danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    try {
      await deleteDebt(r.id);
      toast(t('finance.exp.debtDeleted'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };
  const rows = d ? [...d.rows.filter((r) => !r.closed), ...d.rows.filter((r) => r.closed)] : [];
  return (
    <>
      <div className="inc-tiles fin-block">
        <div className="inc-tile" data-testid="exp-debts-remaining">
          <span className="inc-tile-label">{t('finance.exp.debtsRemaining')}</span>
          <span className="inc-tile-value fin-num is-out">{fmtMoney(d?.stats.remaining.tjs ?? 0)}</span>
        </div>
        <div className="inc-tile" data-testid="exp-debts-due">
          <span className="inc-tile-label">{t('finance.exp.dueIn').replace('{month}', monthIn(ym))}</span>
          <span className="inc-tile-value fin-num">{fmtMoney(d?.stats.dueMonth.tjs ?? 0)}</span>
        </div>
        <div className="inc-tile" data-testid="exp-debts-paid">
          <span className="inc-tile-label">{t('finance.exp.paidIn').replace('{month}', monthIn(ym))}</span>
          <span className="inc-tile-value fin-num is-in">{fmtMoney(d?.stats.paidMonth.tjs ?? 0)}</span>
        </div>
      </div>
      <div className="fin-toolbar">
        <span className="fin-muted-line inc-lead">{t('finance.exp.debtsLead')}</span>
        {can.manage && (
          <button type="button" className="btn btn-primary" onClick={() => setEdit('new')} data-testid="exp-debt-new">
            <Icon name="add" size={18} /> {t('finance.exp.newDebt')}
          </button>
        )}
      </div>
      {!d ? (
        <div className="fin-card"><p className="fin-empty-line">{t('common.loading')}</p></div>
      ) : rows.length === 0 ? (
        <div className="fin-card"><p className="fin-empty-line" data-testid="exp-debts-empty">{t('finance.exp.debtsEmpty')}</p></div>
      ) : (
        <div className="exp-debts fin-block">
          {rows.map((r) => {
            const paid = r.total - r.left;
            const chip = r.closed
              ? <span className="exp-chip is-ok">{t('finance.exp.closed')}</span>
              : r.late
                ? <span className="exp-chip is-bad">{t('finance.exp.late')}</span>
                : r.dueDate
                  ? <span className="exp-chip">{t('finance.exp.dueBy').replace('{date}', day(r.dueDate))}</span>
                  : r.monthlyAmount
                    ? <span className="exp-chip">{t('finance.exp.perMonth').replace('{sum}', fmtMoney(r.monthlyAmount, r.currency))}</span>
                    : <span className="exp-chip">{t('finance.exp.noDate')}</span>;
            return (
              <article key={r.id} className={`fin-card exp-debt${r.closed ? ' is-closed' : ''}${r.late ? ' is-late' : ''}`} data-testid={`exp-debt-${r.id}`}>
                <div className="exp-debt-head">
                  <span className="exp-debt-mark" aria-hidden="true">{r.name.slice(0, 1).toUpperCase()}</span>
                  <div className="exp-debt-who">
                    <b>{r.name}</b>
                    <span className="fin-muted-line">{t(`finance.exp.debtKind.${r.kind}`)}{r.note ? ` · ${r.note}` : ''}</span>
                  </div>
                  {chip}
                </div>
                <div className="exp-debt-left">
                  <span>{r.closed ? t('finance.exp.gaveBack') : t('finance.exp.leftToGive')} <b className="fin-num" data-testid="exp-debt-left">{fmtMoney(r.closed ? r.total : r.left, r.currency)}</b></span>
                  <span className="fin-muted-line">{t('finance.exp.gaveOf').replace('{a}', fmtMoney(paid, r.currency)).replace('{b}', fmtMoney(r.total, r.currency))}</span>
                </div>
                <span className="exp-bar" aria-hidden="true"><span style={{ width: `${r.total > 0 ? Math.min(100, Math.round((paid / r.total) * 100)) : 0}%` }} /></span>
                {!r.closed && r.nextDate && (
                  <div className="fin-muted-line" data-testid="exp-debt-next">{t('finance.exp.nextPay').replace('{date}', day(r.nextDate)).replace('{sum}', fmtMoney(r.nextAmount ?? 0, r.currency))}</div>
                )}
                {r.overdue > 0.005 && <div className="exp-chip is-bad">{t('finance.exp.overdueSum').replace('{sum}', fmtMoney(r.overdue, r.currency))}</div>}
                {r.paidBefore > 0 && <div className="fin-muted-line">{t('finance.exp.paidBefore').replace('{sum}', fmtMoney(r.paidBefore, r.currency))}</div>}
                <Payments items={r.payments} currency={r.currency} canRemove={can.remove} />
                <div className="exp-actions">
                  {can.pay && !r.closed && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => setPay(r)} data-testid="exp-debt-pay">{t('finance.exp.give')}</button>
                  )}
                  {can.manage && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEdit(r)} data-testid="exp-debt-edit">{t('common.edit')}</button>}
                  {can.manage && <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(r)} data-testid="exp-debt-delete" aria-label={t('common.delete')}><Icon name="delete" size={16} /></button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <AnimatePresence>
        {edit && <DebtModal key={edit === 'new' ? 'new' : edit.id} row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
        {pay && (
          <ExpensePayModal
            key={pay.id}
            title={t('finance.exp.giveTitle').replace('{name}', pay.name)}
            summary={<>{t('finance.exp.leftToGive')} <b>{fmtMoney(pay.left, pay.currency)}</b>{pay.dueMonth > 0.005 && <> · {t('finance.exp.dueIn').replace('{month}', monthIn(ym)).toLowerCase()} {fmtMoney(pay.dueMonth, pay.currency)}</>}</>}
            currency={pay.currency}
            defaultAmount={pay.dueMonth > 0.005 ? pay.dueMonth : pay.nextAmount ?? pay.left}
            maxAmount={pay.left}
            category="LOAN_PAYMENT"
            link={{ debtId: pay.id }}
            defaultAccountId={pay.account?.id}
            commentPrefix={pay.name}
            testId="exp-debt-pay-modal"
            onClose={() => setPay(null)}
            onDone={(a) => {
              toast(a >= pay.left - 0.005 ? t('finance.exp.debtClosedToast').replace('{name}', pay.name) : t('finance.exp.gaveToast').replace('{sum}', fmtMoney(a, pay.currency)), 'success');
              setPay(null);
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function DebtModal({ row, onClose }: { row: DebtRow | null; onClose: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const [name, setName] = useState(row?.name ?? '');
  const [kind, setKind] = useState<'BANK' | 'PERSON'>(row?.kind ?? 'PERSON');
  const [total, setTotal] = useState(row ? String(row.total) : '');
  const [currency, setCurrency] = useState(row?.currency ?? 'TJS');
  const [paidBefore, setPaidBefore] = useState(row?.paidBefore ? String(row.paidBefore) : '');
  const [mode, setMode] = useState<'monthly' | 'due' | 'free'>(row?.monthlyAmount ? 'monthly' : row?.dueDate ? 'due' : 'free');
  const [monthly, setMonthly] = useState(row?.monthlyAmount ? String(row.monthlyAmount) : '');
  const [payDay, setPayDay] = useState(row?.payDay ? String(row.payDay) : '');
  const [startYm, setStartYm] = useState(row?.startYm ?? currentYm());
  const [dueDate, setDueDate] = useState(row?.dueDate ?? '');
  const [accountId, setAccountId] = useState(row?.account?.id ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    const dto: DebtInput = {
      name: name.trim(), kind, total: parseAmount(total), currency, paidBefore: paidBefore ? parseAmount(paidBefore) : 0,
      monthlyAmount: mode === 'monthly' ? parseAmount(monthly) : null,
      payDay: mode === 'monthly' && payDay ? Number(payDay) : null,
      startYm: mode === 'monthly' ? startYm : null,
      dueDate: mode === 'due' ? dueDate || null : null,
      accountId: accountId || null, note: note.trim() || null,
    };
    if (!dto.name) return setErr(t('finance.exp.errWho'));
    if (!(dto.total! > 0)) return setErr(t('finance.err.amountPositive'));
    if (mode === 'monthly' && !(dto.monthlyAmount! > 0)) return setErr(t('finance.exp.errMonthly'));
    if (mode === 'due' && !dto.dueDate) return setErr(t('finance.exp.errDue'));
    setBusy(true);
    try {
      if (row) await updateDebt(row.id, dto);
      else await createDebt(dto);
      toast(t('toast.saved'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open title={row ? row.name : t('finance.exp.newDebt')} onClose={onClose} dirty={!row && !!(name || total)} busy={busy} width={580} testId="exp-debt-modal">
      <form onSubmit={submit}>
        <div className="form-grid-2">
          <div className="form-group">
            <label>{t('finance.exp.fWho')}</label>
            <input className="crm-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t('finance.exp.fWhoPh')} data-testid="exp-debt-name" />
          </div>
          <div className="form-group">
            <label>{t('finance.exp.colKind')}</label>
            <CrmSelect className="crm-select" value={kind} onChange={(e) => setKind(e.target.value as any)} data-testid="exp-debt-kind">
              <option value="PERSON">{t('finance.exp.debtKind.PERSON')}</option>
              <option value="BANK">{t('finance.exp.debtKind.BANK')}</option>
            </CrmSelect>
          </div>
          <div className="form-group">
            <label>{t('finance.exp.fTotal')}</label>
            <input className="crm-input" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0" data-testid="exp-debt-total" />
          </div>
          <div className="form-group">
            <label>{t('finance.col.currency')}</label>
            <CrmSelect className="crm-select" value={currency} onChange={(e) => { setCurrency(e.target.value); setAccountId(''); }} data-testid="exp-debt-currency">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </CrmSelect>
          </div>
          <div className="form-group form-span-2">
            <label>{t('finance.exp.fPaidBefore')}</label>
            <input className="crm-input" inputMode="decimal" value={paidBefore} onChange={(e) => setPaidBefore(e.target.value)} placeholder="0" data-testid="exp-debt-paidbefore" />
          </div>
          <div className="form-group form-span-2">
            <label>{t('finance.exp.fHow')}</label>
            <div className="exp-proof-tabs" role="radiogroup">
              {(['monthly', 'due', 'free'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'is-active' : ''} onClick={() => setMode(m)} data-testid={`exp-debt-mode-${m}`}>
                  {t(`finance.exp.how.${m}`)}
                </button>
              ))}
            </div>
          </div>
          {mode === 'monthly' && (
            <>
              <div className="form-group">
                <label>{t('finance.exp.fMonthly')}</label>
                <input className="crm-input" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="0" data-testid="exp-debt-monthly" />
              </div>
              <div className="form-group">
                <label>{t('finance.exp.fPayDay')}</label>
                <input className="crm-input" inputMode="numeric" value={payDay} onChange={(e) => setPayDay(e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="10" data-testid="exp-debt-payday" />
              </div>
              <div className="form-group form-span-2">
                <label>{t('finance.exp.fFromMonth')}</label>
                <input className="crm-input" type="month" value={startYm} onChange={(e) => setStartYm(e.target.value)} data-testid="exp-debt-start" />
              </div>
            </>
          )}
          {mode === 'due' && (
            <div className="form-group form-span-2">
              <label>{t('finance.exp.fDue')}</label>
              <CrmDatePicker className="crm-input" value={dueDate} onChange={(v) => setDueDate(v)} />
            </div>
          )}
          <div className="form-group form-span-2">
            <label>{t('finance.exp.fAccount')}</label>
            <AccountPick value={accountId} onChange={setAccountId} currency={currency} testId="exp-debt-account" />
          </div>
          <div className="form-group form-span-2">
            <label>{t('finance.exp.fFor')}</label>
            <input className="crm-input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} data-testid="exp-debt-note" />
          </div>
          {row && row.paidTotal > 0 && <p className="form-hint form-span-2">{t('finance.exp.alreadyGave').replace('{sum}', fmtMoney(row.paidTotal, row.currency)).replace('{left}', fmtMoney(row.left, row.currency))}</p>}
        </div>
        {err && <div className="form-error-text" role="alert" data-testid="exp-debt-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="exp-debt-save">{t('common.save')}</button>
        </div>
      </form>
    </FormModal>
  );
}

// ═════════ Комиссии партнёрам ═════════
function PartnersSection({ ym }: { ym: string }) {
  const { t } = useT();
  const can = useCan();
  const monthIn = useMonthIn();
  const q = useQuery({ queryKey: keys.finance.expense('partners', ym), queryFn: () => getPartnersBoard(ym), placeholderData: keepPreviousData });
  const [pay, setPay] = useState<PartnersBoard['requests'][number] | null>(null);
  const d = q.data;
  return (
    <>
      <div className="inc-tiles fin-block">
        <div className="inc-tile" data-testid="exp-partners-waiting">
          <span className="inc-tile-label">{t('finance.exp.partnersWaiting')}</span>
          <span className="inc-tile-value fin-num is-out">{fmtMoney(d?.waiting ?? 0)}</span>
          <span className="inc-tile-sub">{t('finance.exp.partnersSplit').replace('{bal}', fmtMoney(d?.balance ?? 0)).replace('{req}', fmtMoney(d?.requested ?? 0))}</span>
        </div>
        <div className="inc-tile" data-testid="exp-partners-requests">
          <span className="inc-tile-label">{t('finance.exp.requests')}</span>
          <span className="inc-tile-value fin-num">{d?.requests.length ?? 0}</span>
        </div>
        <div className="inc-tile" data-testid="exp-partners-paid">
          <span className="inc-tile-label">{t('finance.exp.paidListTitle').replace('{month}', monthIn(ym))}</span>
          <span className="inc-tile-value fin-num is-in">{fmtMoney(d?.paidMonth.tjs ?? 0)}</span>
        </div>
      </div>
      <section className="fin-card fin-block" data-testid="exp-requests">
        <h2 className="fin-card-title">{t('finance.exp.requestsTitle')}</h2>
        {!d ? <p className="fin-empty-line">{t('common.loading')}</p> : d.requests.length === 0 ? (
          <p className="fin-empty-line" data-testid="exp-requests-empty">{t('finance.exp.requestsEmpty')}</p>
        ) : (
          <div className="fin-table-wrap">
            <table className="table fin-recent-table">
              <thead><tr><th>{t('finance.exp.colPartner')}</th><th style={{ textAlign: 'right' }}>{t('common.amount')}</th><th>{t('finance.exp.colMethod')}</th><th>{t('finance.exp.colRequested')}</th><th /></tr></thead>
              <tbody>
                {d.requests.map((r) => (
                  <tr key={r.id} data-testid={`exp-request-${r.id}`}>
                    <td data-label={t('finance.exp.colPartner')}><Link to={`/partners/${r.partner.id}`}>{r.partner.name}</Link></td>
                    <td data-label={t('common.amount')} className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(r.amount, r.currency)}</td>
                    <td data-label={t('finance.exp.colMethod')} className="fin-muted-line">{[r.method, r.details].filter(Boolean).join(' · ') || '—'}</td>
                    <td data-label={t('finance.exp.colRequested')}>{day(r.requestedAt)}</td>
                    <td>{can.pay && <button type="button" className="btn btn-primary btn-sm" onClick={() => setPay(r)} data-testid="exp-payout-pay">{t('finance.exp.payout')}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="fin-card fin-block" data-testid="exp-balances">
        <h2 className="fin-card-title">{t('finance.exp.balancesTitle')}</h2>
        <p className="fin-muted-line">{t('finance.exp.balancesHint')}</p>
        {d && d.partners.length > 0 ? (
          <div className="fin-table-wrap">
            <table className="table fin-recent-table">
              <thead><tr><th>{t('finance.exp.colPartner')}</th><th style={{ textAlign: 'right' }}>{t('finance.exp.colBalance')}</th><th style={{ textAlign: 'right' }}>{t('finance.exp.colReq')}</th><th style={{ textAlign: 'right' }}>{t('finance.exp.colPaidTotal')}</th></tr></thead>
              <tbody>
                {d.partners.map((p) => (
                  <tr key={p.id}>
                    <td data-label={t('finance.exp.colPartner')}><Link to={`/partners/${p.id}`}>{p.name}</Link></td>
                    <td data-label={t('finance.exp.colBalance')} className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(p.balance)}</td>
                    <td data-label={t('finance.exp.colReq')} className="fin-num" style={{ textAlign: 'right' }}>{p.requested ? fmtMoney(p.requested) : '—'}</td>
                    <td data-label={t('finance.exp.colPaidTotal')} className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(p.paidTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : d ? <p className="fin-empty-line">{t('finance.exp.balancesEmpty')}</p> : null}
      </section>
      {d && d.payments.length > 0 && (
        <section className="fin-card fin-block" data-testid="exp-partner-payments">
          <h2 className="fin-card-title">{t('finance.exp.paidListTitle').replace('{month}', monthIn(ym))}</h2>
          <ul className="exp-pays">
            {d.payments.map((p) => (
              <li key={p.id}><span>✓ {day(p.date)} · {p.comment}{p.account ? ` · ${p.account.name}` : ''}</span><b className="fin-num">{fmtMoney(p.amount, p.currency)}</b></li>
            ))}
          </ul>
        </section>
      )}
      <AnimatePresence>{pay && <PayoutModal key={pay.id} req={pay} onClose={() => setPay(null)} />}</AnimatePresence>
    </>
  );
}

function PayoutModal({ req, onClose }: { req: PartnersBoard['requests'][number]; onClose: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts });
  const options = useMemo(() => (accountsQ.data?.accounts ?? []).filter((a) => !a.archived && a.currency === req.currency), [accountsQ.data, req.currency]);
  const [accountId, setAccountId] = useState('');
  const acc = options.find((a) => a.id === accountId) ?? options[0] ?? null;
  const [date, setDate] = useState(tjToday());
  const [receipt, setReceipt] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acc) return setErr(t('finance.exp.errAccount'));
    setBusy(true);
    try {
      await payPartnerPayout(req.id, { accountId: acc.id, date, ...(receipt && { receiptUrl: receipt }) });
      toast(t('finance.exp.payoutDone').replace('{name}', req.partner.name), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open title={t('finance.exp.payoutTitle').replace('{name}', req.partner.name)} onClose={onClose} dirty={false} busy={busy} width={480} testId="exp-payout-modal">
      <form onSubmit={submit}>
        <p className="exp-pay-summary">{t('finance.exp.payoutSum')} <b>{fmtMoney(req.amount, req.currency)}</b>{req.details ? ` · ${req.details}` : ''}</p>
        {options.length === 0 ? (
          <p className="fin-warn-line"><Icon name="info" size={18} />{t('finance.exp.noAccounts').replace('{cur}', req.currency)}</p>
        ) : (
          <div className="form-grid-2">
            <div className="form-group form-span-2">
              <label>{t('finance.exp.fromAccount')}</label>
              <CrmSelect className="crm-select" value={acc?.id ?? ''} onChange={(e) => setAccountId(e.target.value)} data-testid="exp-payout-account">
                {options.map((o) => <option key={o.id} value={o.id}>{o.name} · {fmtMoney(o.balance, o.currency)}</option>)}
              </CrmSelect>
            </div>
            <div className="form-group">
              <label>{t('finance.exp.payDate')}</label>
              <CrmDatePicker className="crm-input" value={date} max={tjToday()} onChange={(v) => v && setDate(v)} />
            </div>
            <div className="form-group">
              <label>{t('finance.inc.receipt')}</label>
              <label className="btn btn-secondary btn-sm">
                <Icon name="attach_file" size={16} /> {receipt ? '✓' : t('finance.inc.attach')}
                <input type="file" accept="image/*,application/pdf" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { try { setReceipt((await uploadReceipt(f)).url); } catch { /* тост ниже не нужен */ } } }} />
              </label>
            </div>
            <p className="form-hint form-span-2">{t('finance.exp.payoutHint')}</p>
          </div>
        )}
        {err && <div className="form-error-text" role="alert">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || options.length === 0} data-testid="exp-payout-save">{t('finance.exp.payoutBtn').replace('{sum}', fmtMoney(req.amount, req.currency))}</button>
        </div>
      </form>
    </FormModal>
  );
}

// ═════════ Прочее ═════════
function OtherSection({ ym }: { ym: string }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const can = useCan();
  const monthIn = useMonthIn();
  const q = useQuery({ queryKey: keys.finance.expense('other', ym), queryFn: () => getOtherExpense(ym), placeholderData: keepPreviousData });
  const [add, setAdd] = useState(false);
  const d = q.data;
  const cur = currentYm();
  const savePlan = async (m: string, raw: string) => {
    const v = raw.trim() === '' ? null : parseAmount(raw);
    if (v !== null && !(v >= 0)) return toast(t('finance.acc.errNumber'), 'error');
    try {
      await setOtherPlan({ ym: m, amount: v });
      toast(t('finance.exp.planSaved'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };
  const max = Math.max(1, ...(d?.byCategory ?? []).map((c) => c.tjs));
  return (
    <>
      <div className="inc-tiles fin-block">
        <div className="inc-tile" data-testid="exp-other-spent">
          <span className="inc-tile-label">{t('finance.exp.spentIn').replace('{month}', monthIn(ym))}</span>
          <span className="inc-tile-value fin-num is-out">{fmtMoney(d?.spent.tjs ?? 0)}</span>
        </div>
        <div className="inc-tile" data-testid="exp-other-plan">
          <span className="inc-tile-label">{t('finance.exp.planFor').replace('{month}', monthLabel(ym).toLowerCase())}</span>
          <span className="inc-tile-value fin-num">{d ? `${d.planSource === 'avg' ? '≈ ' : ''}${fmtMoney(d.plan)}` : '…'}</span>
          <span className="inc-tile-sub">{d?.planSource === 'own' ? t('finance.exp.planOwnHint') : t('finance.exp.planAvgHint')}</span>
        </div>
        <div className="inc-tile" data-testid="exp-other-avg">
          <span className="inc-tile-label">{t('finance.exp.avg')}</span>
          <span className="inc-tile-value fin-num">{fmtMoney(d?.average.avg ?? 0)}</span>
          <span className="inc-tile-sub">{d?.average.from ? `${monthLabel(d.average.from).toLowerCase()} — ${monthLabel(d.average.to!).toLowerCase()}` : t('finance.exp.noHistory')}</span>
        </div>
      </div>
      <section className="fin-card fin-block" data-testid="exp-other-cats">
        <div className="fin-card-head">
          <h2 className="fin-card-title">{t('finance.exp.byCategory')}</h2>
          {can.pay && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdd(true)} data-testid="exp-other-add">
              <Icon name="add" size={16} /> {t('finance.exp.addExpense')}
            </button>
          )}
        </div>
        {!d ? <p className="fin-empty-line">{t('common.loading')}</p> : d.byCategory.length === 0 ? (
          <p className="fin-empty-line" data-testid="exp-other-empty">{t('finance.exp.otherEmpty').replace('{month}', monthIn(ym))}</p>
        ) : (
          <div className="exp-catbars">
            {d.byCategory.map((c) => (
              <div key={c.category} className="exp-catbar" data-testid={`exp-cat-${c.category}`}>
                <span>{TRANSACTION_CATEGORY_LABEL[c.category] ?? c.category} <span className="fin-muted-line">· {c.count}</span></span>
                <span className="exp-catbar-track"><span style={{ width: `${Math.round((c.tjs / max) * 100)}%` }} /></span>
                <b className="fin-num">{fmtMoney(c.tjs)}</b>
              </div>
            ))}
          </div>
        )}
        {d && d.rows.length > 0 && (
          <div className="fin-table-wrap">
            <table className="table fin-recent-table" data-testid="exp-other-rows">
              <thead><tr><th>{t('common.date')}</th><th>{t('finance.col.category')}</th><th>{t('common.comment')}</th><th>{t('finance.acc.field')}</th><th style={{ textAlign: 'right' }}>{t('common.amount')}</th></tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t('common.date')} style={{ whiteSpace: 'nowrap' }}>{day(r.date)}</td>
                    <td data-label={t('finance.col.category')}>{TRANSACTION_CATEGORY_LABEL[r.category] ?? r.category}</td>
                    <td data-label={t('common.comment')}>{r.comment || '—'}</td>
                    <td data-label={t('finance.acc.field')}>{r.account?.name ?? <span className="fin-muted-line">{t('finance.acc.byChannel')}</span>}</td>
                    <td data-label={t('common.amount')} style={{ textAlign: 'right' }}><span className="fin-money is-out">−{fmtMoney(r.amount, r.currency)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="fin-card fin-block" data-testid="exp-other-planner">
        <h2 className="fin-card-title">{t('finance.exp.plannerTitle')}</h2>
        <p className="fin-muted-line">{t('finance.exp.plannerHint').replace('{avg}', fmtMoney(d?.average.avg ?? 0))}</p>
        <div className="exp-planner">
          {(d?.plans ?? []).map((p) => (
            <label key={p.ym} className="exp-planner-cell" data-testid={`exp-plan-cell-${p.ym}`}>
              <span>{monthLabel(p.ym, 'short')}{p.ym.slice(0, 4) !== cur.slice(0, 4) ? ` ${p.ym.slice(2, 4)}` : ''}</span>
              <input
                className="crm-input"
                inputMode="decimal"
                defaultValue={p.amount != null ? String(p.amount) : ''}
                placeholder={`≈ ${Math.round(d?.average.avg ?? 0)}`}
                disabled={!can.manage}
                onBlur={(e) => { if ((p.amount != null ? String(p.amount) : '') !== e.target.value.trim()) void savePlan(p.ym, e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                data-testid={`exp-plan-input-${p.ym}`}
              />
            </label>
          ))}
        </div>
      </section>
      <AnimatePresence>
        {add && (
          <TransactionForm
            key="exp-other-add"
            preselect={null}
            canExpense
            initialType="EXPENSE"
            onClose={() => setAdd(false)}
            onCreated={() => { setAdd(false); qc.invalidateQueries({ queryKey: keys.finance.all }); }}
          />
        )}
      </AnimatePresence>
    </>
  );
}
