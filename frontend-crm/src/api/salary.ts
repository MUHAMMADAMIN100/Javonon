import { api } from './client';

export type SalaryStatus = 'DRAFT' | 'PAID';

export interface SalaryRecord {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  workedMinutes: number;
  lateMinutes: number;
  baseAmount: number;
  salesAmount: number;
  bonusAmount: number;
  kpiBonus: number;
  penalties: number;
  netAmount: number;
  currency: string;
  status: SalaryStatus;
  paidAt: string | null;
  comment: string | null;
  createdAt: string;
  user?: { id: string; fullName: string; role: string; email: string };
}

/** Полоса комиссии менеджера. Границы включительные с обеих сторон. */
export interface BonusBand {
  /** Стабильный ключ для i18n-подписи полосы (band1…band5). */
  key: string;
  minAmount: number;
  /** null — верхней границы нет. */
  maxAmount: number | null;
  percent: number;
}

export interface SalaryPreview {
  userId: string;
  user: { id: string; fullName: string; role: string; email: string };
  periodStart: string;
  periodEnd: string;
  workedMinutes: number;
  lateMinutes: number;
  baseAmount: number;
  salesAmount: number;
  bonusAmount: number;
  bonusPercent: number;
  kpiBonus: number;
  penalties: number;
  /** Штрафы по причинам на рассмотрении основателя (не вычитаются). */
  penaltiesPending?: number;
  /** Штрафы по одобренным причинам (отменены, не вычитаются). */
  penaltiesExcused?: number;
  netAmount: number;
  currency: string;

  // ── Расшифровка комиссии (см. backend/src/common/bonus-bands.ts) ──
  // Комиссия flat-по-полосе: ВЕСЬ месячный объём × ставка ОДНОЙ полосы.
  // Объём считается за календарный месяц (Asia/Dushanbe), а не за
  // произвольный период фильтра — поэтому границы приходят отдельно.
  /** Начало месяца, за который считался объём (ISO). */
  bonusPeriodStart?: string;
  /** Конец месяца, за который считался объём (ISO, включительно). */
  bonusPeriodEnd?: string;
  /** Объём продаж за месяц = salesAmount (дублируется явно для расшифровки). */
  bonusVolume?: number;
  /** Полоса, в которую попал объём. maxAmount = null → без верхней границы. */
  bonusBand?: BonusBand;
  /** Комиссия за месяц целиком, до вычета уже начисленного. */
  bonusMonthTotal?: number;
  /**
   * Уже начислено бонуса за этот месяц другими записями зарплаты
   * (аванс + расчёт, две половины месяца). bonusAmount = bonusMonthTotal −
   * bonusAlreadyPaid: месячная комиссия не платится дважды.
   */
  bonusAlreadyPaid?: number;
  /** BAND — ставка из сетки; PERSONAL — персональный процент сотрудника. */
  bonusSource?: 'BAND' | 'PERSONAL';
  /** Вся сетка целиком — чтобы подсветить текущую полосу. */
  bonusBands?: BonusBand[];
  /**
   * Ручные INCOME-транзакции за месяц (импорт / операции без сделки).
   * В объём полосы и в бонус НЕ входят — показываем, чтобы бухгалтер
   * видел их, а не гадал, куда они делись.
   */
  manualSalesAmount?: number;
  /**
   * Разбивка не-TJS продаж (по коду валюты → сумма в исходной валюте).
   * НЕ входят в salesAmount / bonusAmount / netAmount — это
   * информационный breakdown для бухгалтера: видно, что USD/EUR/CNY/RUB
   * активность в периоде была, но требует ручной обработки (или
   * FX-конвертации до APPROVE). Пустой объект / undefined — период
   * чисто в TJS.
   */
  nonTjsSales?: Record<string, number>;
}

export const listSalaries = (params?: { userId?: string; from?: string; to?: string }) =>
  api.get<SalaryRecord[]>('/salary', { params }).then((r) => r.data);

export const previewSalary = (params: {
  userId: string;
  periodStart: string;
  periodEnd: string;
  kpiBonus?: number;
}) => api.get<SalaryPreview>('/salary/preview', { params }).then((r) => r.data);

export const createSalary = (dto: {
  userId: string;
  periodStart: string;
  periodEnd: string;
  kpiBonus?: number;
  comment?: string;
}) => api.post<SalaryRecord>('/salary', dto).then((r) => r.data);

export const paySalary = (id: string) =>
  api.post<SalaryRecord>(`/salary/${id}/pay`).then((r) => r.data);

export const deleteSalary = (id: string) =>
  api.delete(`/salary/${id}`).then((r) => r.data);
