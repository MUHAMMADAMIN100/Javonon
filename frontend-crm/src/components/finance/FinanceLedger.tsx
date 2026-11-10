import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import CrmSelect from '../CrmSelect';
import Pagination from '../Pagination';
import ListTotal from '../ListTotal';
import DismissedMark from '../DismissedMark';
import { SortSelect, SortTh, useTableSort } from '../TableSort';
import Icon from '../../Icon';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { pageParam, useUrlListState } from '../../lib/useUrlListState';
import {
  type Transaction,
  type TransactionType,
  type IncomeSource,
  type ProductCategoryEnum,
  type PaymentPhaseStatus,
  type FinanceTransfer,
  TRANSACTION_CATEGORY_LABEL,
  loadAllTransactions,
  listTransfers,
} from '../../api/finance';
import { AccountMark, fmtDate, fmtMoney } from './financeShared';
import { TransferDetailModal } from './Transfers';

/** Строк на странице журнала. Десять — как просили: экран не листается. */
const TX_PAGE_SIZE = 10;

type LedgerFilter = TransactionType | 'TRANSFER' | '';

/**
 * Журнал операций (вид «Таблица» на «Финансы → Транзакции»). Переехал со
 * старой страницы «Финансы» без изменений поведения: все операции периода
 * (loadAllTransactions), сортировка, фильтры источника/продукта/фазы, десять
 * строк на странице, карточка по клику. Добавлены колонка «Счёт» и переводы
 * между счетами (фильтр «Переводы» и отдельный блок под журналом).
 */
export default function FinanceLedger({
  range,
  rangeOk,
  canReverseTransfer,
  canDeleteTx,
  onOpenTx,
  onDeleteTx,
}: {
  range: { from?: string; to?: string };
  rangeOk: boolean;
  canReverseTransfer: boolean;
  canDeleteTx: boolean;
  onOpenTx: (tx: Transaction) => void;
  onDeleteTx: (tx: Transaction) => void;
}) {
  const { t } = useT();
  const [filterType, setFilterType] = useState<LedgerFilter>('');
  const [filterIncomeSource, setFilterIncomeSource] = useState<IncomeSource | ''>('');
  const [filterProductEnum, setFilterProductEnum] = useState<ProductCategoryEnum | ''>('');
  const [filterPaymentPhase, setFilterPaymentPhase] = useState<PaymentPhaseStatus | ''>('');
  const [openTransfer, setOpenTransfer] = useState<FinanceTransfer | null>(null);
  // Страница журнала — в ссылке, как в остальных списках CRM.
  const { values: txUrl, setValue: setTxUrl } = useUrlListState({ page: pageParam() }, { pageKey: 'page' });
  const { page: txPage } = txUrl;

  // Журнал — ВСЕ операции периода (порциями): счётчик, фильтры, сортировка и
  // страницы считаются в браузере. Ключ без типа общий с окнами у карточек
  // «Обзора» и префетчем меню.
  const txType = filterType === 'INCOME' || filterType === 'EXPENSE' ? filterType : undefined;
  const txParams = {
    ...(txType ? { type: txType } : {}),
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
  };
  const txQuery = useQuery({
    queryKey: keys.finance.transactions(txParams),
    queryFn: () => loadAllTransactions(txParams),
    enabled: rangeOk && filterType !== 'TRANSFER',
  });
  const transfersQuery = useQuery({
    queryKey: keys.finance.transfers(range),
    queryFn: () => listTransfers(range),
    enabled: rangeOk,
  });
  const transfers = transfersQuery.data ?? [];
  const allTransactions = filterType === 'TRANSFER' ? [] : txQuery.data ?? [];
  const transactions = useMemo(() => {
    if (!filterIncomeSource && !filterProductEnum && !filterPaymentPhase) return allTransactions;
    return allTransactions.filter((tx) => {
      if (filterIncomeSource && tx.incomeSource !== filterIncomeSource) return false;
      if (filterProductEnum && tx.productCategoryEnum !== filterProductEnum) return false;
      if (filterPaymentPhase && tx.paymentPhase !== filterPaymentPhase) return false;
      return true;
    });
  }, [allTransactions, filterIncomeSource, filterProductEnum, filterPaymentPhase]);

  const categoryLabel = (tx: Transaction) =>
    t(`finance.cat.${tx.category}`) !== `finance.cat.${tx.category}` ? t(`finance.cat.${tx.category}`) : TRANSACTION_CATEGORY_LABEL[tx.category];
  const txSort = useTableSort(
    transactions,
    [
      { key: 'date', label: t('finance.col.date'), type: 'date', value: (tx) => tx.date },
      { key: 'type', label: t('finance.col.type'), value: (tx) => (tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')) },
      { key: 'category', label: t('finance.col.category'), value: categoryLabel },
      { key: 'amount', label: t('finance.col.amount'), type: 'number', value: (tx) => Number(tx.amount) },
      { key: 'account', label: t('finance.acc.field'), value: (tx) => tx.account?.name },
      { key: 'student', label: t('finance.col.student'), value: (tx) => tx.student?.fullName || tx.manager?.fullName },
      { key: 'comment', label: t('finance.col.comment'), value: (tx) => tx.comment },
    ],
    { pageParam: 'page' },
  );
  const paged = txSort.sorted.slice((txPage - 1) * TX_PAGE_SIZE, txPage * TX_PAGE_SIZE);
  // Фильтры могут сократить список так, что текущей страницы уже нет.
  useEffect(() => {
    const last = Math.max(1, Math.ceil(transactions.length / TX_PAGE_SIZE));
    if (txPage > last) setTxUrl('page', 1);
  }, [transactions.length, txPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const pill = (value: LedgerFilter, label: string, testId: string) => (
    <button className={filterType === value ? 'active' : ''} onClick={() => setFilterType(value)} data-testid={testId}>
      {label}
    </button>
  );
  const liveTransfers = transfers.filter((x) => !x.reversedAt);

  return (
    <>
      <div className="crm-section-head">
        <h2 className="crm-section-title">{t('finance.ledger')}</h2>
        {filterType !== 'TRANSFER' && (
          <ListTotal
            noun="transactions"
            found={transactions.length}
            total={transactions.length !== allTransactions.length ? allTransactions.length : undefined}
            filtered={transactions.length !== allTransactions.length}
            testId="finance-tx-total"
          />
        )}
      </div>

      <div className="filters" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div className="pagination-controls" style={{ padding: 4 }}>
          {pill('', t('common.all'), 'ledger-all')}
          {pill('INCOME', t('finance.income'), 'ledger-income')}
          {pill('EXPENSE', t('finance.expense'), 'ledger-expense')}
          {pill('TRANSFER', t('finance.tr.plural'), 'ledger-transfers')}
        </div>
        {(filterType === '' || filterType === 'INCOME') && (
          <>
            <CrmSelect className="crm-select" value={filterIncomeSource} onChange={(e) => setFilterIncomeSource(e.target.value as IncomeSource | '')} style={{ minWidth: 160 }} aria-label={t('finance.field.incomeSource')}>
              <option value="">{t('finance.field.incomeSource')}: {t('common.all')}</option>
              <option value="NEW_CLIENT">{t('finance.source.NEW_CLIENT')}</option>
              <option value="UP_SALE">{t('finance.source.UP_SALE')}</option>
              <option value="OTHER">{t('finance.source.OTHER')}</option>
            </CrmSelect>
            <CrmSelect className="crm-select" value={filterProductEnum} onChange={(e) => setFilterProductEnum(e.target.value as ProductCategoryEnum | '')} style={{ minWidth: 160 }} aria-label={t('finance.field.productEnum')}>
              <option value="">{t('finance.field.productEnum')}: {t('common.all')}</option>
              <option value="CONTRACT">{t('finance.productEnum.CONTRACT')}</option>
              <option value="MASTERCLASS">{t('finance.productEnum.MASTERCLASS')}</option>
              <option value="ACADEMY">{t('finance.productEnum.ACADEMY')}</option>
              <option value="OTHER">{t('finance.productEnum.OTHER')}</option>
            </CrmSelect>
            <CrmSelect className="crm-select" value={filterPaymentPhase} onChange={(e) => setFilterPaymentPhase(e.target.value as PaymentPhaseStatus | '')} style={{ minWidth: 160 }} aria-label={t('finance.field.paymentPhase')}>
              <option value="">{t('finance.field.paymentPhase')}: {t('common.all')}</option>
              <option value="PREPAID">{t('finance.phase.PREPAID')}</option>
              <option value="FULL">{t('finance.phase.FULL')}</option>
            </CrmSelect>
            {(filterIncomeSource || filterProductEnum || filterPaymentPhase) && (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setFilterIncomeSource(''); setFilterProductEnum(''); setFilterPaymentPhase(''); }}>
                <Icon name="close" size={14} /> {t('common.reset')}
              </button>
            )}
          </>
        )}
      </div>

      {filterType !== 'TRANSFER' && (
        <>
          {transactions.length > 0 && <SortSelect sort={txSort} />}
          <div className="card" style={{ padding: 0 }}>
            <table className="table" style={{ width: '100%' }} data-testid="tx-table">
              <thead>
                <tr>
                  {txSort.columns.map((c) => <SortTh key={c.key} sort={txSort} col={c.key} />)}
                  <th><span className="sr-only">{t('common.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {txQuery.isLoading && (
                  <tr><td colSpan={8} className="empty">{t('common.loading')}</td></tr>
                )}
                {!txQuery.isLoading && transactions.length === 0 && (
                  <tr><td colSpan={8} className="empty">{t('finance.empty')}</td></tr>
                )}
                {paged.map((tx) => (
                  <tr
                    key={tx.id}
                    className="tx-row"
                    data-testid={`tx-row-${tx.id}`}
                    role="button"
                    tabIndex={0}
                    title={t('finance.tx.details')}
                    onClick={() => onOpenTx(tx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenTx(tx); }
                    }}
                  >
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{fmtDate(tx.date)}</td>
                    <td data-label={txSort.label('type')}>
                      <span className={`badge ${tx.type === 'INCOME' ? 'badge-success' : 'badge-danger'}`}>
                        {tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')}
                      </span>
                    </td>
                    <td data-label={txSort.label('category')}>{categoryLabel(tx)}</td>
                    <td data-label={txSort.label('amount')} className={`fin-money ${tx.type === 'INCOME' ? 'is-in' : 'is-out'}`}>
                      {tx.type === 'INCOME' ? '+' : '−'} {fmtMoney(tx.amount, tx.currency)}
                    </td>
                    <td data-label={txSort.label('account')} style={{ fontSize: 13 }}>
                      {tx.account ? (
                        <span className="fin-acc-inline"><AccountMark account={tx.account} size={20} />{tx.account.name}</span>
                      ) : (
                        <span style={{ color: 'var(--text-light)' }} title={t('finance.acc.byChannelHint')}>{t('finance.acc.byChannelShort')}</span>
                      )}
                    </td>
                    <td data-label={txSort.label('student')} style={{ fontSize: 13 }}>
                      {tx.student && <div>{tx.student.fullName}</div>}
                      {tx.manager && <div style={{ color: 'var(--text-soft)' }}>{tx.manager.fullName}<DismissedMark person={tx.manager} /></div>}
                      {!tx.student && !tx.manager && <span style={{ color: 'var(--text-light)' }}>—</span>}
                    </td>
                    <td data-label={txSort.label('comment')} className="td-stack" style={{ color: 'var(--text-soft)', fontSize: 13 }}>{tx.comment || '—'}</td>
                    <td>
                      {/* Платёж по сделке удаляют в сделке (QA №48/53) — корзины нет. */}
                      {canDeleteTx && tx.category !== 'TUITION_PAYMENT' && (
                        <button
                          className="btn btn-sm btn-danger"
                          data-testid="tx-row-delete"
                          title={t('common.delete')}
                          aria-label={t('common.delete')}
                          onClick={(e) => { e.stopPropagation(); onDeleteTx(tx); }}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Icon name="delete" size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={txPage} total={transactions.length} pageSize={TX_PAGE_SIZE} onChange={(n) => setTxUrl('page', n)} />
        </>
      )}

      {(filterType === 'TRANSFER' || (filterType === '' && liveTransfers.length > 0)) && (
        <section className="fin-transfers" data-testid="ledger-transfers-block">
          <h3 className="fin-subtitle">{t('finance.tr.blockTitle')}</h3>
          <div className="card" style={{ padding: 0 }}>
            <table className="table" style={{ width: '100%' }} data-testid="transfers-table">
              <thead>
                <tr>
                  <th>{t('finance.col.date')}</th>
                  <th>{t('finance.tr.from')}</th>
                  <th>{t('finance.tr.to')}</th>
                  <th>{t('finance.col.amount')}</th>
                  <th>{t('finance.col.comment')}</th>
                </tr>
              </thead>
              <tbody>
                {transfers.length === 0 && (
                  <tr><td colSpan={5} className="empty">{transfersQuery.isLoading ? t('common.loading') : t('finance.tr.empty')}</td></tr>
                )}
                {transfers.map((tr) => (
                  <tr
                    key={tr.id}
                    className={`tx-row${tr.reversedAt ? ' is-reversed' : ''}`}
                    role="button"
                    tabIndex={0}
                    data-testid={`transfer-row-${tr.id}`}
                    onClick={() => setOpenTransfer(tr)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenTransfer(tr); } }}
                  >
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{fmtDate(tr.date)}</td>
                    <td data-label={t('finance.tr.from')}><span className="fin-acc-inline"><AccountMark account={tr.fromAccount} size={20} />{tr.fromAccount.name}</span></td>
                    <td data-label={t('finance.tr.to')}><span className="fin-acc-inline"><AccountMark account={tr.toAccount} size={20} />{tr.toAccount.name}</span></td>
                    <td data-label={t('finance.col.amount')} className="fin-money">
                      {fmtMoney(tr.amount, tr.fromAccount.currency)}
                      {tr.fromAccount.currency !== tr.toAccount.currency && <span className="fin-money-sub"> → {fmtMoney(tr.toAmount, tr.toAccount.currency)}</span>}
                      {tr.reversedAt && <span className="badge badge-gray" style={{ marginLeft: 8 }}>{t('finance.tr.isReversed')}</span>}
                    </td>
                    <td data-label={t('finance.col.comment')} className="td-stack" style={{ color: 'var(--text-soft)', fontSize: 13 }}>{tr.comment || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <AnimatePresence>
        {openTransfer && (
          <TransferDetailModal key={openTransfer.id} tr={openTransfer} canReverse={canReverseTransfer} onClose={() => setOpenTransfer(null)} />
        )}
      </AnimatePresence>
    </>
  );
}
