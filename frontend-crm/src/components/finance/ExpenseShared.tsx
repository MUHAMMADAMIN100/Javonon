import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import CrmSelect from '../CrmSelect';
import CrmDatePicker from '../CrmDatePicker';
import { useUI } from '../../ui/Dialogs';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { tjToday } from '../../lib/tjTime';
import {
  createTransaction,
  listAccounts,
  uploadReceipt,
  type ExpenseGroup,
  type TransactionCategory,
} from '../../api/finance';
import { fmtMoney } from './financeShared';

/** Пять статей расхода: цвет, значок и куда ведёт карточка. */
export const EXPENSE_GROUP_META: Array<{ key: ExpenseGroup; color: string; icon: string; to: string }> = [
  { key: 'salary', color: '#C2410C', icon: 'payments', to: '/salary' },
  { key: 'rent', color: '#4F46E5', icon: 'apartment', to: '/finance/expense/rent' },
  { key: 'partners', color: '#0E7C86', icon: 'handshake', to: '/finance/expense/partners' },
  { key: 'debts', color: '#DC2626', icon: 'receipt_long', to: '/finance/expense/debts' },
  { key: 'other', color: '#64748B', icon: 'inventory_2', to: '/finance/expense/other' },
];

export function parseAmount(v: string): number {
  return Number(String(v).replace(/\s/g, '').replace(',', '.'));
}

/** Месяц в предложном падеже («в ноябре» / «дар моҳи ноябр»). */
export function useMonthIn() {
  const { t } = useT();
  return (ym: string) => t(`finance.monthIn.${Number(ym.slice(5, 7))}`);
}

export interface Proof {
  kind: 'RECEIPT' | 'REASON_ONLY';
  url: string;
  reason: string;
}

/**
 * Подтверждение расхода (правило заказчика): чек / фото или причина, почему
 * чека нет (не короче 5 символов).
 */
export function ProofField({ value, onChange }: { value: Proof; onChange: (p: Proof) => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const [busy, setBusy] = useState(false);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await uploadReceipt(f);
      onChange({ ...value, kind: 'RECEIPT', url: r.url });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="exp-proof" data-testid="exp-proof">
      <div className="exp-proof-tabs" role="radiogroup" aria-label={t('finance.exp.proof')}>
        <button type="button" role="radio" aria-checked={value.kind === 'RECEIPT'} className={value.kind === 'RECEIPT' ? 'is-active' : ''} onClick={() => onChange({ ...value, kind: 'RECEIPT' })} data-testid="exp-proof-receipt">
          {t('finance.exp.proofReceipt')}
        </button>
        <button type="button" role="radio" aria-checked={value.kind === 'REASON_ONLY'} className={value.kind === 'REASON_ONLY' ? 'is-active' : ''} onClick={() => onChange({ ...value, kind: 'REASON_ONLY' })} data-testid="exp-proof-reason">
          {t('finance.exp.proofReason')}
        </button>
      </div>
      {value.kind === 'RECEIPT' ? (
        <div className="inc-attach">
          <label className={`btn btn-secondary btn-sm${busy ? ' is-busy' : ''}`}>
            <Icon name="attach_file" size={16} /> {value.url ? t('finance.exp.proofReplace') : t('finance.inc.attach')}
            <input type="file" accept="image/*,application/pdf" className="sr-only" disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} data-testid="exp-proof-file" />
          </label>
          {value.url && <span className="form-hint" data-testid="exp-proof-ok">✓ {t('finance.exp.proofAttached')}</span>}
        </div>
      ) : (
        <input className="crm-input" value={value.reason} maxLength={500} onChange={(e) => onChange({ ...value, reason: e.target.value })} placeholder={t('finance.exp.proofReasonPh')} data-testid="exp-proof-text" />
      )}
    </div>
  );
}

export function proofError(p: Proof, t: (k: string) => string): string | null {
  if (p.kind === 'RECEIPT' && !p.url) return t('finance.exp.errProof');
  if (p.kind === 'REASON_ONLY' && p.reason.trim().length < 5) return t('finance.exp.errReason');
  return null;
}

/**
 * Оплата со счёта: позиция аренды/подписки, платёж по долгу. Пишет обычный
 * расход (журнал, остатки, «Расход») со ссылкой на позицию или долг.
 */
export function ExpensePayModal({
  title,
  summary,
  currency,
  defaultAmount,
  maxAmount,
  category,
  link,
  defaultAccountId,
  commentPrefix,
  testId = 'exp-pay-modal',
  onClose,
  onDone,
}: {
  title: string;
  summary?: React.ReactNode;
  currency: string;
  defaultAmount: number;
  maxAmount?: number;
  category: TransactionCategory;
  link: { subscriptionId?: string; debtId?: string };
  defaultAccountId?: string | null;
  commentPrefix: string;
  testId?: string;
  onClose: () => void;
  onDone: (amount: number) => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts });
  const options = useMemo(() => (accountsQ.data?.accounts ?? []).filter((a) => !a.archived && a.currency === currency), [accountsQ.data, currency]);
  const [amount, setAmount] = useState(defaultAmount > 0 ? String(defaultAmount) : '');
  const [date, setDate] = useState(tjToday());
  const [accountId, setAccountId] = useState<string>('');
  const acc = options.find((a) => a.id === (accountId || defaultAccountId)) ?? options[0] ?? null;
  const [proof, setProof] = useState<Proof>({ kind: 'RECEIPT', url: '', reason: '' });
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    const a = parseAmount(amount);
    if (!(a > 0)) return setErr(t('finance.err.amountPositive'));
    if (maxAmount != null && a > maxAmount + 0.005) return setErr(t('finance.exp.errOverLeft').replace('{sum}', fmtMoney(maxAmount, currency)));
    if (!acc) return setErr(t('finance.exp.errAccount'));
    const pe = proofError(proof, t);
    if (pe) return setErr(pe);
    setBusy(true);
    try {
      await createTransaction({
        type: 'EXPENSE',
        category,
        amount: a,
        currency,
        date,
        accountId: acc.id,
        ...link,
        comment: note.trim() ? `${commentPrefix} — ${note.trim()}` : commentPrefix,
        receiptKind: proof.kind,
        ...(proof.kind === 'RECEIPT' ? { receiptUrl: proof.url } : { noReceiptReason: proof.reason.trim() }),
      } as any);
      qc.invalidateQueries({ queryKey: keys.finance.all });
      onDone(a);
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal open title={title} onClose={onClose} dirty={!!(note || proof.url || proof.reason)} busy={busy} width={520} testId={testId}>
      <form onSubmit={submit}>
        {summary && <div className="exp-pay-summary" data-testid="exp-pay-summary">{summary}</div>}
        {options.length === 0 ? (
          <p className="fin-warn-line" data-testid="exp-no-accounts"><Icon name="info" size={18} />{t('finance.exp.noAccounts').replace('{cur}', currency)}</p>
        ) : (
          <div className="form-grid-2">
            <div className="form-group">
              <label>{t('finance.inc.amountCur').replace('{cur}', currency)}</label>
              <input className="crm-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="exp-pay-amount" />
            </div>
            <div className="form-group">
              <label>{t('finance.exp.payDate')}</label>
              <CrmDatePicker className="crm-input" value={date} max={tjToday()} onChange={(v) => v && setDate(v)} />
            </div>
            <div className="form-group form-span-2">
              <label>{t('finance.exp.fromAccount')}</label>
              <CrmSelect className="crm-select" value={acc?.id ?? ''} onChange={(e) => setAccountId(e.target.value)} data-testid="exp-pay-account">
                {options.map((o) => <option key={o.id} value={o.id}>{o.name} · {fmtMoney(o.balance, o.currency)}</option>)}
              </CrmSelect>
            </div>
            <div className="form-group form-span-2">
              <label>{t('finance.exp.proof')}</label>
              <ProofField value={proof} onChange={setProof} />
            </div>
            <div className="form-group form-span-2">
              <label>{t('common.comment')}</label>
              <input className="crm-input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} data-testid="exp-pay-note" />
            </div>
            <p className="form-hint form-span-2">{t('finance.exp.payHint')}</p>
          </div>
        )}
        {err && <div className="form-error-text" role="alert" data-testid="exp-pay-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || options.length === 0} data-testid="exp-pay-save">
            {t('finance.exp.payBtn').replace('{sum}', parseAmount(amount) > 0 ? fmtMoney(parseAmount(amount), currency) : '')}
          </button>
        </div>
      </form>
    </FormModal>
  );
}
