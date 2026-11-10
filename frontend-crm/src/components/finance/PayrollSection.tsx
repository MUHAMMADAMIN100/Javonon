import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import CrmSelect from '../CrmSelect';
import CrmDatePicker from '../CrmDatePicker';
import { useUI } from '../../ui/Dialogs';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { useAuth } from '../../store/auth';
import { hasRole, isElevated } from '../../lib/roles';
import { roleCan } from '../../lib/permissions';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { fmtDateText, tjToday } from '../../lib/tjTime';
import {
  deleteTransaction,
  getPayroll,
  getPayrollHistory,
  listAccounts,
  payrollAdvance,
  payrollClose,
  payrollPay,
  payrollReopen,
  type PayrollRow,
  type PayrollSheet,
} from '../../api/finance';
import { fmtMoney, monthLabel } from './financeShared';
import { parseAmount } from './ExpenseShared';

/**
 * «Расход → Зарплата» (часть 2, 10.11.2026): ведомость месяца начисления.
 * Расчёт — Javonon (часы, процент с продаж по сетке, переработка, KPI, штрафы),
 * удобства — авансы и выплата со счёта, закрытие месяца, история сотрудника.
 */

const day = (d: string | null) => (d ? fmtDateText(`${d}T00:00:00Z`, { day: '2-digit', month: '2-digit', timeZone: 'UTC' }) : '—');
const num = (n: number) => (n > 0.005 ? fmtMoney(n) : '—');

function useAccountsTjs() {
  const q = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts });
  return useMemo(() => (q.data?.accounts ?? []).filter((a) => !a.archived && a.currency === 'TJS'), [q.data]);
}

export default function PayrollSection({ ym, onYm }: { ym: string; onYm: (ym: string) => void }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const canPay = roleCan(me, 'salary:pay', hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT'));
  const canRemove = roleCan(me, 'finance:delete', isElevated(me));
  const narrow = useMediaQuery('(max-width: 900px)');
  const q = useQuery({ queryKey: keys.finance.expense('payroll', ym), queryFn: () => getPayroll(ym), placeholderData: keepPreviousData });
  const [open, setOpen] = useState<string | null>(null);
  const [pay, setPay] = useState<PayrollRow | null>(null);
  const d = q.data;
  const monthName = monthLabel(ym).toLowerCase();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.finance.all });

  const exportCsv = () => {
    if (!d) return;
    const head = [t('finance.pay.col.employee'), t('finance.pay.col.hours'), t('finance.pay.col.base'), t('finance.pay.col.sales'), t('finance.pay.col.bonus'),
      t('finance.pay.col.extra'), t('finance.pay.col.fines'), t('finance.pay.col.net'), t('finance.pay.col.advance'), t('finance.pay.col.toPay'), t('finance.pay.col.status')];
    const lines = d.rows.map((r) => [r.name, r.hours, r.base, r.sales, r.bonus, r.extra, r.penalties, r.net, r.advances, r.toPay, r.status === 'paid' ? `${t('finance.pay.paid')} ${r.paidAt ?? ''}` : r.status]);
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + [head, ...lines].map((l) => l.map(esc).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `salary-${ym}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const close = async () => {
    const ok = await confirm({ title: t('finance.pay.closeQ'), message: t('finance.pay.closeMsg'), confirmText: t('finance.pay.close') });
    if (!ok) return;
    try {
      const r = await payrollClose(ym);
      qc.setQueryData<PayrollSheet>(keys.finance.expense('payroll', ym), (cur) => cur && { ...cur, closed: true, canClose: false });
      toast(t('finance.pay.closed'), 'success');
      refresh();
      if (r.nextYm && r.nextYm !== ym) onYm(r.nextYm);
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };
  const reopen = async () => {
    const ok = await confirm({ title: t('finance.pay.reopenQ'), message: t('finance.pay.reopenMsg'), confirmText: t('finance.pay.reopen') });
    if (!ok) return;
    try {
      await payrollReopen(ym);
      qc.setQueryData<PayrollSheet>(keys.finance.expense('payroll', ym), (cur) => cur && { ...cur, closed: false, closedAt: null });
      toast(t('finance.pay.reopened'), 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const status = (r: PayrollRow) => {
    if (r.status === 'paid') return <span className="exp-chip is-ok" title={t('finance.pay.paidHint')}>✓ {t('finance.pay.paid')} {day(r.paidAt)}</span>;
    if (r.status === 'zero') return <span className="exp-chip">{t('finance.pay.zero')}</span>;
    if (!canPay || d?.closed) return <span className="exp-chip is-bad">{t('finance.pay.due')}</span>;
    return (
      <button type="button" className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); setPay(r); }} data-testid="pay-row-pay">
        {r.status === 'covered' ? t('finance.pay.closeRow') : t('finance.pay.pay')}
      </button>
    );
  };

  return (
    <>
      <div className="exp-cards pay-cards fin-block">
        <div className="inc-tile" data-testid="pay-card-accrued">
          <span className="inc-tile-label">{t('finance.pay.accrued').replace('{month}', monthName)}</span>
          <span className="inc-tile-value fin-num">{fmtMoney(d?.cards.accrued ?? 0)}</span>
          <span className="inc-tile-sub">{t('finance.pay.accruedSub')}</span>
        </div>
        <div className="inc-tile" data-testid="pay-card-advances">
          <span className="inc-tile-label">{t('finance.pay.advances')}</span>
          <span className="inc-tile-value fin-num">{fmtMoney(d?.cards.advances ?? 0)}</span>
          <span className="inc-tile-sub">{t('finance.pay.advancesSub').replace('{n}', String(d?.rows.reduce((x, r) => x + r.advancesList.length, 0) ?? 0))}</span>
        </div>
        <div className="inc-tile" data-testid="pay-card-paid">
          <span className="inc-tile-label">{t('finance.pay.paidCard')}</span>
          <span className="inc-tile-value fin-num is-in">{fmtMoney(d?.cards.paid ?? 0)}</span>
          <span className="inc-tile-sub">{t('finance.pay.paidOf').replace('{a}', String(d?.cards.paidCount ?? 0)).replace('{b}', String(d?.cards.employees ?? 0))}</span>
        </div>
        <div className="inc-tile" data-testid="pay-card-topay">
          <span className="inc-tile-label">{t('finance.pay.toPay')}</span>
          <span className="inc-tile-value fin-num is-out">{fmtMoney(d?.cards.toPay ?? 0)}</span>
          <span className="inc-tile-sub">{d ? t('finance.pay.until').replace('{date}', fmtDateText(`${d.payUntil}T00:00:00Z`, { day: 'numeric', month: 'long', timeZone: 'UTC' })) : ''}</span>
        </div>
      </div>

      <div className="pay-toolbar fin-block">
        <span className="pay-hint">{t('finance.pay.calcHint')}</span>
        {d && <span className={`exp-chip ${d.closed ? 'is-ok' : 'is-warn'}`} data-testid="pay-month-status">{d.closed ? t('finance.pay.monthClosed') : t('finance.pay.monthOpen')}</span>}
        <span className="pay-toolbar-actions">
          <Link to="/salary" className="btn btn-secondary btn-sm" data-testid="pay-details-link">{t('finance.pay.details')}</Link>
          <button type="button" className="btn btn-secondary btn-sm" onClick={exportCsv} disabled={!d?.rows.length} data-testid="pay-export">
            <Icon name="download" size={16} /> {t('finance.inc.export')}
          </button>
          {canPay && d && (d.closed ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={reopen} data-testid="pay-reopen">{t('finance.pay.reopen')}</button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={close} disabled={!d?.canClose} title={d?.canClose ? undefined : t('finance.pay.closeFirst')} data-testid="pay-close">
              {t('finance.pay.close')}
            </button>
          ))}
        </span>
      </div>

      <section className="fin-card fin-block" data-testid="pay-sheet">
        {!d ? <p className="fin-empty-line">{t('common.loading')}</p> : d.rows.length === 0 ? (
          <p className="fin-empty-line" data-testid="pay-empty">{t('finance.pay.empty')}</p>
        ) : narrow ? (
          <div className="inc-cards">
            {d.rows.map((r) => (
              <article key={r.userId} className="inc-card pay-card" data-testid={`pay-row-${r.userId}`}>
                <div className="inc-card-top"><b>{r.name}</b><span className="fin-num">{fmtMoney(r.net)}</span></div>
                <div className="fin-muted-line">{r.position ?? ''}{r.position ? ' · ' : ''}{t('finance.pay.hoursN').replace('{n}', String(r.hours))}</div>
                <dl className="pay-dl">
                  <dt>{t('finance.pay.col.base')}</dt><dd>{num(r.base)}</dd>
                  <dt>{t('finance.pay.col.sales')}</dt><dd>{num(r.bonus)}</dd>
                  <dt>{t('finance.pay.col.extra')}</dt><dd>{num(r.extra)}</dd>
                  <dt>{t('finance.pay.col.fines')}</dt><dd className="is-out">{num(r.penalties)}</dd>
                  <dt>{t('finance.pay.col.advance')}</dt><dd>{num(r.advances)}</dd>
                  <dt>{t('finance.pay.col.toPay')}</dt><dd><b>{num(r.toPay)}</b></dd>
                </dl>
                <div className="pay-card-act">{status(r)}<button type="button" className="fin-link" onClick={() => setOpen(open === r.userId ? null : r.userId)} data-testid="pay-row-toggle">{open === r.userId ? t('finance.pay.hide') : t('finance.pay.more')}</button></div>
                {open === r.userId && <RowDetails row={r} sheet={d} canPay={canPay} canRemove={canRemove} />}
              </article>
            ))}
          </div>
        ) : (
          <div className="fin-table-wrap">
            <table className="table pay-table" data-testid="pay-table">
              <thead>
                <tr>
                  <th>{t('finance.pay.col.employee')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.pay.col.hours')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.pay.col.base')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.pay.col.sales')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.pay.col.extra')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.pay.col.fines')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.pay.col.net')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.pay.col.advance')}</th>
                  <th style={{ textAlign: 'right' }}>{t('finance.pay.col.toPay')}</th>
                  <th>{t('finance.pay.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <Fragment key={r.userId}>
                    <tr
                      className={`pay-row${open === r.userId ? ' is-open' : ''}`}
                      onClick={() => setOpen(open === r.userId ? null : r.userId)}
                      tabIndex={0}
                      aria-expanded={open === r.userId}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === r.userId ? null : r.userId); } }}
                      data-testid={`pay-row-${r.userId}`}
                    >
                      <td><b>{r.name}</b><div className="fin-muted-line">{r.position ?? t(`role.${r.role}`)}</div></td>
                      <td className="fin-num" style={{ textAlign: 'right' }}>{r.hours ? `${r.hours} ${t('finance.pay.h')}` : '—'}</td>
                      <td className="fin-num" style={{ textAlign: 'right' }}>{num(r.base)}</td>
                      <td className="fin-num" style={{ textAlign: 'right' }}>{num(r.bonus)}{r.bonusPercent ? <div className="fin-muted-line">{r.bonusPercent}% · {fmtMoney(r.sales)}</div> : null}</td>
                      <td className="fin-num" style={{ textAlign: 'right' }}>{num(r.extra)}</td>
                      <td className="fin-num is-out" style={{ textAlign: 'right' }}>{num(r.penalties)}</td>
                      <td className="fin-num" style={{ textAlign: 'right', fontWeight: 700 }}>{fmtMoney(r.net)}</td>
                      <td className="fin-num" style={{ textAlign: 'right' }}>{num(r.advances)}</td>
                      <td className="fin-num" style={{ textAlign: 'right', fontWeight: 700 }}>{num(r.toPay)}</td>
                      <td>{status(r)}</td>
                    </tr>
                    {open === r.userId && (
                      <tr className="pay-details-row"><td colSpan={10}><RowDetails row={r} sheet={d} canPay={canPay} canRemove={canRemove} /></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t('finance.pay.total').replace('{n}', String(d.rows.length))}</td>
                  <td /><td className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(d.rows.reduce((x, r) => x + r.base, 0))}</td>
                  <td className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(d.rows.reduce((x, r) => x + r.bonus, 0))}</td>
                  <td /><td className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(d.rows.reduce((x, r) => x + r.penalties, 0))}</td>
                  <td className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(d.cards.accrued)}</td>
                  <td className="fin-num" style={{ textAlign: 'right' }}>{fmtMoney(d.cards.advances)}</td>
                  <td className="fin-num" style={{ textAlign: 'right' }} data-testid="pay-total-topay">{fmtMoney(d.cards.toPay)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="fin-note-box">{t('finance.pay.note').replace('{month}', monthName)}</p>
      </section>
      <AnimatePresence>
        {pay && d && <PayModal key={pay.userId} row={pay} ym={ym} onClose={() => setPay(null)} />}
      </AnimatePresence>
    </>
  );
}

function RowDetails({ row, sheet, canPay, canRemove }: { row: PayrollRow; sheet: PayrollSheet; canPay: boolean; canRemove: boolean }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const accounts = useAccountsTjs();
  const hist = useQuery({ queryKey: keys.finance.expense('payroll-history', row.userId), queryFn: () => getPayrollHistory(row.userId) });
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const acc = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;
  const editable = canPay && !sheet.closed && row.status !== 'paid';
  // Ведомость пересчитывается дольше секунды — аванс показываем сразу, пересчёт догонит.
  const patchRow = (fn: (r: PayrollRow) => PayrollRow) => {
    qc.setQueryData<PayrollSheet>(keys.finance.expense('payroll', sheet.ym), (cur) => {
      if (!cur) return cur;
      const rows = cur.rows.map((r) => (r.userId === row.userId ? fn(r) : r));
      return {
        ...cur,
        rows,
        cards: { ...cur.cards, advances: rows.reduce((x, r) => x + r.advances, 0), toPay: rows.reduce((x, r) => x + r.toPay, 0) },
      };
    });
  };
  const withAdvances = (r: PayrollRow, list: PayrollRow['advancesList']): PayrollRow => {
    const advances = list.reduce((x, a) => x + a.amount, 0);
    return { ...r, advancesList: list, advances, toPay: r.status === 'paid' ? 0 : Math.max(0, r.net - advances) };
  };
  const give = async () => {
    const a = parseAmount(amount);
    if (!(a > 0)) return toast(t('finance.err.amountPositive'), 'error');
    if (!acc) return toast(t('finance.exp.errAccount'), 'error');
    setBusy(true);
    try {
      const created: any = await payrollAdvance({ userId: row.userId, ym: sheet.ym, amount: a, accountId: acc.id, date: tjToday() });
      patchRow((r) => withAdvances(r, [...r.advancesList, { id: created.id, amount: a, date: tjToday(), account: { id: acc.id, name: acc.name }, comment: created.comment ?? null }]));
      toast(t('finance.pay.advanceDone').replace('{sum}', fmtMoney(a)), 'success');
      setAmount('');
      qc.invalidateQueries({ queryKey: keys.finance.all });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: string, sum: number) => {
    const ok = await confirm({ title: t('finance.pay.cancelAdvQ'), message: t('finance.pay.cancelAdvMsg').replace('{sum}', fmtMoney(sum)), danger: true, confirmText: t('finance.exp.cancelBtn') });
    if (!ok) return;
    try {
      await deleteTransaction(id);
      patchRow((r) => withAdvances(r, r.advancesList.filter((a) => a.id !== id)));
      toast(t('finance.pay.advanceCancelled'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };
  return (
    <div className="pay-details" data-testid="pay-details" onClick={(e) => e.stopPropagation()}>
      <div className="pay-block">
        <h4>{t('finance.pay.advanceTitle')}</h4>
        {editable ? (
          <div className="pay-adv-form">
            <input className="crm-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('finance.pay.advancePh')} data-testid="pay-adv-amount" />
            <CrmSelect className="crm-select" value={acc?.id ?? ''} onChange={(e) => setAccountId(e.target.value)} data-testid="pay-adv-account">
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </CrmSelect>
            <button type="button" className="btn btn-primary btn-sm" onClick={give} disabled={busy || !accounts.length} data-testid="pay-adv-give">{t('finance.pay.give')}</button>
          </div>
        ) : null}
        {row.advancesList.length ? (
          <ul className="exp-pays">
            {row.advancesList.map((a) => (
              <li key={a.id} data-testid={`pay-adv-${a.id}`}>
                <span>{day(a.date)} · {a.account?.name ?? '—'}</span><b className="fin-num">{fmtMoney(a.amount)}</b>
                {editable && canRemove && <button type="button" className="fin-link exp-cancel" onClick={() => cancel(a.id, a.amount)} data-testid="pay-adv-cancel">{t('finance.exp.cancel')}</button>}
              </li>
            ))}
          </ul>
        ) : <p className="fin-muted-line">{t('finance.pay.noAdvances')}</p>}
        {editable && <p className="fin-muted-line">{t('finance.pay.advanceHint')}</p>}
      </div>
      <div className="pay-block">
        <h4>{t('finance.pay.whereFrom')}</h4>
        <ul className="pay-why">
          <li>{t('finance.pay.whyHours').replace('{h}', String(row.hours)).replace('{late}', String(row.lateMinutes))}</li>
          <li>{row.bonusPercent ? t('finance.pay.whySales').replace('{sales}', fmtMoney(row.sales)).replace('{pct}', String(row.bonusPercent)).replace('{bonus}', fmtMoney(row.bonus)) : t('finance.pay.whyNoSales')}</li>
          {row.extra > 0.005 && <li>{t('finance.pay.whyExtra').replace('{sum}', fmtMoney(row.extra))}</li>}
          <li>{row.penalties > 0.005 ? t('finance.pay.whyFines').replace('{sum}', fmtMoney(row.penalties)) : t('finance.pay.whyNoFines')}{row.penaltiesPending ? ` · ${t('finance.pay.finesPending').replace('{n}', String(row.penaltiesPending))}` : ''}</li>
        </ul>
      </div>
      <div className="pay-block">
        <h4>{t('finance.pay.history')}</h4>
        {hist.data?.rows.length ? (
          <ul className="pay-why" data-testid="pay-history">
            {hist.data.rows.slice(0, 6).map((h) => (
              <li key={h.ym}>
                {monthLabel(h.ym)} · {fmtMoney(h.net)}{h.advances ? ` (${t('finance.pay.advShort')} ${fmtMoney(h.advances)})` : ''} · {h.status === 'PAID' ? `${t('finance.pay.paid')} ${day(h.paidAt)}` : t('finance.pay.notPaidYet')}
              </li>
            ))}
          </ul>
        ) : <p className="fin-muted-line">{hist.isLoading ? t('common.loading') : t('finance.pay.noHistory')}</p>}
        <Link to={`/users/${row.userId}`} className="fin-link">{t('finance.pay.allHistory')} →</Link>
      </div>
    </div>
  );
}

function PayModal({ row, ym, onClose }: { row: PayrollRow; ym: string; onClose: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const accounts = useAccountsTjs();
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(tjToday());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const acc = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acc && row.toPay > 0.005) return setErr(t('finance.exp.errAccount'));
    setBusy(true);
    try {
      await payrollPay({ userId: row.userId, ym, accountId: acc?.id ?? '', date });
      toast(t('finance.pay.payDone').replace('{name}', row.name), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open title={t('finance.pay.payTitle').replace('{name}', row.name)} onClose={onClose} dirty={false} busy={busy} width={480} testId="pay-modal">
      <form onSubmit={submit}>
        <p className="exp-pay-summary" data-testid="pay-modal-summary">
          {t('finance.pay.forMonth').replace('{month}', monthLabel(ym).toLowerCase())}: <b>{fmtMoney(row.toPay)}</b>
          {row.advances > 0.005 && <> ({t('finance.pay.netMinusAdv').replace('{net}', fmtMoney(row.net)).replace('{adv}', fmtMoney(row.advances))})</>}
        </p>
        {accounts.length === 0 ? (
          <p className="fin-warn-line"><Icon name="info" size={18} />{t('finance.exp.noAccounts').replace('{cur}', 'TJS')}</p>
        ) : (
          <div className="form-grid-2">
            <div className="form-group form-span-2">
              <label>{t('finance.exp.fromAccount')}</label>
              <CrmSelect className="crm-select" value={acc?.id ?? ''} onChange={(e) => setAccountId(e.target.value)} data-testid="pay-modal-account">
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {fmtMoney(a.balance)}</option>)}
              </CrmSelect>
            </div>
            <div className="form-group form-span-2">
              <label>{t('finance.pay.payDate')}</label>
              <CrmDatePicker className="crm-input" value={date} max={tjToday()} onChange={(v) => v && setDate(v)} />
            </div>
            <p className="form-hint form-span-2">{t('finance.pay.payHint')}</p>
          </div>
        )}
        {err && <div className="form-error-text" role="alert" data-testid="pay-modal-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || accounts.length === 0} data-testid="pay-modal-save">
            {row.toPay > 0.005 ? t('finance.pay.payBtn').replace('{sum}', fmtMoney(row.toPay)) : t('finance.pay.closeRow')}
          </button>
        </div>
      </form>
    </FormModal>
  );
}
