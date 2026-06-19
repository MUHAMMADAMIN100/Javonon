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
  overtimeMinutes?: number;
  /** Доплата за переработку (overtimeMinutes × hourlyRate × multiplier). */
  overtimePay?: number;
  overtimeMultiplier?: number;
  /** Какой этап тарифной сетки применился (если bonusPercent не override). */
  bonusTierId?: string | null;
  bonusTierComment?: string | null;
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
