import { useEffect, useState } from 'react';
import { hiddenAmount } from '../lib/permissions';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { tjDateInput, tjFormatDate } from '../lib/tjTime';
import { coverStages, daysPastDue, type StageCover } from '../lib/stageCoverage';
import { ruPlural } from '../lib/plural';
import Icon from '../Icon';
import CrmDatePicker from './CrmDatePicker';
import {
  listSubmissionStages,
  updatePaymentStage,
  type PaymentStage,
  type PaymentStageStatus,
} from '../api/installments';
import { useEscClose } from '../lib/useEscClose';
import BusyLabel from './BusyLabel';

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

/** Без «Деньги клиентов» суммы приходят null — «•••• TJS». */
const money = (v: number | null | undefined, currency: string) =>
  v == null ? hiddenAmount(currency) : `${v.toLocaleString('ru-RU')} ${currency}`;

export default function PaymentStagesSection({
  submissionId,
  canEdit,
  approved = null,
  pending = null,
  onPay,
}: {
  submissionId: string;
  /** Правит этапы тот же, кто правит сделку: владелец-менеджер или FOUNDER/ADMIN. */
  canEdit: boolean;
  /** Сумма одобренных платежей сделки; null — суммы роли не видны. */
  approved?: number | null;
  /** Сумма платежей, ждущих одобрения. */
  pending?: number | null;
  /** «Принять оплату по этапу»: открыть окно платежа с остатком этапа. */
  onPay?: (amount: number) => void;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState<PaymentStage | null>(null);

  const query = useQuery({
    queryKey: keys.installments.stages(submissionId),
    queryFn: () => listSubmissionStages(submissionId),
  });
  const data = query.data;
  const [picked, setPicked] = useState<string | null>(null);

  // Рассрочки у сделки может не быть вовсе (у программы пустой шаблон) —
  // это норма, а не ошибка: платят разом.
  if (query.isLoading || !data) return null;

  const { stages, totals, currency, totalAmount } = data;
  // Сумм не видно — и править этапы (суммы, сроки) роли нечем.
  const editable = canEdit && !(data as { moneyHidden?: boolean }).moneyHidden;
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

  // Покрытие этапов (lib/stageCoverage — то же правило, что settleStagesTx на
  // сервере); деньги, ждущие одобрения, — полосатая часть шкалы.
  const hidden = approved == null || (data as { moneyHidden?: boolean }).moneyHidden === true;
  const daysLate = daysPastDue;
  const view = coverStages(stages, approved ?? 0, pending ?? 0);
  const current = view.find((v) => v.st.status !== 'PAID') ?? view[view.length - 1];
  const sel = view.find((v) => v.st.id === picked) ?? current;
  const name = (st: PaymentStage) => st.title || `${t('stages.col.title')} ${st.order}`;
  const days = (n: number) => `${n} ${t(ruPlural(n, 'stages.day1', 'stages.day2', 'stages.day5'))}`;
  const amt = (v: number) => money(v, currency);

  const detail = (v: StageCover) => {
    const { st } = v;
    if (st.status === 'PAID') {
      return hidden
        ? t('stages.d.paidHidden').replace('{date}', tjFormatDate(st.paidAt))
        : t('stages.d.paid').replace('{date}', tjFormatDate(st.paidAt)).replace('{sum}', amt(st.amount));
    }
    const late = st.status === 'OVERDUE' ? daysLate(st.dueDate) : 0;
    if (hidden) {
      return st.status === 'OVERDUE'
        ? t('stages.d.lateHidden').replace('{days}', days(late))
        : t('stages.d.dueHidden').replace('{date}', tjFormatDate(st.dueDate));
    }
    const parts: string[] = [];
    if (v.covered > 0) parts.push(t('stages.d.part').replace('{paid}', amt(v.covered)).replace('{sum}', amt(st.amount)));
    if (v.pend > 0) parts.push(t('stages.d.pending').replace('{sum}', amt(v.pend)));
    if (v.rest > 0) {
      parts.push(st.status === 'OVERDUE'
        ? t('stages.d.late').replace('{sum}', amt(v.rest)).replace('{days}', days(late))
        : t('stages.d.due').replace('{sum}', amt(v.rest)).replace('{date}', tjFormatDate(st.dueDate)));
    }
    return parts.join(' ');
  };
  const paidPct = totalAmount > 0 && !hidden ? Math.min(100, ((approved ?? 0) / totalAmount) * 100) : 0;
  const pendPct = totalAmount > 0 && !hidden ? Math.min(100 - paidPct, ((pending ?? 0) / totalAmount) * 100) : 0;
  const canPayStage = !!onPay && !hidden && sel && sel.st.status !== 'PAID' && sel.rest > 0;

  return (
    <>
      {stages.length === 0 ? (
        <div className="card" style={{ padding: 20, marginTop: 24, color: 'var(--text-soft)', fontSize: 13 }} data-testid="stages-empty">
          <b style={{ color: 'var(--text)' }}>{t('stages.title')}:</b> {t('stages.empty')} — {t('stages.emptyHint')}
        </div>
      ) : (
        <section className="card stages-card" aria-label={t('stages.title')} data-testid="stages">
          <div className="stages-head">
            <h3>{t('stages.title')}</h3>
            <span>{t('stages.hint.pick')}</span>
          </div>

          {!reconciled && (
            <div role="alert" className="stages-mismatch">
              <b>{t('stages.mismatch')} — {t('stages.diff')}: {driftLabel}</b>
              <div>{t('stages.mismatch.hint')}</div>
              <div className="stages-mismatch-stats">
                <Stat label={t('stages.total.contract')} value={money(totalAmount, currency)} />
                <Stat label={t('stages.total.plan')} value={money(stagesTotal, currency)} danger />
              </div>
            </div>
          )}

          {!hidden && (
            <div
              className="stages-bar"
              role="img"
              aria-label={t('stages.bar').replace('{paid}', amt(approved ?? 0)).replace('{sum}', amt(totalAmount))}
              data-testid="stages-bar"
            >
              <span className="stages-bar-paid" style={{ width: `${paidPct}%` }} />
              {pendPct > 0 && <span className="stages-bar-pending" style={{ left: `${paidPct}%`, width: `${pendPct}%` }} />}
            </div>
          )}

          <div className="stages-grid">
            {view.map((v) => {
              const { st } = v;
              const state = st.status === 'PAID' ? 'paid' : st.status === 'OVERDUE' ? 'late' : v.partial || v.pend > 0 ? 'part' : 'wait';
              return (
                <button
                  key={st.id}
                  type="button"
                  className={`stage-tile is-${state}${sel?.st.id === st.id ? ' is-picked' : ''}`}
                  aria-pressed={sel?.st.id === st.id}
                  onClick={() => setPicked(st.id)}
                  data-testid={`stage-${st.order}`}
                >
                  <span className="stage-tile-top">
                    <span className="stage-dot" aria-hidden="true">
                      {st.status === 'PAID' ? <Icon name="check" size={16} /> : st.order}
                    </span>
                    <span className="stage-name">{name(st)}</span>
                  </span>
                  <span className="stage-amount">{amt(st.amount)}</span>
                  <span className="stage-due">{t('stages.dueShort').replace('{date}', tjFormatDate(st.dueDate))}</span>
                  <span className={STAGE_BADGE[st.status]} style={{ alignSelf: 'flex-start' }}>
                    {st.status === 'PENDING' && (v.partial || v.pend > 0) ? t('stages.status.part') : t(`stages.status.${st.status}`)}
                  </span>
                </button>
              );
            })}
          </div>

          {sel && (
            <div className="stage-detail" data-testid="stage-detail">
              <span className="stage-detail-text">
                <b>{name(sel.st)}:</b> {detail(sel)}
              </span>
              <span className="stage-detail-actions">
                {editable && (
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => setEditing(sel.st)}
                    title={sel.st.status === 'PAID' ? t('stages.paidLocked') : t('stages.edit')}
                    data-testid="stage-edit"
                  >
                    <Icon name="edit" size={14} /> {t('stages.edit')}
                  </button>
                )}
                {canPayStage && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => onPay!(sel.rest)} data-testid="stage-pay">
                    <Icon name="add" size={14} /> {t('stages.pay')}
                  </button>
                )}
              </span>
            </div>
          )}
        </section>
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
    onSuccess: async (res) => {
      // QA-2: сначала перечитываем список, потом «готово» — без 3–5 с старых данных.
      await Promise.all([qc.invalidateQueries({ queryKey: keys.installments.stages(submissionId) }), qc.invalidateQueries({ queryKey: ['submission', submissionId] })]).catch(() => undefined);
      // Бэк перенёс разницу на другой этап — молчать нельзя: менеджер правил
      // одну строку, а изменились две.
      toast(
        res?.rebalancedStage
          ? `${t('stages.rebalanced')} №${res.rebalancedStage.order}`
          : t('stages.saved'),
        'success',
      );
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  useEscClose(true, onClose, mut.isPending);

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
            <BusyLabel busy={mut.isPending}>{t('common.save')}</BusyLabel>
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
