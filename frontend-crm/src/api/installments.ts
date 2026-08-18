import { api } from './client';

/**
 * Рассрочка (backend/src/installments).
 *
 * Два уровня:
 *   1. ШАБЛОН программы — доли в процентах + сдвиг срока в днях. Живёт на
 *      `/programs/:id/installment-template` (наследует permission-префикс
 *      `/programs`, отдельного ключа для кастомных ролей не нужно).
 *   2. ЭТАПЫ сделки (PaymentStage) — материализованный шаблон. Живут на
 *      `/submissions/:id/stages` по той же причине.
 *
 * ЕДИНСТВЕННЫЙ путь этапа в PAID — одобрение SubmissionPayment. В UI нет и
 * не должно быть кнопки «отметить оплаченным»: второй источник правды
 * разъедется с финансами.
 *
 * Деньги — те же единицы, что у сумм сделки (SaleSubmission.totalAmount,
 * SubmissionPayment.amount): целые единицы валюты, НЕ центы.
 */

export type PaymentStageStatus = 'PENDING' | 'PAID' | 'OVERDUE';

/** Этап шаблона программы. */
export interface ProgramInstallmentStage {
  id: string;
  programId: string;
  order: number;
  title: string | null;
  /** Доля от суммы контракта, 0 < percent <= 100. */
  percent: number;
  /** Сдвиг срока от заключения сделки в календарных днях. */
  offsetDays: number;
  createdAt: string;
  updatedAt: string;
}

/** То, что уходит на сохранение шаблона (PUT-семантика: что прислали — то и лежит). */
export interface InstallmentTemplateStageInput {
  title?: string;
  percent: number;
  offsetDays?: number;
}

/** Материализованный этап конкретной сделки. */
export interface PaymentStage {
  id: string;
  submissionId: string;
  order: number;
  title: string | null;
  amount: number;
  dueDate: string;
  status: PaymentStageStatus;
  paidAt: string | null;
  paymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentStageTotals {
  stageCount: number;
  paid: number;
  outstanding: number;
  overdueAmount: number;
  overdueCount: number;
  nextDueDate: string | null;
}

export interface SubmissionStages {
  submissionId: string;
  currency: string;
  totalAmount: number;
  /**
   * Сумма этапов плана. Инвариант бэка — она РАВНА totalAmount до копейки
   * (backend/src/installments: сведение при правке этапа и пересборка при
   * правке суммы контракта), поэтому расхождение здесь означает строки,
   * залитые в обход API, или сделку, созданную до появления сведения.
   */
  stagesTotal: number;
  /** stagesTotal - totalAmount. Ноль в норме; знак показывает направление. */
  amountDrift: number;
  /** `Math.abs(amountDrift) <= 0.01`. Считает бэк — тем же эпсилоном, что и касса. */
  reconciled: boolean;
  stages: PaymentStage[];
  totals: PaymentStageTotals;
}

export interface UpdatePaymentStageDto {
  title?: string;
  amount?: number;
  /** `YYYY-MM-DD` — бэк парсит как душанбинскую дату. */
  dueDate?: string;
}

// ── Шаблон программы ───────────────────────────────────────────────────────

export async function getInstallmentTemplate(programId: string) {
  const { data } = await api.get<ProgramInstallmentStage[]>(
    `/programs/${programId}/installment-template`,
  );
  return data;
}

export async function saveInstallmentTemplate(
  programId: string,
  stages: InstallmentTemplateStageInput[],
) {
  const { data } = await api.put<ProgramInstallmentStage[]>(
    `/programs/${programId}/installment-template`,
    { stages },
  );
  return data;
}

// ── Этапы сделки ───────────────────────────────────────────────────────────

export async function listSubmissionStages(submissionId: string) {
  const { data } = await api.get<SubmissionStages>(`/submissions/${submissionId}/stages`);
  return data;
}

/**
 * Правка этапа — это ПЕРЕРАСПРЕДЕЛЕНИЕ внутри суммы контракта, а не её
 * изменение: сколько прибавили здесь, столько бэк снял с последнего
 * неоплаченного этапа (и наоборот). Когда так и случилось, он возвращает
 * этот второй этап в `rebalancedStage` — менеджеру обязательно нужно
 * сказать, что изменилась не одна строка, а две. Общая сумма меняется только
 * через сумму контракта в карточке сделки.
 */
export async function updatePaymentStage(stageId: string, payload: UpdatePaymentStageDto) {
  const { data } = await api.patch<
    PaymentStage & { rebalancedStage?: { id: string; order: number; amount: number } }
  >(`/submissions/stages/${stageId}`, payload);
  return data;
}

/**
 * Как бэк раскладывает проценты по сумме контракта: остаток от округления
 * падает на ПОСЛЕДНИЙ этап, чтобы сумма этапов совпадала с контрактом до
 * копейки. Здесь — только для предпросмотра шаблона в карточке программы;
 * реальные суммы всегда считает сервер.
 */
export function previewStageAmounts(percents: number[], total: number): number[] {
  if (percents.length === 0 || !isFinite(total)) return [];
  // Один в один с backend allocateStageAmounts: считаем в копейках, последний
  // этап получает ОСТАТОК, а не свою долю.
  const totalCents = Math.round(total * 100);
  const out: number[] = [];
  let allocated = 0;
  for (let i = 0; i < percents.length - 1; i++) {
    const cents = Math.round((totalCents * percents[i]) / 100);
    allocated += cents;
    out.push(cents / 100);
  }
  out.push((totalCents - allocated) / 100);
  return out;
}
