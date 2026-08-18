import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { tjDateInput, tjFormatDate } from '../lib/tjTime';
import Icon from '../Icon';
import CrmDatePicker from './CrmDatePicker';
import {
  listSubmissionStages,
  updatePaymentStage,
  type PaymentStage,
  type PaymentStageStatus,
} from '../api/installments';

/**
 * Этапы рассрочки в карточке сделки.
 *
 * PAID здесь только ЧИТАЕТСЯ. Единственный путь этапа в «оплачен» — одобрение
 * SubmissionPayment (InstallmentsService.settleStagesTx); кнопки «отметить
 * оплаченным» тут нет и быть не должно, иначе появится второй источник правды
 * и он разъедется с финансами.
 *
 * Суммы — в тех же единицах, что и суммы сделки (целые единицы валюты,
 * не центы), поэтому форматируем ровно как totalAmount на этой же странице.
 *
 * СВЕДЕНИЕ С КОНТРАКТОМ. Сумма этапов обязана в точности равняться сумме
 * контракта (инвариант бэка), поэтому обе цифры стоят рядом в шапке: без
 * них расхождение не видно вообще — «оплачено/остаток/просрочено» сходятся
 * между собой при любой сумме плана. А цена расхождения — деньги: план
 * больше контракта даёт этап, который не закроется никогда (вечная
 * просрочка при том, что финансы считают контракт закрытым), план меньше
 * контракта гасит все этапы и стирает реальный долг с дашборда.
 */

/**
 * Статус этапа — семантическими классами дизайн-системы (.badge-*), а не
 * инлайновым цветом: в них уже подобран затемнённый текст под белый фон
 * (badge-danger #b91c1c = 6.9:1). Яркие 500-е оттенки на белом дают 2.5–3.8:1
 * и не проходят WCAG AA для 11px текста бейджа.
 */
const STAGE_BADGE: Record<PaymentStageStatus, string> = {
  PENDING: 'badge badge-info',
  PAID: 'badge badge-success',
  OVERDUE: 'badge badge-danger',
};

/** Красный только как заливка/бордюр строки — текстом он нечитаем. */
const OVERDUE_FILL = '#ef4444';
/** Тот же danger-текст, что и в .badge-danger: читается и на белом, и на подсветке строки. */
const DANGER_TEXT = '#b91c1c';

const money = (v: number, currency: string) => `${v.toLocaleString('ru-RU')} ${currency}`;

export default function PaymentStagesSection({
  submissionId,
  canEdit,
}: {
  submissionId: string;
  /** Правит этапы тот же, кто правит сделку: владелец-менеджер или FOUNDER/ADMIN. */
  canEdit: boolean;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState<PaymentStage | null>(null);

  const query = useQuery({
    queryKey: keys.installments.stages(submissionId),
    queryFn: () => listSubmissionStages(submissionId),
  });
  const data = query.data;

  // Рассрочки у сделки может не быть вовсе (у программы пустой шаблон) —
  // это норма, а не ошибка: платят разом.
  if (query.isLoading || !data) return null;

  const { stages, totals, currency, totalAmount } = data;
  // Сведение считает БЭК — своим эпсилоном (0.01, тот же, что у кассы). Фронт
  // границу «сходится/нет» не пересчитывает, чтобы она была одна на систему.
  // На выкатке бандл может опередить рестарт API, и ответ придёт без этих
  // полей: читаем такой ответ как «план равен контракту» — иначе карточка
  // упала бы на форматировании undefined и пугала расхождением, которого
  // никто не считал.
  const stagesTotal = Number.isFinite(data.stagesTotal) ? data.stagesTotal : totalAmount;
  const amountDrift = Number.isFinite(data.amountDrift) ? data.amountDrift : 0;
  const reconciled = data.reconciled !== false;
  const driftLabel = `${amountDrift > 0 ? '+' : ''}${money(amountDrift, currency)}`;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 24, marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>
          {t('stages.title')} ({stages.length})
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {stages.length > 0 && !reconciled && (
            <span className="badge badge-warning">
              {t('stages.mismatch')}: {driftLabel}
            </span>
          )}
          {totals.overdueCount > 0 && (
            <span className="badge badge-danger">
              {t('stages.total.overdue')}: {money(totals.overdueAmount, currency)}
            </span>
          )}
        </div>
      </div>

      {stages.length === 0 ? (
        <div className="card" style={{ padding: 20, color: 'var(--text-soft)', fontSize: 13 }}>
          {t('stages.empty')} — {t('stages.emptyHint')}
        </div>
      ) : (
        <motion.div className="card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 20 }}>
          {!reconciled && (
            <div
              role="alert"
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${OVERDUE_FILL}`,
                background: 'rgba(239,68,68,0.08)',
                color: DANGER_TEXT,
                fontSize: 12,
                marginBottom: 16,
              }}
            >
              <b>
                {t('stages.mismatch')} — {t('stages.diff')}: {driftLabel}
              </b>
              <div style={{ marginTop: 4, color: 'var(--text)' }}>{t('stages.mismatch.hint')}</div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 16 }}>
            {/* Контракт и план стоят рядом намеренно: расхождение между ними
                не выводится ни из одной другой цифры этой карточки. */}
            <Stat label={t('stages.total.contract')} value={money(totalAmount, currency)} />
            <Stat
              label={t('stages.total.plan')}
              value={money(stagesTotal, currency)}
              danger={!reconciled}
            />
            <Stat label={t('stages.total.paid')} value={money(totals.paid, currency)} />
            <Stat label={t('stages.total.outstanding')} value={money(totals.outstanding, currency)} highlight />
            <Stat label={t('stages.total.overdue')} value={money(totals.overdueAmount, currency)} danger={totals.overdueCount > 0} />
            <Stat
              label={t('stages.total.next')}
              value={totals.nextDueDate ? tjFormatDate(totals.nextDueDate) : '—'}
            />
          </div>

          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 44 }}>{t('stages.col.order')}</th>
                  <th>{t('stages.col.title')}</th>
                  <th>{t('stages.col.due')}</th>
                  <th style={{ textAlign: 'right' }}>{t('stages.col.amount')}</th>
                  <th>{t('stages.col.status')}</th>
                  {canEdit && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {stages.map((s) => (
                  <tr
                    key={s.id}
                    style={
                      s.status === 'OVERDUE'
                        ? { background: 'rgba(239,68,68,0.08)', borderLeft: `3px solid ${OVERDUE_FILL}` }
                        : undefined
                    }
                  >
                    <td style={{ color: 'var(--text-soft)' }}>{s.order}</td>
                    <td style={{ fontWeight: 500 }}>
                      {s.title || `${t('stages.col.title')} ${s.order}`}
                    </td>
                    <td style={{ color: s.status === 'OVERDUE' ? DANGER_TEXT : 'var(--text-soft)', fontWeight: s.status === 'OVERDUE' ? 600 : 400 }}>
                      {tjFormatDate(s.dueDate)}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {money(s.amount, currency)}
                    </td>
                    <td>
                      <span className={STAGE_BADGE[s.status]}>
                        {t(`stages.status.${s.status}`)}
                      </span>
                      {s.status === 'PAID' && s.paidAt && (
                        <span style={{ fontSize: 11, color: 'var(--text-soft)', marginLeft: 6 }}>
                          {tjFormatDate(s.paidAt)}
                        </span>
                      )}
                    </td>
                    {canEdit && (
                      <td>
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => setEditing(s)}
                          title={s.status === 'PAID' ? t('stages.paidLocked') : t('stages.edit')}
                        >
                          <Icon name="edit" size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 12, marginBottom: 0 }}>
            {t('stages.hint.settle')}
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 6, marginBottom: 0 }}>
            {t('stages.hint.reconcile')}
          </p>
        </motion.div>
      )}

      <AnimatePresence>
        {editing && (
          <EditStageModal
            stage={editing}
            currency={currency}
            submissionId={submissionId}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function Stat({ label, value, highlight, danger }: { label: string; value: string; highlight?: boolean; danger?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginTop: 2,
          color: danger ? DANGER_TEXT : highlight ? 'var(--primary-dark)' : 'var(--text)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function EditStageModal({
  stage,
  currency,
  submissionId,
  onClose,
}: {
  stage: PaymentStage;
  currency: string;
  submissionId: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();

  const locked = stage.status === 'PAID';
  const [title, setTitle] = useState(stage.title || '');
  const [amount, setAmount] = useState(String(stage.amount));
  const [dueDate, setDueDate] = useState(tjDateInput(stage.dueDate));

  const mut = useMutation({
    mutationFn: () =>
      updatePaymentStage(stage.id, {
        title: title.trim(),
        // Оплаченный этап правится только по названию: сумма и срок у него
        // уже сведены с одобренным платежом (бэк вернёт 400 на попытку).
        ...(locked ? {} : { amount: parseFloat(amount), dueDate }),
      }),
    onSuccess: (res) => {
      // Бэк перенёс разницу на другой этап — молчать нельзя: менеджер правил
      // одну строку, а изменились две.
      toast(
        res?.rebalancedStage
          ? `${t('stages.rebalanced')} №${res.rebalancedStage.order}`
          : t('stages.saved'),
        'success',
      );
      qc.invalidateQueries({ queryKey: keys.installments.stages(submissionId) });
      qc.invalidateQueries({ queryKey: ['submission', submissionId] });
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mut.isPending) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, mut.isPending]);

  const parsed = parseFloat(amount);
  const canSubmit = locked || (isFinite(parsed) && parsed > 0 && !!dueDate);

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !mut.isPending && onClose()}
    >
      <motion.div
        className="dialog-card"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 460, textAlign: 'left' }}
      >
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>
          {t('stages.edit')} №{stage.order}
        </h3>

        {locked ? (
          <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-soft)', fontSize: 12, color: 'var(--text-soft)', marginBottom: 12 }}>
            {t('stages.paidLocked')}
          </div>
        ) : (
          <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-soft)', fontSize: 12, color: 'var(--text-soft)', marginBottom: 12 }}>
            {t('stages.hint.reconcile')}
          </div>
        )}

        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <label style={fieldLabel}>{t('stages.col.title')}</label>
            <input className="crm-input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label style={fieldLabel}>{`${t('stages.col.amount')} (${currency})`}</label>
            <input
              className="crm-input"
              type="number"
              min={0}
              step={1}
              value={amount}
              disabled={locked}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <label style={fieldLabel}>{t('stages.col.due')}</label>
            <CrmDatePicker value={dueDate} onChange={setDueDate} disabled={locked} />
          </div>
        </div>

        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => mut.mutate()} disabled={!canSubmit || mut.isPending}>
            {mut.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

const fieldLabel: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-soft)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 4,
  display: 'block',
};
