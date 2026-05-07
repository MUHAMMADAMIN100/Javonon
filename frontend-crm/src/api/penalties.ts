import { api } from './client';

export type PenaltyReason = 'LATE_ARRIVAL' | 'ABSENCE' | 'TASK_OVERDUE' | 'CUSTOM';

export const PENALTY_REASON_LABEL: Record<PenaltyReason, string> = {
  LATE_ARRIVAL: 'Опоздание',
  ABSENCE: 'Прогул',
  TASK_OVERDUE: 'Просроченная задача',
  CUSTOM: 'Прочее',
};

export interface Penalty {
  id: string;
  userId: string;
  reason: PenaltyReason;
  amount: number;
  details: string;
  date: string;
  applied: boolean;
  createdAt: string;
  user?: { id: string; fullName: string; role: string };
}

export const listPenalties = (params?: { userId?: string; from?: string; to?: string; applied?: boolean }) =>
  api.get<Penalty[]>('/penalties', { params }).then((r) => r.data);

export const createPenalty = (data: { userId: string; reason?: PenaltyReason; amount: number; details: string; date?: string }) =>
  api.post<Penalty>('/penalties', data).then((r) => r.data);

export const deletePenalty = (id: string) =>
  api.delete(`/penalties/${id}`).then((r) => r.data);

export const generateYesterdayPenalties = () =>
  api.post<{ created: number; scanned: number }>('/penalties/generate-yesterday').then((r) => r.data);
