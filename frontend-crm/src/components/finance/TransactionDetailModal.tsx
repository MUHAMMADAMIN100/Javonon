import { Transaction, TRANSACTION_CATEGORY_LABEL } from '../../api/finance';
import FormModal from '../FormModal';
import { useT } from '../../lib/i18n';
import { fmtDate, fmtMoney } from './financeShared';

/**
 * Карточка транзакции по клику на строку журнала.
 *
 * В таблице помещается шесть колонок из пятнадцати полей: способ оплаты,
 * источник, продукт, чек и плательщик оставались невидимыми, и чтобы их
 * посмотреть, приходилось открывать правку. Здесь видно всё сразу, а
 * править может только основатель — см. canEdit.
 */
export default function TransactionDetailModal({
  tx,
  canEdit,
  onClose,
  onEdit,
  onDelete,
}: {
  tx: Transaction;
  canEdit: boolean;
  onClose: () => void;
  onEdit: (tx: Transaction) => void;
  onDelete: (tx: Transaction) => void;
}) {
  const { t } = useT();
  const isIncome = tx.type === 'INCOME';
  const catLabel = t(`finance.cat.${tx.category}`) !== `finance.cat.${tx.category}`
    ? t(`finance.cat.${tx.category}`)
    : TRANSACTION_CATEGORY_LABEL[tx.category];

  const rows: Array<[string, React.ReactNode]> = [
    [t('finance.col.date'), fmtDate(tx.date)],
    [t('finance.col.category'), catLabel],
    [t('finance.col.currency'), tx.currency],
    // У расхода студента нет — там в этом поле плательщик, и подписывать
    // его «Студент» значит путать читающего.
    (tx as any).student?.fullName
      ? [t('finance.col.student'), (tx as any).student.fullName] as [string, React.ReactNode]
      : [t('finance.field.payer'), (tx as any).payerName || '—'] as [string, React.ReactNode],
    [t('finance.col.manager'), (tx as any).manager?.fullName || '—'],
    [t('finance.paymentChannel'), (tx as any).paymentChannel
      ? t(`finance.channel.${(tx as any).paymentChannel}`) : '—'],
    [t('finance.acc.field'), tx.account ? `${tx.account.name} · ${tx.account.currency}` : t('finance.acc.byChannelShort')],
    [t('finance.col.comment'), tx.comment || '—'],
  ];

  return (
    <FormModal
      open
      title={t('finance.tx.details')}
      onClose={onClose}
      dirty={false}
      width={620}
      testId="tx-detail"
    >
      <div className="tx-detail-amount">
        <span className={`badge ${isIncome ? 'badge-success' : 'badge-danger'}`}>
          {isIncome ? t('finance.income') : t('finance.expense')}
        </span>
        <span
          data-testid="tx-detail-amount"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 30,
            fontWeight: 500,
            color: isIncome ? 'var(--primary-dark)' : 'var(--danger)',
          }}
        >
          {isIncome ? '+' : '−'} {fmtMoney(tx.amount, tx.currency)}
        </span>
      </div>

      <dl className="tx-detail-list">
        {rows.map(([label, value]) => (
          <div key={label} className="tx-detail-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {tx.category === 'TUITION_PAYMENT' && (
        <div className="form-hint" data-testid="tx-via-deal" style={{ marginBottom: 12, color: 'var(--text-soft)', fontSize: 13 }}>
          {t('finance.tx.viaDeal')}
        </div>
      )}
      <div className="form-actions">
        {canEdit ? (
          <>
            {tx.category !== 'TUITION_PAYMENT' && (
              <button
                type="button"
                className="btn btn-danger"
                data-testid="tx-delete"
                onClick={() => onDelete(tx)}
              >
                {t('common.delete')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              data-testid="tx-edit"
              onClick={() => onEdit(tx)}
            >
              {t('finance.tx.edit')}
            </button>
          </>
        ) : (
          <span style={{ color: 'var(--text-soft)', fontSize: 13 }}>
            {t('finance.tx.founderOnly')}
          </span>
        )}
      </div>
    </FormModal>
  );
}
