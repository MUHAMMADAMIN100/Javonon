import type { PaymentStage } from '../api/installments';
import { tjDateInput, tjToday } from './tjTime';

/** Одна строка шкалы этапов: сколько этапа покрыто одобренными деньгами, сколько ждёт одобрения и сколько осталось. */
export type StageCover = { st: PaymentStage; covered: number; pend: number; rest: number; partial: boolean };

/**
 * Покрытие этапов — тем же правилом, что и на сервере (settleStagesTx):
 * одобренные деньги закрывают этапы по порядку, частично — текущий. Деньги,
 * ждущие одобрения, ложатся следом. Карточка сделки берёт отсюда и шкалу
 * этапов, и плитку «Просрочено» — одна арифметика на оба места.
 */
export function coverStages(stages: PaymentStage[], approved: number, pending: number): StageCover[] {
  let left = approved;
  let leftPending = pending;
  return [...stages]
    .sort((x, y) => x.order - y.order)
    .map((st) => {
      const covered = st.status === 'PAID' ? st.amount : Math.max(0, Math.min(st.amount, left));
      left = Math.max(0, left - st.amount);
      const pend = st.status === 'PAID' ? 0 : Math.max(0, Math.min(st.amount - covered, leftPending));
      leftPending = Math.max(0, leftPending - pend);
      const rest = Math.max(0, Math.round((st.amount - covered - pend) * 100) / 100);
      return { st, covered, pend, rest, partial: st.status !== 'PAID' && covered > 0 };
    });
}

/** Сколько полных дней прошло после срока (по Душанбе); 0 — срок сегодня или впереди. */
export function daysPastDue(due: string): number {
  return Math.max(0, Math.round((Date.parse(tjToday()) - Date.parse(tjDateInput(due))) / 86400000));
}
