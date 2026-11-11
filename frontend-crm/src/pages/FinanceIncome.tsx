import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import CrmSelect from '../components/CrmSelect';
import CrmDatePicker from '../components/CrmDatePicker';
import FinanceSubnav from '../components/finance/FinanceSubnav';
import TransactionForm from '../components/finance/TransactionForm';
import { MonthNav, fmtMoney, monthLabel, useYmParam } from '../components/finance/financeShared';
import {
  acceptContractPayment,
  getIncome,
  listAccounts,
  uploadReceipt,
  type ContractRow,
  type FinanceAccount,
  type IncomeDirection,
  type IncomeResponse,
} from '../api/finance';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { useRealtime } from '../realtime';
import { useAuth } from '../store/auth';
import { hasRole, isFounder } from '../lib/roles';
import { roleCan } from '../lib/permissions';
import { useMediaQuery } from '../lib/useMediaQuery';
import { fmtDateText, tjToday } from '../lib/tjTime';

/**
 * «Финансы → Доход» (часть 2, макет утверждён 10.11.2026): четыре направления.
 * «Контракты» — сделки и их этапы: кого ждём в месяце, кто заплатил, кнопка
 * «Принять оплату» (счёт, на который пришли деньги). Остальные направления —
 * список оплат месяца и «+ Оплата».
 */

const DIRS: Array<{ key: IncomeDirection; icon: string; color: string; url: string }> = [
  { key: 'CONTRACT', icon: 'school', color: '#01368B', url: 'contracts' },
  { key: 'ACADEMY', icon: 'menu_book', color: '#0E7C86', url: 'academy' },
  { key: 'MASTERCLASS', icon: 'star', color: '#7C3AED', url: 'master' },
  { key: 'OTHER', icon: 'more_horiz', color: '#64748B', url: 'other' },
];

/** «13 400 $» или «13 400 $ + 2 000 TJS» — суммы по валютам одной строкой. */
function moneyList(m: Record<string, number> | undefined): string {
  const e = Object.entries(m ?? {}).filter(([, v]) => Math.abs(v) > 0.005);
  if (!e.length) return fmtMoney(0, 'TJS');
  return e.map(([c, v]) => fmtMoney(v, c)).join(' + ');
}

function parseAmount(v: string): number {
  return Number(v.replace(/\s/g, '').replace(',', '.'));
}

/** «3 нояб.» — календарный день как есть (на таджикском — свои названия месяцев). */
function shortDate(day: string | null): string {
  if (!day) return '—';
  return fmtDateText(`${day}T00:00:00Z`, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function longDate(day: string | null): string {
  if (!day) return '—';
  return fmtDateText(`${day}T00:00:00Z`, { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export default function FinanceIncome() {
  const { t } = useT();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const canCreate = roleCan(me, 'finance:create', hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT'));
  const [ym, setYm] = useYmParam();
  const [params, setParams] = useSearchParams();
  const dirKey = (DIRS.find((d) => d.url === params.get('dir'))?.key ?? 'CONTRACT') as IncomeDirection;
  const setDir = (k: IncomeDirection) => {
    const next = new URLSearchParams(params);
    const url = DIRS.find((d) => d.key === k)!.url;
    if (url === 'contracts') next.delete('dir');
    else next.set('dir', url);
    setParams(next, { replace: true });
  };
  const q = useQuery({ queryKey: keys.finance.income(ym), queryFn: () => getIncome(ym), placeholderData: keepPreviousData });
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts, enabled: canCreate });
  const [accept, setAccept] = useState<ContractRow | null>(null);
  const [addDir, setAddDir] = useState<IncomeDirection | null>(null);

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
    'submission:payment-new': refresh,
    'submission:reviewed': refresh,
  });

  const data = q.data;
  const month = monthLabel(ym);
  const monthLower = t(`finance.monthIn.${Number(ym.slice(5, 7))}`);

  return (
    <>
      <FinanceSubnav />
      <div className="fin-toolbar">
        <p className="fin-muted-line inc-lead">{t('finance.inc.lead')}</p>
        <MonthNav ym={ym} onChange={setYm} busy={q.isFetching} />
      </div>

      {q.isError ? (
        <div className="fin-card fin-block"><p className="fin-empty-line">{t('toast.error')}</p></div>
      ) : (
        <>
          <section className="inc-dirs fin-block" aria-label={t('finance.inc.dirs')}>
            {DIRS.map((d) => {
              const sum = data?.directions.find((x) => x.key === d.key);
              const active = d.key === dirKey;
              const foreign = Object.entries(sum?.foreign ?? {}).filter(([, v]) => v > 0.005);
              const c = data?.contracts;
              return (
                <button
                  key={d.key}
                  type="button"
                  className={`inc-dir${active ? ' is-active' : ''}`}
                  style={{ ['--dir' as any]: d.color }}
                  aria-pressed={active}
                  onClick={() => setDir(d.key)}
                  data-testid={`inc-dir-${d.url}`}
                >
                  <span className="inc-dir-head">
                    <span className="inc-dir-icon" aria-hidden="true"><Icon name={d.icon} size={20} /></span>
                    {t(`finance.inc.dir.${d.key}`)}
                  </span>
                  <span className="inc-dir-value fin-num" data-testid={`inc-dir-${d.url}-value`}>
                    {data ? fmtMoney(sum?.tjs ?? 0, 'TJS') : '…'}
                  </span>
                  {foreign.length > 0 && (
                    <span className="inc-dir-foreign">+ {foreign.map(([cur, v]) => fmtMoney(v, cur)).join(' + ')} {t('finance.inc.noRate')}</span>
                  )}
                  <span className="inc-dir-sub">
                    {d.key === 'CONTRACT' && c
                      ? `${t('finance.inc.deals').replace('{n}', String(c.footer.deals))}${c.waiting.deals ? ` · ${t('finance.inc.waitShort').replace('{sum}', moneyList(c.waiting.byCurrency))}` : ''}`
                      : t('finance.inc.payCount').replace('{n}', String(sum?.count ?? 0))}
                  </span>
                  {d.key === 'CONTRACT' && c && c.waiting.overdueDeals > 0 && (
                    <span className="inc-dir-warn">{t('finance.inc.overdueDeals').replace('{n}', String(c.waiting.overdueDeals))}</span>
                  )}
                </button>
              );
            })}
          </section>

          {!data ? (
            <div className="fin-card fin-block"><p className="fin-empty-line">{t('common.loading')}</p></div>
          ) : dirKey === 'CONTRACT' ? (
            <ContractsBoard
              data={data}
              monthLower={monthLower}
              month={month}
              canAccept={canCreate}
              onAccept={setAccept}
            />
          ) : (
            <DirectionPayments
              data={data}
              dir={dirKey}
              month={month}
              canAdd={canCreate}
              onAdd={() => setAddDir(dirKey)}
            />
          )}
        </>
      )}

      <AnimatePresence>
        {accept && (
          <AcceptPaymentModal
            key={accept.submissionId}
            row={accept}
            accounts={(accountsQ.data?.accounts ?? []).filter((a) => !a.archived)}
            canApprove={roleCan(me, 'submissions:approve', isFounder(me as any)) && (accept.manager?.id !== me?.id || isFounder(me as any))}
            onClose={() => setAccept(null)}
          />
        )}
        {addDir && (
          <TransactionForm
            key="inc-add"
            preselect={null}
            canExpense={false}
            initialType="INCOME"
            initialProduct={addDir}
            onClose={() => setAddDir(null)}
            onCreated={() => { setAddDir(null); qc.invalidateQueries({ queryKey: keys.finance.all }); }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function ContractsBoard({ data, month, monthLower, canAccept, onAccept }: {
  data: IncomeResponse;
  month: string;
  monthLower: string;
  canAccept: boolean;
  onAccept: (r: ContractRow) => void;
}) {
  const { t } = useT();
  const narrow = useMediaQuery('(max-width: 720px)');
  const c = data.contracts;
  const waitingRows = c.rows.filter((r) => r.group === 'waiting');
  const paidRows = c.rows.filter((r) => r.group === 'paid');
  const hasForeign = Object.keys(c.received.byCurrency).some((k) => k !== 'TJS');
  const noRate = Object.entries(c.received.noRate).filter(([, v]) => v > 0.005);

  const exportCsv = () => {
    const head = [t('finance.inc.col.student'), t('finance.inc.col.program'), t('finance.inc.col.manager'), t('finance.inc.col.total'), t('finance.col.currency'),
      t('finance.inc.col.paid'), t('finance.inc.col.left'), t('finance.inc.col.due'), t('finance.inc.col.waiting'), t('finance.inc.col.overdue'), t('finance.inc.col.paidMonth')];
    const lines = c.rows.map((r) => [r.name, r.program ?? '', r.manager?.name ?? '', r.total, r.currency, r.paidTotal, r.left, r.dueDate ?? '', r.waiting, r.overdue, r.paidInMonth]);
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = '﻿' + [head, ...lines].map((l) => l.map(esc).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `contracts-${data.ym}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const dueNote = (r: ContractRow) => {
    if (r.dueDays == null) return null;
    if (r.overdue > 0 && r.dueDays < 0) return { text: t('finance.inc.overdueDays').replace('{n}', String(-r.dueDays)), cls: 'is-bad' };
    if (r.dueDays === 0) return { text: t('finance.inc.today'), cls: 'is-warn' };
    if (r.dueDays > 0) return { text: t('finance.inc.inDays').replace('{n}', String(r.dueDays)), cls: r.dueDays <= 3 ? 'is-warn' : '' };
    return null;
  };

  const acceptBtn = (r: ContractRow) =>
    canAccept && r.status === 'ACTIVE' && r.left > 0.005 ? (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onAccept(r)} data-testid="inc-accept">
        {t('finance.inc.accept')}
      </button>
    ) : null;

  const stageText = (r: ContractRow) =>
    r.stagesCount
      ? r.stageOrder
        ? t('finance.inc.stageOf').replace('{k}', String(r.stageOrder)).replace('{n}', String(r.stagesCount))
        : t('finance.inc.allStagesPaid')
      : t('finance.inc.noStages');

  const pct = (r: ContractRow) => (r.total > 0 ? Math.min(100, Math.round((r.paidTotal / r.total) * 100)) : 0);

  const rowCard = (r: ContractRow) => {
    const note = dueNote(r);
    return (
      <article key={r.submissionId} className={`inc-card${r.overdue > 0 ? ' is-overdue' : ''}`} data-testid={`inc-row-${r.submissionId}`}>
        <div className="inc-card-top">
          <Link to={`/submissions/${r.submissionId}`} className="inc-name">{r.name}</Link>
          <span className="fin-num">{fmtMoney(r.total, r.currency)}</span>
        </div>
        {r.program && <div className="fin-muted-line">{r.program}</div>}
        <div className="inc-bar" aria-hidden="true"><span style={{ width: `${pct(r)}%` }} /></div>
        <div className="fin-muted-line">{stageText(r)} · {t('finance.inc.paidSum').replace('{sum}', fmtMoney(r.paidTotal, r.currency))}{r.manager ? ` · ${r.manager.name}` : ''}</div>
        {r.group === 'waiting' ? (
          <div className="inc-card-due">
            <span>{longDate(r.dueDate)}{note && <b className={`inc-due-note ${note.cls}`}> · {note.text}</b>}</span>
            {r.dueAmount != null && <span className="fin-num">{t('finance.inc.leftStage').replace('{sum}', fmtMoney(r.dueAmount, r.currency))}</span>}
          </div>
        ) : (
          <div className="inc-card-due">
            <span className="inc-chip is-paid">✓ {fmtMoney(r.paidInMonth, r.currency)} · {shortDate(r.lastPaidAt)}</span>
            <span className="fin-muted-line">{r.nextDueDate ? t('finance.inc.next').replace('{date}', shortDate(r.nextDueDate)) : '—'}</span>
          </div>
        )}
        {r.pendingCount > 0 && <span className="inc-chip is-pending">{t('finance.inc.pendingChip').replace('{n}', String(r.pendingCount))}</span>}
        {acceptBtn(r) && <div className="inc-card-act">{acceptBtn(r)}</div>}
      </article>
    );
  };

  const tableRow = (r: ContractRow) => {
    const note = dueNote(r);
    return (
      <tr key={r.submissionId} className={r.overdue > 0 ? 'is-overdue' : ''} data-testid={`inc-row-${r.submissionId}`}>
        <td>
          <Link to={`/submissions/${r.submissionId}`} className="inc-name">{r.name}</Link>
          {r.program && <div className="fin-muted-line">{r.program}</div>}
        </td>
        <td className="fin-muted-line">{r.manager?.name ?? '—'}</td>
        <td className="fin-num">{fmtMoney(r.total, r.currency)}</td>
        <td>
          <div className="inc-stage">{stageText(r)}</div>
          <div className="inc-bar" aria-hidden="true"><span style={{ width: `${pct(r)}%` }} /></div>
          <div className="fin-muted-line">{t('finance.inc.paidSum').replace('{sum}', fmtMoney(r.paidTotal, r.currency))}</div>
        </td>
        <td>
          {r.group === 'waiting' ? (
            <>
              <div>{longDate(r.dueDate)}</div>
              {note && <div className={`inc-due-note ${note.cls}`}>{note.text}</div>}
            </>
          ) : (
            <span className="fin-muted-line">{r.nextDueDate ? t('finance.inc.next').replace('{date}', shortDate(r.nextDueDate)) : '—'}</span>
          )}
        </td>
        <td>
          {r.group === 'waiting' ? (
            <div className="inc-pay">
              {r.payments.slice(-3).map((p, i) => <span key={i} className="inc-chip is-paid">✓ {fmtMoney(p.amount, r.currency)}</span>)}
              {r.dueAmount != null && <span className="inc-left">{t('finance.inc.leftStage').replace('{sum}', fmtMoney(r.dueAmount, r.currency))}</span>}
              {r.pendingCount > 0 && <span className="inc-chip is-pending">{t('finance.inc.pendingChip').replace('{n}', String(r.pendingCount))}</span>}
            </div>
          ) : (
            <div className="inc-pay">
              <span className="inc-chip is-paid">✓ {fmtMoney(r.paidInMonth, r.currency)} · {shortDate(r.lastPaidAt)}</span>
              {r.pendingCount > 0 && <span className="inc-chip is-pending">{t('finance.inc.pendingChip').replace('{n}', String(r.pendingCount))}</span>}
            </div>
          )}
        </td>
        <td className="inc-act">{acceptBtn(r) ?? <Link to={`/submissions/${r.submissionId}`} className="fin-link">{t('finance.inc.deal')}</Link>}</td>
      </tr>
    );
  };

  return (
    <section className="fin-card fin-block inc-contracts" data-testid="inc-contracts">
      <div className="fin-card-head">
        <div>
          <h2 className="fin-card-title">{t('finance.inc.dir.CONTRACT')}</h2>
          <p className="fin-muted-line">{t('finance.inc.contractsHint')}</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={exportCsv} data-testid="inc-export" disabled={!c.rows.length}>
          <Icon name="download" size={16} /> {t('finance.inc.export')}
        </button>
      </div>

      <div className="inc-tiles">
        <div className="inc-tile" data-testid="inc-tile-waiting">
          <span className="inc-tile-label">{t('finance.inc.waitingIn').replace('{month}', monthLower)}</span>
          <span className="inc-tile-value fin-num">{moneyList(c.waiting.byCurrency)}</span>
          {Object.keys(c.waiting.overdue).length > 0 && (
            <span className="inc-tile-sub is-bad">{t('finance.inc.ofOverdue').replace('{sum}', moneyList(c.waiting.overdue))}</span>
          )}
        </div>
        <div className="inc-tile" data-testid="inc-tile-received">
          <span className="inc-tile-label">{t('finance.inc.received')}</span>
          <span className="inc-tile-value fin-num is-in">{moneyList(c.received.byCurrency)}</span>
          {hasForeign && c.received.tjs > 0 && (
            <span className="inc-tile-sub">{t('finance.inc.approxTjs').replace('{sum}', fmtMoney(c.received.tjs, 'TJS'))}</span>
          )}
          {noRate.length > 0 && <span className="inc-tile-sub">{t('finance.inc.noRateSum').replace('{sum}', noRate.map(([k, v]) => fmtMoney(v, k)).join(' + '))}</span>}
        </div>
        <Link to="/submissions?tab=pending" className="inc-tile is-link" data-testid="inc-tile-pending">
          <span className="inc-tile-label">{t('finance.inc.pending')}</span>
          <span className="inc-tile-value fin-num">{c.pending.count ? moneyList(c.pending.byCurrency) : '0'}</span>
          <span className="inc-tile-sub">{c.pending.count ? t('finance.inc.pendingSub').replace('{n}', String(c.pending.count)) : t('finance.inc.pendingNone')}</span>
        </Link>
      </div>

      {c.overdue.length > 0 && (
        <p className="fin-warn-line is-bad" data-testid="inc-overdue">
          <Icon name="error" size={18} />
          <span>
            {t('finance.inc.overdueLine')
              .replace('{list}', c.overdue.slice(0, 3).map((o) => `${o.name} (${t('finance.inc.daysShort').replace('{n}', String(o.days))})`).join(', ') + (c.overdue.length > 3 ? ` ${t('finance.inc.andMore').replace('{n}', String(c.overdue.length - 3))}` : ''))
              .replace('{sum}', moneyList(c.waiting.overdue))}
          </span>
        </p>
      )}

      {c.rows.length === 0 ? (
        <p className="fin-empty-line" data-testid="inc-empty">{t('finance.inc.empty').replace('{month}', month)}</p>
      ) : narrow ? (
        <div className="inc-cards">
          {waitingRows.length > 0 && <h3 className="inc-group">{t('finance.inc.groupWaiting').replace('{n}', String(waitingRows.length))}</h3>}
          {waitingRows.map(rowCard)}
          {paidRows.length > 0 && <h3 className="inc-group">{t('finance.inc.groupPaid').replace('{month}', monthLower).replace('{n}', String(paidRows.length))}</h3>}
          {paidRows.map(rowCard)}
        </div>
      ) : (
        <div className="fin-table-wrap">
          <table className="table inc-table" data-testid="inc-table">
            <thead>
              <tr>
                <th>{t('finance.inc.col.studentProgram')}</th>
                <th>{t('finance.inc.col.manager')}</th>
                <th>{t('finance.inc.col.total')}</th>
                <th>{t('finance.inc.col.stages')}</th>
                <th>{t('finance.inc.col.due')}</th>
                <th>{t('finance.inc.col.payment')}</th>
                <th><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {waitingRows.length > 0 && (
                <tr className="inc-group-row"><td colSpan={7}>{t('finance.inc.groupWaiting').replace('{n}', String(waitingRows.length))}</td></tr>
              )}
              {waitingRows.map(tableRow)}
              {paidRows.length > 0 && (
                <tr className="inc-group-row"><td colSpan={7}>{t('finance.inc.groupPaid').replace('{month}', monthLower).replace('{n}', String(paidRows.length))}</td></tr>
              )}
              {paidRows.map(tableRow)}
            </tbody>
          </table>
        </div>
      )}

      {c.rows.length > 0 && (
        <div className="inc-foot" data-testid="inc-footer">
          <span>{t('finance.inc.total').replace('{n}', String(c.footer.deals))}</span>
          <b className="fin-num">{moneyList(c.footer.total)}</b>
          <span className="fin-muted-line">
            {t('finance.inc.footDeals').replace('{paid}', moneyList(c.footer.paidInMonth)).replace('{left}', moneyList(c.footer.waiting))}
          </span>
        </div>
      )}
      <p className="fin-note-box">{t('finance.inc.note')}</p>
    </section>
  );
}

function DirectionPayments({ data, dir, month, canAdd, onAdd }: {
  data: IncomeResponse;
  dir: IncomeDirection;
  month: string;
  canAdd: boolean;
  onAdd: () => void;
}) {
  const { t } = useT();
  const rows = data.payments.filter((p) => p.direction === dir);
  const label = t(`finance.inc.dir.${dir}`);
  return (
    <section className="fin-card fin-block" data-testid="inc-dir-payments">
      <div className="fin-card-head">
        <div>
          <h2 className="fin-card-title">{t('finance.inc.dirTitle').replace('{dir}', label).replace('{month}', month.toLowerCase())}</h2>
          <p className="fin-muted-line">{t('finance.inc.noPlan')}</p>
        </div>
        {canAdd && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onAdd} data-testid="inc-add">
            <Icon name="add" size={16} /> {t('finance.inc.addPayment')}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="fin-empty-line" data-testid="inc-dir-empty">{t('finance.inc.dirEmpty').replace('{month}', month.toLowerCase())}</p>
      ) : (
        <div className="fin-table-wrap">
          <table className="table fin-recent-table inc-pay-table">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('finance.inc.col.who')}</th>
                <th>{t('finance.acc.field')}</th>
                <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid={`inc-pay-${r.id}`}>
                  <td data-label={t('common.date')} style={{ whiteSpace: 'nowrap' }}>{shortDate(r.date.slice(0, 10))}</td>
                  <td data-label={t('finance.inc.col.who')}>
                    {r.who ? (r.studentId ? <Link to={`/students/${r.studentId}`}>{r.who}</Link> : r.who) : <span className="fin-muted-line">{r.comment || '—'}</span>}
                    {r.who && r.comment && <div className="fin-muted-line">{r.comment}</div>}
                  </td>
                  <td data-label={t('finance.acc.field')}>{r.account?.name ?? <span className="fin-muted-line">{t('finance.acc.byChannel')}</span>}</td>
                  <td data-label={t('common.amount')} style={{ textAlign: 'right' }}>
                    <span className="fin-money is-in">+{fmtMoney(r.amount, r.currency)}</span>
                    {r.currency !== 'TJS' && r.tjs != null && <div className="fin-muted-line">≈ {fmtMoney(r.tjs, 'TJS')}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * «Принять оплату» по сделке. Счёт — в валюте сделки; для сделки не в сомони
 * можно и счёт в сомони («по курсу»): тогда нужна сумма в сомони — она и
 * ляжет на счёт. Кто может одобрять — платёж одобряется сразу.
 */
export function AcceptPaymentModal({ row, accounts, canApprove, onClose }: {
  row: ContractRow;
  accounts: FinanceAccount[];
  canApprove: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const foreign = row.currency !== 'TJS';
  const options = useMemo(
    () => accounts.filter((a) => a.currency === row.currency || (foreign && a.currency === 'TJS')),
    [accounts, row.currency, foreign],
  );
  const [amount, setAmount] = useState(String(row.dueAmount ?? row.left));
  const [date, setDate] = useState(tjToday());
  const [accountId, setAccountId] = useState(() => (options.find((a) => a.currency === row.currency) ?? options[0])?.id ?? '');
  const [amountTjs, setAmountTjs] = useState('');
  const [notes, setNotes] = useState('');
  const [receipts, setReceipts] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const acc = options.find((a) => a.id === accountId) || null;
  const tjsAccount = foreign && acc?.currency === 'TJS';
  const needTjs = foreign && (canApprove || tjsAccount);
  const a = parseAmount(amount);
  const full = row.dueAmount != null && a >= row.dueAmount - 0.005;

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const urls: string[] = [];
      for (const f of Array.from(files)) urls.push((await uploadReceipt(f)).url);
      setReceipts((r) => [...r, ...urls]);
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (!(a > 0)) return setErr(t('finance.err.amountPositive'));
    if (a > row.left + 0.005) return setErr(t('finance.inc.errOverLeft').replace('{sum}', fmtMoney(row.left, row.currency)));
    if (!acc) return setErr(t('finance.inc.errAccount'));
    const tj = parseAmount(amountTjs);
    if (needTjs && !(tj > 0)) return setErr(t('finance.inc.errTjs'));
    setBusy(true);
    try {
      const r = await acceptContractPayment(row.submissionId, {
        amount: a,
        paidAt: date,
        accountId: acc.id,
        ...(foreign && tj > 0 && { amountTjs: tj }),
        ...(receipts.length && { receiptUrls: receipts }),
        ...(notes.trim() && { notes: notes.trim() }),
      });
      toast(r.status === 'APPROVED' ? t('finance.inc.accepted').replace('{acc}', acc.name) : t('finance.inc.sentForApproval'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
      qc.invalidateQueries({ queryKey: ['submissions'] });
      qc.invalidateQueries({ queryKey: ['submission', row.submissionId] });
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal open title={t('finance.inc.acceptTitle')} onClose={onClose} dirty={!!(notes || receipts.length || amountTjs)} busy={busy} width={520} testId="inc-accept-modal">
      <form onSubmit={submit}>
        <p className="inc-accept-sub" data-testid="inc-accept-sub">
          <b>{row.name}</b>
          {row.stageOrder ? ` · ${t('finance.inc.stageOf').replace('{k}', String(row.stageOrder)).replace('{n}', String(row.stagesCount))}` : ''}
          {row.dueAmount != null ? ` · ${t('finance.inc.leftStage').replace('{sum}', fmtMoney(row.dueAmount, row.currency))}` : ` · ${t('finance.inc.leftContract').replace('{sum}', fmtMoney(row.left, row.currency))}`}
        </p>
        {options.length === 0 ? (
          <p className="fin-warn-line" data-testid="inc-no-accounts">
            <Icon name="info" size={18} />
            {t('finance.inc.noAccounts').replace('{cur}', row.currency)}
          </p>
        ) : (
          <div className="form-grid-2">
            <div className="form-group">
              <label>{t('finance.inc.amountCur').replace('{cur}', row.currency)}</label>
              <input className="crm-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="inc-amount" />
            </div>
            <div className="form-group">
              <label>{t('finance.inc.paidAt')}</label>
              <CrmDatePicker className="crm-input" value={date} max={tjToday()} onChange={(v) => v && setDate(v)} />
            </div>
            <div className="form-group form-span-2">
              <label>{t('finance.inc.toAccount')}</label>
              <CrmSelect className="crm-select" value={accountId} onChange={(e) => setAccountId(e.target.value)} data-testid="inc-account">
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} · {o.currency}{foreign && o.currency === 'TJS' ? ` (${t('finance.inc.byRate')})` : ''}
                  </option>
                ))}
              </CrmSelect>
            </div>
            {foreign && (
              <div className="form-group form-span-2">
                <label>{tjsAccount ? t('finance.inc.tjsArrived') : t('finance.inc.tjsEquivalent')}{needTjs ? ' *' : ''}</label>
                <input className="crm-input" inputMode="decimal" value={amountTjs} onChange={(e) => setAmountTjs(e.target.value)} placeholder="0" data-testid="inc-amount-tjs" />
                <div className="form-hint">{tjsAccount ? t('finance.inc.tjsArrivedHint') : t('finance.inc.tjsHint')}</div>
              </div>
            )}
            <div className="form-group form-span-2">
              <label>{t('finance.inc.receipt')}</label>
              <div className="inc-attach">
                <label className={`btn btn-secondary btn-sm${uploading ? ' is-busy' : ''}`}>
                  <Icon name="attach_file" size={16} /> {t('finance.inc.attach')}
                  <input type="file" accept="image/*,application/pdf" multiple disabled={uploading} className="sr-only" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} data-testid="inc-receipt" />
                </label>
                {receipts.length > 0 && <span className="form-hint" data-testid="inc-receipt-count">✓ {t('finance.inc.filesN').replace('{n}', String(receipts.length))}</span>}
              </div>
            </div>
            <div className="form-group form-span-2">
              <label>{t('common.comment')}</label>
              <input className="crm-input" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} data-testid="inc-notes" />
            </div>
            <p className="form-hint form-span-2" data-testid="inc-accept-hint">
              {!canApprove
                ? t('finance.inc.hintPending')
                : full
                  ? t('finance.inc.hintFull').replace('{sum}', fmtMoney(a, row.currency)).replace('{acc}', acc?.name ?? '')
                  : t('finance.inc.hintPartial')}
            </p>
          </div>
        )}
        {err && <div className="form-error-text" role="alert" data-testid="inc-accept-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || uploading || options.length === 0} data-testid="inc-accept-save">
            {t('finance.inc.acceptBtn').replace('{sum}', a > 0 ? fmtMoney(a, row.currency) : '')}
          </button>
        </div>
      </form>
    </FormModal>
  );
}
