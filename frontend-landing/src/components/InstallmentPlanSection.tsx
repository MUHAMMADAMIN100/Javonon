import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  listStudentInstallments,
  type StudentInstallmentPlan,
  type StudentInstallments,
  type StudentPaymentStageStatus,
} from '../studentApi';
import { lkeys } from '../queryClient';
import { tjDateFull, tjDueLabel } from '../tjDate';
import Icon from '../Icon';

/**
 * ГРАФИК РАССРОЧКИ СТУДЕНТА.
 *
 * Только чтение. Этап становится PAID единственным путём — одобрением
 * платежа менеджером, — поэтому здесь нет и не должно появляться никакой
 * кнопки «отметить оплаченным». Заявку на платёж студент подаёт формой ниже,
 * в PaymentsSection; график лишь показывает, что и когда причитается.
 *
 * Просрочку помечаем, но НЕ давим: по решению основателя студента за неё
 * автоматически не преследуют. Отсюда янтарный, а не красный акцент и
 * нейтральная формулировка «мӯҳлат гузаштааст» вместо «шумо қарздоред».
 *
 * Сделок без этапов бэкенд не отдаёт вовсе, а при пустом ответе секция
 * исчезает целиком: у студента без рассрочки нет графика, и пустая карточка
 * ему ничего не сообщает.
 */

const STATUS_LABEL: Record<StudentPaymentStageStatus, string> = {
  PENDING: 'Дар интизори пардохт',
  PAID: 'Пардохт шуд',
  OVERDUE: 'Мӯҳлат гузаштааст',
};

const STATUS_ICON: Record<StudentPaymentStageStatus, string> = {
  PENDING: 'schedule',
  PAID: 'check_circle',
  OVERDUE: 'event_busy',
};

/**
 * Деньги — целые единицы валюты сделки. Дробную часть показываем до двух
 * знаков и только когда она есть: остаток от округления процентов бэкенд
 * кладёт на последний этап, и он может отличаться от круглой доли на копейки.
 * Валюта может прийти неканоничной строкой — тогда Intl со style:'currency'
 * бросит RangeError, поэтому есть запасной путь без него.
 */
function fmtMoney(value: number, currency: string): string {
  const opts: Intl.NumberFormatOptions = { minimumFractionDigits: 0, maximumFractionDigits: 2 };
  if (/^[A-Za-z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: currency.toUpperCase(),
        ...opts,
      }).format(value);
    } catch {
      /* падаем в запасной формат ниже */
    }
  }
  const num = new Intl.NumberFormat('ru-RU', opts).format(value);
  return currency && currency !== '—' ? `${num} ${currency}` : num;
}

export default function InstallmentPlanSection() {
  const query = useQuery<StudentInstallments>({
    queryKey: lkeys.installments.mine(),
    queryFn: listStudentInstallments,
  });

  const plans = query.data?.plans ?? [];
  if (plans.length === 0) return null;

  const outstanding = Object.entries(query.data?.outstandingByCurrency ?? {}).filter(
    ([, sum]) => sum > 0,
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      {/* Общий остаток — только когда планов больше одного: при единственном
          он дословно повторял бы итог внутри карточки. */}
      {plans.length > 1 && outstanding.length > 0 && (
        <div className="stu-card stu-inst-grand" style={{ marginBottom: 16 }}>
          <h2>Ҳамагӣ бояд пардохт шавад</h2>
          <div className="stu-inst-totals">
            {outstanding.map(([currency, sum]) => (
              <div key={currency} className="stu-inst-total-value">
                {fmtMoney(sum, currency)}
              </div>
            ))}
          </div>
        </div>
      )}

      {plans.map((plan) => (
        <PlanCard key={plan.submissionId} plan={plan} />
      ))}
    </motion.div>
  );
}

function PlanCard({ plan }: { plan: StudentInstallmentPlan }) {
  const now = new Date();
  const { totals } = plan;
  const paidPercent =
    plan.totalAmount > 0
      ? Math.min(100, Math.max(0, Math.round((totals.paid / plan.totalAmount) * 100)))
      : 0;

  return (
    <section className="stu-card">
      <div className="stu-inst-head">
        <h2>Ҷадвали пардохт</h2>
        {plan.program && <span className="stu-inst-program">{plan.program.name}</span>}
      </div>

      <div className="stu-inst-summary">
        <div className="stu-inst-sum-item">
          <span className="stu-inst-sum-label">Маблағи шартнома</span>
          <b className="stu-inst-sum-value">{fmtMoney(plan.totalAmount, plan.currency)}</b>
        </div>
        <div className="stu-inst-sum-item">
          <span className="stu-inst-sum-label">Пардохт шуд</span>
          <b className="stu-inst-sum-value paid">{fmtMoney(totals.paid, plan.currency)}</b>
        </div>
        <div className="stu-inst-sum-item">
          <span className="stu-inst-sum-label">Бақия</span>
          <b className="stu-inst-sum-value out">{fmtMoney(totals.outstanding, plan.currency)}</b>
        </div>
      </div>

      <div className="stu-inst-bar">
        <motion.div
          className="stu-inst-bar-fill"
          initial={{ width: 0 }}
          animate={{ width: `${paidPercent}%` }}
          transition={{ duration: 0.5 }}
        />
      </div>

      {totals.outstanding > 0 && totals.nextDueDate && (
        <div className="stu-inst-next">
          <Icon name="event_upcoming" size={16} />
          Пардохти навбатӣ — то {tjDateFull(totals.nextDueDate)}
        </div>
      )}

      <div className="stu-inst-stages">
        {plan.stages.map((stage) => (
          <div key={stage.id} className={`stu-inst-stage ${stage.status.toLowerCase()}`}>
            <div className="stu-inst-stage-no">{stage.order}</div>
            <div className="stu-inst-stage-body">
              <div className="stu-inst-stage-title">
                {stage.title || `Марҳилаи ${stage.order}`}
              </div>
              <div className="stu-inst-stage-due">
                {stage.status === 'PAID'
                  ? `Пардохт шуд${stage.paidAt ? ` · ${tjDateFull(stage.paidAt)}` : ''}`
                  : tjDueLabel(stage.dueDate, now)}
              </div>
            </div>
            <div className="stu-inst-stage-right">
              <div className="stu-inst-stage-amount">{fmtMoney(stage.amount, plan.currency)}</div>
              <span className={`stu-inst-chip ${stage.status.toLowerCase()}`}>
                <Icon name={STATUS_ICON[stage.status]} size={13} />
                {STATUS_LABEL[stage.status]}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Нейтральная подсказка вместо требования погасить: решение о том,
          напоминать ли студенту, остаётся за менеджером. */}
      {totals.outstanding > 0 && (
        <div className="stu-inst-note">
          <Icon name="info" size={16} />
          Аризаро барои пардохт дар поён мефиристед. Агар савол бошад — бо менеҷери
          худ дар тамос шавед.
        </div>
      )}
    </section>
  );
}
