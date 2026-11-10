import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import CrmSelect from '../components/CrmSelect';
import CrmDatePicker from '../components/CrmDatePicker';
import FinanceSubnav from '../components/finance/FinanceSubnav';
import { ACCOUNT_COLORS, AccountMark, channelLabel, fmtDate, fmtMoney } from '../components/finance/financeShared';
import {
  type FinanceAccount,
  type FinanceAccountKind,
  createAccount,
  getChannelMap,
  listAccounts,
  setChannelMap,
  setFinanceConfig,
  updateAccount,
} from '../api/finance';
import { tjToday } from '../lib/tjTime';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { useRealtime } from '../realtime';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { roleCan } from '../lib/permissions';

const CURRENCIES = ['TJS', 'USD', 'EUR', 'CNY', 'RUB'];
const KINDS: FinanceAccountKind[] = ['BANK', 'CASH', 'SAVINGS'];

function parseAmount(v: string): number {
  return Number(v.replace(/\s/g, '').replace(',', '.'));
}

/**
 * «Финансы → Настройки»: счета (стартовый остаток, валюта, архив) и
 * раскладка старых операций по счетам (способ оплаты · валюта → счёт).
 * Менять — «Финансы — изменение» (основатель, админ, бухгалтер); остальным
 * всё видно, но только для чтения.
 */
export default function FinanceSettings() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const canManage = roleCan(me, 'finance:update', isElevated(me));
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts });
  const mapQ = useQuery({ queryKey: keys.finance.channelMap(), queryFn: getChannelMap });
  const [editing, setEditing] = useState<FinanceAccount | 'new' | null>(null);
  const [startEdit, setStartEdit] = useState<{ id: string; value: string } | null>(null);
  const [savingMap, setSavingMap] = useState<string | null>(null);

  useRealtime({ 'finance:accounts': () => qc.invalidateQueries({ queryKey: keys.finance.all }) });

  const accounts = accountsQ.data?.accounts ?? [];
  const unassigned = accountsQ.data?.unassigned?.count ?? 0;
  const refresh = () => qc.invalidateQueries({ queryKey: keys.finance.all });

  const saveStart = async (a: FinanceAccount) => {
    if (!startEdit) return;
    const v = parseAmount(startEdit.value);
    if (!Number.isFinite(v)) { toast(t('finance.acc.errNumber'), 'error'); return; }
    if (v === a.startBalance) { setStartEdit(null); return; }
    const ok = await confirm({
      title: t('finance.acc.startQ'),
      message: t('finance.acc.startMsg').replace('{name}', a.name).replace('{from}', fmtMoney(a.startBalance, a.currency)).replace('{to}', fmtMoney(v, a.currency)),
      confirmText: t('common.save'),
    });
    if (!ok) return;
    try {
      await updateAccount(a.id, { startBalance: v });
      toast(t('finance.acc.startSaved'), 'success');
      setStartEdit(null);
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const toggleArchive = async (a: FinanceAccount) => {
    if (!a.archived) {
      const ok = await confirm({
        title: t('finance.acc.archiveQ'),
        message: t('finance.acc.archiveMsg').replace('{name}', a.name),
        confirmText: t('finance.acc.archive'),
      });
      if (!ok) return;
    }
    try {
      await updateAccount(a.id, { archived: !a.archived });
      toast(a.archived ? t('finance.acc.unarchived') : t('finance.acc.archived'), 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const onMap = async (channel: string, currency: string, accountId: string) => {
    const k = `${channel}|${currency}`;
    setSavingMap(k);
    try {
      await setChannelMap({ channel, currency, accountId: accountId || null });
      toast(t('finance.acc.mapSaved'), 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSavingMap(null);
    }
  };

  return (
    <>
      <FinanceSubnav />
      <section className="fin-block">
        <div className="fin-settings-head">
          <div>
            <h2 className="fin-card-title">{t('finance.acc.settingsTitle')}</h2>
            <p className="fin-muted-line">{t('finance.acc.settingsHint')}</p>
          </div>
          {canManage && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')} data-testid="acc-new">
              <Icon name="add" size={18} /> {t('finance.acc.new')}
            </button>
          )}
        </div>
        <div className="card" style={{ padding: 0 }}>
          <table className="table" data-testid="acc-table">
            <thead>
              <tr>
                <th>{t('finance.acc.field')}</th>
                <th>{t('finance.acc.kind')}</th>
                <th>{t('finance.col.currency')}</th>
                <th style={{ textAlign: 'right' }}>{t('finance.acc.start')}</th>
                <th style={{ textAlign: 'right' }}>{t('finance.acc.current')}</th>
                <th><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {accountsQ.isLoading && <tr><td colSpan={6} className="empty">{t('common.loading')}</td></tr>}
              {!accountsQ.isLoading && accounts.length === 0 && (
                <tr><td colSpan={6} className="empty">{t('finance.acc.none')}</td></tr>
              )}
              {accounts.map((a) => (
                <tr key={a.id} className={a.archived ? 'is-archived' : undefined} data-testid={`acc-row-${a.id}`}>
                  <td><span className="fin-acc-inline is-strong"><AccountMark account={a} size={26} />{a.name}{a.archived && <span className="badge badge-gray">{t('finance.acc.archivedBadge')}</span>}</span></td>
                  <td data-label={t('finance.acc.kind')}>{t(`finance.acc.kind.${a.kind}`)}</td>
                  <td data-label={t('finance.col.currency')}><span className="fin-cur-chip">{a.currency}</span></td>
                  <td data-label={t('finance.acc.start')} style={{ textAlign: 'right' }}>
                    {startEdit?.id === a.id ? (
                      <span className="fin-inline-edit">
                        <input
                          className="crm-input"
                          inputMode="decimal"
                          autoFocus
                          value={startEdit.value}
                          aria-label={t('finance.acc.start')}
                          onChange={(e) => setStartEdit({ id: a.id, value: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveStart(a); if (e.key === 'Escape') setStartEdit(null); }}
                          data-testid="acc-start-input"
                        />
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => saveStart(a)} aria-label={t('common.save')} data-testid="acc-start-save"><Icon name="check" size={16} /></button>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setStartEdit(null)} aria-label={t('common.cancel')}><Icon name="close" size={16} /></button>
                      </span>
                    ) : canManage ? (
                      <button type="button" className="fin-link-num" onClick={() => setStartEdit({ id: a.id, value: String(a.startBalance) })} data-testid="acc-start-edit" title={t('finance.acc.startEdit')}>
                        {fmtMoney(a.startBalance, a.currency)} <Icon name="edit" size={14} />
                      </button>
                    ) : (
                      fmtMoney(a.startBalance, a.currency)
                    )}
                  </td>
                  <td data-label={t('finance.acc.current')} style={{ textAlign: 'right' }} className={`fin-money${a.balance < 0 ? ' is-out' : ''}`} data-testid="acc-balance">{fmtMoney(a.balance, a.currency)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canManage && (
                      <>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(a)} data-testid="acc-edit">{t('common.edit')}</button>{' '}
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => toggleArchive(a)} data-testid="acc-archive">
                          {a.archived ? t('finance.acc.unarchive') : t('finance.acc.archive')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {accountsQ.data && (
        <BalanceSinceCard since={accountsQ.data.balanceSince} canManage={canManage} onSaved={refresh} />
      )}

      <section className="fin-card fin-block" data-testid="acc-map">
        <div className="fin-card-head">
          <div>
            <h2 className="fin-card-title">{t('finance.acc.mapTitle')}</h2>
            <p className="fin-muted-line">{t('finance.acc.mapHint')}</p>
          </div>
        </div>
        {unassigned > 0 && (
          <p className="fin-warn-line" data-testid="acc-map-unassigned"><Icon name="info" size={18} />{t('finance.acc.unassignedHere').replace('{n}', String(unassigned))}</p>
        )}
        {mapQ.isLoading ? (
          <p className="fin-empty-line">{t('common.loading')}</p>
        ) : (mapQ.data?.rows ?? []).length === 0 ? (
          <p className="fin-empty-line">{t('finance.acc.mapEmpty')}</p>
        ) : (
          <div className="fin-map-grid">
            {(mapQ.data?.rows ?? []).map((r) => {
              const k = `${r.channel}|${r.currency}`;
              const options = accounts.filter((a) => a.currency === r.currency && (!a.archived || a.id === r.accountId));
              return (
                <label key={k} className="fin-map-item" data-testid={`acc-map-${r.channel}-${r.currency}`}>
                  <span className="fin-map-label">
                    <b>{channelLabel(r.channel, t)}</b> · {r.currency}
                    <span className="fin-muted-line"> · {t('finance.acc.opsCount').replace('{n}', String(r.count))}</span>
                  </span>
                  <CrmSelect
                    className="crm-select"
                    value={r.accountId || ''}
                    disabled={!canManage || savingMap === k}
                    onChange={(e) => onMap(r.channel, r.currency, e.target.value)}
                    aria-label={`${channelLabel(r.channel, t)} · ${r.currency}`}
                  >
                    <option value="">{options.length ? t('finance.acc.mapNone') : t('finance.acc.mapNoAccount').replace('{cur}', r.currency)}</option>
                    {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </CrmSelect>
                </label>
              );
            })}
          </div>
        )}
      </section>

      <AnimatePresence>
        {editing && (
          <AccountModal
            key={editing === 'new' ? 'new' : editing.id}
            account={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); refresh(); }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * С какого дня ведутся остатки. Стартовый остаток счёта — сколько было на нём
 * в этот день; более ранние операции на остатки не влияют (в отчётах и
 * графиках остаются). Ставится сама при создании первого счёта.
 */
function BalanceSinceCard({ since, canManage, onSaved }: { since: string | null; canManage: boolean; onSaved: () => void }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const [busy, setBusy] = useState(false);
  const save = async (v: string | null) => {
    if (v === since || busy) return;
    const ok = await confirm({
      title: t('finance.since.q'),
      message: v ? t('finance.since.msg').replace('{date}', fmtDate(v)) : t('finance.since.msgAll'),
      confirmText: t('common.save'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await setFinanceConfig({ balanceSince: v });
      toast(t('finance.since.saved'), 'success');
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fin-card fin-block fin-since" data-testid="acc-since">
      <span className="fin-since-icon" aria-hidden="true"><Icon name="event_available" size={22} /></span>
      <div className="fin-since-body">
        <h2 className="fin-card-title" data-testid="acc-since-title">
          {since ? t('finance.since.title').replace('{date}', fmtDate(since)) : t('finance.since.titleAll')}
        </h2>
        <p className="fin-muted-line">{since ? t('finance.since.hint') : t('finance.since.hintAll')}</p>
      </div>
      {canManage && (
        <div className="fin-since-actions" data-testid="acc-since-picker">
          {since ? (
            <CrmDatePicker
              className="crm-input"
              value={since}
              max={tjToday()}
              disabled={busy}
              onChange={(v) => save(v || null)}
            />
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => save(tjToday())} disabled={busy} data-testid="acc-since-today">
              {t('finance.since.today')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function AccountModal({ account, onClose, onSaved }: { account: FinanceAccount | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<FinanceAccountKind>(account?.kind ?? 'BANK');
  const [currency, setCurrency] = useState(account?.currency ?? 'TJS');
  const [color, setColor] = useState(account?.color ?? ACCOUNT_COLORS[0]);
  const [start, setStart] = useState(account ? String(account.startBalance) : '0');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = !account ? !!name.trim() : name !== account.name || kind !== account.kind || currency !== account.currency || color !== account.color;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!name.trim()) return setErr(t('finance.acc.errName'));
    const sb = parseAmount(start || '0');
    if (!account && !Number.isFinite(sb)) return setErr(t('finance.acc.errNumber'));
    setBusy(true);
    try {
      if (account) await updateAccount(account.id, { name: name.trim(), kind, currency, color });
      else await createAccount({ name: name.trim(), kind, currency, color, startBalance: sb });
      toast(t(account ? 'toast.saved' : 'toast.created'), 'success');
      onSaved();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal open title={t(account ? 'finance.acc.editTitle' : 'finance.acc.newTitle')} onClose={onClose} dirty={dirty} busy={busy} width={480} testId="acc-modal">
      <form onSubmit={submit}>
        <div className="form-grid-2">
          <div className="form-group form-span-2">
            <label htmlFor="acc-name">{t('finance.acc.name')}</label>
            <input id="acc-name" className={`crm-input${err && !name.trim() ? ' input-error' : ''}`} value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} placeholder={t('finance.acc.namePh')} data-testid="acc-name" />
          </div>
          <div className="form-group">
            <label>{t('finance.acc.kind')}</label>
            <CrmSelect className="crm-select" value={kind} onChange={(e) => setKind(e.target.value as FinanceAccountKind)} data-testid="acc-kind">
              {KINDS.map((k) => <option key={k} value={k}>{t(`finance.acc.kind.${k}`)}</option>)}
            </CrmSelect>
          </div>
          <div className="form-group">
            <label>{t('finance.col.currency')}</label>
            <CrmSelect className="crm-select" value={currency} onChange={(e) => setCurrency(e.target.value)} data-testid="acc-currency">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </CrmSelect>
            {account && <div className="form-hint">{t('finance.acc.currencyHint')}</div>}
          </div>
          {!account && (
            <div className="form-group form-span-2">
              <label htmlFor="acc-start">{t('finance.acc.startLabel')}</label>
              <input id="acc-start" className="crm-input" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} data-testid="acc-start" />
              <div className="form-hint">{t('finance.acc.startHint')}</div>
            </div>
          )}
          <fieldset className="form-group form-span-2 fin-colors">
            <legend>{t('finance.acc.color')}</legend>
            <div className="fin-color-row" role="radiogroup" aria-label={t('finance.acc.color')}>
              {ACCOUNT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={c}
                  className={`fin-color${color === c ? ' is-on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </fieldset>
        </div>
        {err && <div className="form-error-text" role="alert" data-testid="acc-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="acc-save">{t(account ? 'common.save' : 'common.create')}</button>
        </div>
      </form>
    </FormModal>
  );
}
