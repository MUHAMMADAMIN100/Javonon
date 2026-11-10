import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import PeriodSwitcher, { useDashboardPeriod } from '../components/PeriodSwitcher';
import FinanceSubnav from '../components/finance/FinanceSubnav';
import FinanceLedger from '../components/finance/FinanceLedger';
import { BalanceCurve, TxCalendar } from '../components/finance/FinanceCalendar';
import TransactionForm from '../components/finance/TransactionForm';
import TransactionDetailModal from '../components/finance/TransactionDetailModal';
import { TransferForm, TransferDetailModal } from '../components/finance/Transfers';
import { MonthNav, monthRange, useYmParam, fmtMoney } from '../components/finance/financeShared';
import {
  type Transaction,
  type TransactionType,
  type FinanceTransfer,
  deleteTransaction,
  getBalanceDays,
  listTransfers,
  loadAllTransactions,
  updateTransaction,
} from '../api/finance';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { useRealtime } from '../realtime';
import { useAuth } from '../store/auth';
import { hasRole, isElevated } from '../lib/roles';
import { roleCan } from '../lib/permissions';

/**
 * «Финансы → Транзакции»: журнал всех денег. Вид «Календарь» — месяц по
 * дням с кривой остатка на счетах; вид «Таблица» — прежний журнал с
 * фильтрами и сортировкой за выбранный период. Вид и месяц — в ссылке.
 */
export default function FinanceTransactions() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const elevated = isElevated(me);
  const hasCustomRole = !!me?.customRole && me.customRole.isActive !== false;
  const managerBaseRole = hasRole(me, 'SALES_MANAGER', 'CLIENT_MANAGER');
  const canCreateTx = roleCan(me, 'finance:create', elevated || (!hasCustomRole && managerBaseRole));
  const canExpense = roleCan(me, 'finance:create', hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT'));
  const canDeleteTx = roleCan(me, 'finance:delete', elevated);
  const canEditTx = roleCan(me, 'finance:update', hasRole(me, 'FOUNDER'));
  const canTransfer = roleCan(me, 'finance:create', elevated);

  const [params, setParams] = useSearchParams();
  const view: 'calendar' | 'table' = params.get('view') === 'table' ? 'table' : 'calendar';
  const setView = (v: 'calendar' | 'table') =>
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (v === 'table') n.set('view', 'table');
      else n.delete('view');
      n.delete('page');
      return n;
    }, { replace: true });
  const [ym, setYm] = useYmParam();
  const period = useDashboardPeriod();

  const [formType, setFormType] = useState<TransactionType | null>(null);
  const [formDate, setFormDate] = useState<string | undefined>(undefined);
  const [showTransfer, setShowTransfer] = useState(false);
  const [openTx, setOpenTx] = useState<Transaction | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [openTransfer, setOpenTransfer] = useState<FinanceTransfer | null>(null);
  const [pickType, setPickType] = useState<string | null>(null);

  const range = monthRange(ym);
  const calOn = view === 'calendar';
  const txQ = useQuery({ queryKey: keys.finance.transactions(range), queryFn: () => loadAllTransactions(range), enabled: calOn });
  const trQ = useQuery({ queryKey: keys.finance.transfers(range), queryFn: () => listTransfers(range), enabled: calOn });
  const balQ = useQuery({ queryKey: keys.finance.balanceDays(ym), queryFn: () => getBalanceDays(ym), enabled: calOn });

  useRealtime({
    'transaction:new': () => qc.invalidateQueries({ queryKey: keys.finance.all }),
    'transaction:updated': () => qc.invalidateQueries({ queryKey: keys.finance.all }),
    'transaction:deleted': () => qc.invalidateQueries({ queryKey: keys.finance.all }),
    'transaction:reversed': () => qc.invalidateQueries({ queryKey: keys.finance.all }),
    'finance:accounts': () => qc.invalidateQueries({ queryKey: keys.finance.all }),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: keys.finance.all });

  const onDeleteTx = async (tx: Transaction) => {
    const ok = await confirm({
      title: t('finance.confirm.delete'),
      message: `${tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')} ${fmtMoney(tx.amount, tx.currency)}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await deleteTransaction(tx.id);
      toast(t('toast.deleted'), 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  // Перенос даты перетаскиванием: сразу в календаре, при ошибке — назад.
  const onMoveTx = async (tx: Transaction, date: string) => {
    const key = keys.finance.transactions(range);
    const prev = qc.getQueryData<Transaction[]>(key);
    qc.setQueryData<Transaction[]>(key, (cur) => (cur ?? []).map((x) => (x.id === tx.id ? { ...x, date: `${date}T00:00:00.000Z` } : x)));
    try {
      await updateTransaction(tx.id, { date });
      toast(t('finance.cal.moved'), 'success');
      refresh();
    } catch (e: any) {
      qc.setQueryData(key, prev);
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const openForm = (type: TransactionType, date?: string) => {
    setFormDate(date);
    setFormType(type);
  };

  return (
    <>
      <FinanceSubnav />
      <div className="fin-toolbar">
        <div className="page-tabs" role="tablist" aria-label={t('finance.txp.view')}>
          {(['calendar', 'table'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={view === k}
              className={`page-tab${view === k ? ' is-active' : ''}`}
              onClick={() => setView(k)}
              data-testid={`txp-view-${k}`}
            >
              <Icon name={k === 'calendar' ? 'calendar_month' : 'table_rows'} size={18} />
              {t(k === 'calendar' ? 'finance.txp.calendar' : 'finance.txp.table')}
            </button>
          ))}
        </div>
        {view === 'calendar' && <MonthNav ym={ym} onChange={setYm} busy={txQ.isFetching} />}
        <div className="fin-toolbar-actions">
          {canCreateTx && (
            <button type="button" className="btn btn-secondary fin-btn-in" onClick={() => openForm('INCOME')} data-testid="finance-new-income">
              <Icon name="add" size={18} /> {t('finance.income')}
            </button>
          )}
          {canExpense && (
            <button type="button" className="btn btn-secondary fin-btn-out" onClick={() => openForm('EXPENSE')} data-testid="finance-new-expense">
              <Icon name="remove" size={18} /> {t('finance.expense')}
            </button>
          )}
          {canTransfer && (
            <button type="button" className="btn btn-secondary" onClick={() => setShowTransfer(true)} data-testid="finance-new-transfer">
              <Icon name="swap_horiz" size={18} /> {t('finance.tr.one')}
            </button>
          )}
        </div>
      </div>

      {view === 'calendar' ? (
        <>
          <BalanceCurve data={balQ.data} loading={balQ.isLoading} />
          {txQ.isError ? (
            <div className="error-banner">{t('finance.cal.error')}</div>
          ) : (
            <TxCalendar
              ym={ym}
              transactions={txQ.data ?? []}
              transfers={trQ.data ?? []}
              canAdd={canCreateTx}
              canMove={canEditTx}
              onOpenTx={setOpenTx}
              onOpenTransfer={setOpenTransfer}
              onAddDay={(date) => (canExpense ? setPickType(date) : openForm('INCOME', date))}
              onMoveTx={onMoveTx}
            />
          )}
        </>
      ) : (
        <>
          <PeriodSwitcher state={period} />
          <FinanceLedger
            range={period.range}
            rangeOk={!period.invalid}
            canReverseTransfer={canDeleteTx}
            canDeleteTx={canDeleteTx}
            onOpenTx={setOpenTx}
            onDeleteTx={onDeleteTx}
          />
        </>
      )}

      {/* «+» в дне: что добавить этой датой. */}
      <AnimatePresence>
        {pickType && (
          <div className="fin-pick-backdrop" role="presentation" onClick={() => setPickType(null)}>
            <div className="fin-pick" role="dialog" aria-modal="true" aria-label={t('finance.cal.add')} onClick={(e) => e.stopPropagation()}>
              <button type="button" className="btn btn-secondary fin-btn-in" autoFocus onClick={() => { const d = pickType; setPickType(null); openForm('INCOME', d); }} data-testid="pick-income">
                <Icon name="add" size={18} /> {t('finance.income')}
              </button>
              <button type="button" className="btn btn-secondary fin-btn-out" onClick={() => { const d = pickType; setPickType(null); openForm('EXPENSE', d); }} data-testid="pick-expense">
                <Icon name="remove" size={18} /> {t('finance.expense')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setPickType(null)}>{t('common.cancel')}</button>
            </div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {formType && (
          <TransactionForm
            preselect={null}
            canExpense={canExpense}
            initialType={formType}
            initialDate={formDate}
            onClose={() => setFormType(null)}
            onCreated={() => { setFormType(null); refresh(); }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showTransfer && <TransferForm initialDate={formDate} onClose={() => setShowTransfer(false)} onDone={() => setShowTransfer(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {openTx && (
          <TransactionDetailModal
            key={openTx.id}
            tx={openTx}
            canEdit={canEditTx}
            onClose={() => setOpenTx(null)}
            onEdit={(tx) => { setOpenTx(null); setEditing(tx); }}
            onDelete={(tx) => { setOpenTx(null); setTimeout(() => canDeleteTx && onDeleteTx(tx), 0); }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {editing && (
          <TransactionForm
            key={`edit-${editing.id}`}
            preselect={null}
            canExpense={canExpense}
            editTx={editing}
            onClose={() => setEditing(null)}
            onCreated={() => { setEditing(null); refresh(); }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {openTransfer && (
          <TransferDetailModal key={openTransfer.id} tr={openTransfer} canReverse={canDeleteTx} onClose={() => setOpenTransfer(null)} />
        )}
      </AnimatePresence>
    </>
  );
}
