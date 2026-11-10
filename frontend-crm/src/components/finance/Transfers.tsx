import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import FormModal from '../FormModal';
import CrmSelect from '../CrmSelect';
import CrmDatePicker from '../CrmDatePicker';
import { useUI } from '../../ui/Dialogs';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { tjToday } from '../../lib/tjTime';
import { createTransfer, listAccounts, reverseTransfer, type FinanceTransfer } from '../../api/finance';
import { AccountMark, fmtDate, fmtMoney } from './financeShared';

/** Сумма из поля: пробелы и запятая допускаются. */
function parseAmount(v: string): number {
  return Number(v.replace(/\s/g, '').replace(',', '.'));
}

/**
 * Перевод между своими счетами (инкассация, обмен валюты). В доход и расход
 * не входит — меняет только остатки двух счетов. Разные валюты: «сколько
 * пришло» вводится отдельно, курс показывается подсказкой.
 */
export function TransferForm({ initialDate, onClose, onDone }: { initialDate?: string; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts });
  const accounts = (accountsQ.data?.accounts ?? []).filter((a) => !a.archived);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [date, setDate] = useState(initialDate || tjToday());
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const from = accounts.find((a) => a.id === fromId) || null;
  const to = accounts.find((a) => a.id === toId) || null;
  const crossCurrency = !!from && !!to && from.currency !== to.currency;
  const rate = useMemo(() => {
    const a = parseAmount(amount);
    const b = parseAmount(toAmount);
    if (!crossCurrency || !(a > 0) || !(b > 0)) return '';
    // Курс — сколько единиц «дешёвой» валюты за одну «дорогую».
    return a >= b
      ? `1 ${to!.currency} = ${(a / b).toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ${from!.currency}`
      : `1 ${from!.currency} = ${(b / a).toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ${to!.currency}`;
  }, [amount, toAmount, crossCurrency, from, to]);

  const dirty = !!(fromId || toId || amount || comment);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    setErr('');
    if (!from || !to) return setErr(t('finance.tr.errAccounts'));
    if (from.id === to.id) return setErr(t('finance.tr.errSame'));
    const a = parseAmount(amount);
    if (!(a > 0)) return setErr(t('finance.err.amountPositive'));
    const b = crossCurrency ? parseAmount(toAmount) : a;
    if (crossCurrency && !(b > 0)) return setErr(t('finance.tr.errToAmount').replace('{cur}', to.currency));
    inFlight.current = true;
    setBusy(true);
    try {
      await createTransfer({ fromAccountId: from.id, toAccountId: to.id, amount: a, toAmount: crossCurrency ? b : null, date, comment: comment.trim() || null });
      toast(t('finance.tr.done'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
      onDone();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <FormModal open title={t('finance.tr.title')} onClose={onClose} dirty={dirty} busy={busy} width={560} testId="transfer-form">
      <form onSubmit={submit}>
        {accounts.length < 2 ? (
          <p className="form-hint" data-testid="transfer-need-accounts">{t('finance.tr.needTwo')}</p>
        ) : (
          <div className="form-grid-2">
            <div className="form-group">
              <label>{t('finance.tr.from')}</label>
              <CrmSelect className="crm-select" value={fromId} onChange={(e) => setFromId(e.target.value)} data-testid="transfer-from">
                <option value="">{t('finance.tr.choose')}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {fmtMoney(a.balance, a.currency)}</option>)}
              </CrmSelect>
            </div>
            <div className="form-group">
              <label>{t('finance.tr.to')}</label>
              <CrmSelect className="crm-select" value={toId} onChange={(e) => setToId(e.target.value)} data-testid="transfer-to">
                <option value="">{t('finance.tr.choose')}</option>
                {accounts.filter((a) => a.id !== fromId).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
              </CrmSelect>
            </div>
            <div className="form-group">
              <label>{from ? t('finance.tr.amountCur').replace('{cur}', from.currency) : t('common.amount')}</label>
              <input className="crm-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" data-testid="transfer-amount" />
            </div>
            {crossCurrency ? (
              <div className="form-group">
                <label>{t('finance.tr.toAmount').replace('{cur}', to!.currency)}</label>
                <input className="crm-input" inputMode="decimal" value={toAmount} onChange={(e) => setToAmount(e.target.value)} placeholder="0" data-testid="transfer-to-amount" />
                {rate && <div className="form-hint" data-testid="transfer-rate">{t('finance.tr.rate').replace('{rate}', rate)}</div>}
              </div>
            ) : (
              <div className="form-group">
                <label>{t('common.date')}</label>
                <CrmDatePicker className="crm-input" value={date} onChange={(v) => setDate(v)} />
              </div>
            )}
            {crossCurrency && (
              <div className="form-group">
                <label>{t('common.date')}</label>
                <CrmDatePicker className="crm-input" value={date} onChange={(v) => setDate(v)} />
              </div>
            )}
            <div className="form-group form-span-2">
              <label>{t('common.comment')}</label>
              <input className="crm-input" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} placeholder={t('finance.tr.commentPh')} data-testid="transfer-comment" />
            </div>
            <p className="form-hint form-span-2">{t('finance.tr.hint')}</p>
          </div>
        )}
        {err && <div className="form-error-text" role="alert" data-testid="transfer-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || accounts.length < 2} data-testid="transfer-save">
            {t('finance.tr.save')}
          </button>
        </div>
      </form>
    </FormModal>
  );
}

/** Карточка перевода: откуда, куда, суммы; отменить может тот, у кого есть право удаления. */
export function TransferDetailModal({ tr, canReverse, onClose }: { tr: FinanceTransfer; canReverse: boolean; onClose: () => void }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const cross = tr.fromAccount.currency !== tr.toAccount.currency;
  const onReverse = async () => {
    const ok = await confirm({
      title: t('finance.tr.reverseQ'),
      message: `${tr.fromAccount.name} → ${tr.toAccount.name}: ${fmtMoney(tr.amount, tr.fromAccount.currency)}`,
      danger: true,
      confirmText: t('finance.tr.reverse'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await reverseTransfer(tr.id);
      toast(t('finance.tr.reversed'), 'success');
      qc.invalidateQueries({ queryKey: keys.finance.all });
      onClose();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open title={t('finance.tr.card')} onClose={onClose} dirty={false} busy={busy} width={520} testId="transfer-detail">
      <div className="fin-tr-flow">
        <span className="fin-tr-acc"><AccountMark account={tr.fromAccount} size={32} />{tr.fromAccount.name}</span>
        <span aria-hidden="true" className="fin-tr-arrow">→</span>
        <span className="fin-tr-acc"><AccountMark account={tr.toAccount} size={32} />{tr.toAccount.name}</span>
      </div>
      <dl className="tx-detail-list">
        <div className="tx-detail-row"><dt>{t('finance.tr.amountOut')}</dt><dd>{fmtMoney(tr.amount, tr.fromAccount.currency)}</dd></div>
        {cross && <div className="tx-detail-row"><dt>{t('finance.tr.amountIn')}</dt><dd>{fmtMoney(tr.toAmount, tr.toAccount.currency)}</dd></div>}
        <div className="tx-detail-row"><dt>{t('common.date')}</dt><dd>{fmtDate(tr.date)}</dd></div>
        <div className="tx-detail-row"><dt>{t('common.comment')}</dt><dd>{tr.comment || '—'}</dd></div>
        {tr.reversedAt && <div className="tx-detail-row"><dt>{t('common.status')}</dt><dd>{t('finance.tr.isReversed')}</dd></div>}
      </dl>
      <div className="form-actions">
        {canReverse && !tr.reversedAt && (
          <button type="button" className="btn btn-danger" onClick={onReverse} disabled={busy} data-testid="transfer-reverse">{t('finance.tr.reverse')}</button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </FormModal>
  );
}
