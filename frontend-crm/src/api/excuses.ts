import { api } from './client';

export type ExcuseStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ExcuseEntry {
  id: string;
  userId: string;
  clockIn: string;
  lateMinutes: number;
  lateExcuseUrl: string | null;
  lateExcuseReason: string | null;
  lateExcuseAt: string | null;
  lateExcuseStatus: ExcuseStatus | null;
  lateExcuseReviewedAt: string | null;
  lateExcuseReviewedBy: string | null;
  latePenaltyApplied: boolean;
  date: string;
  user: { id: string; fullName: string; role: string; email: string };
}

export const listPendingExcuses = () =>
  api.get<ExcuseEntry[]>('/excuses/pending').then((r) => r.data);

export const listExcuses = (params: { status?: ExcuseStatus; userId?: string; take?: number } = {}) =>
  api.get<ExcuseEntry[]>('/excuses', { params }).then((r) => r.data);

export const approveExcuse = (id: string) =>
  api.post<{ ok: true; penaltiesRemoved: number }>(`/excuses/${id}/approve`).then((r) => r.data);

export const rejectExcuse = (id: string) =>
  api.post<{ ok: true }>(`/excuses/${id}/reject`).then((r) => r.data);
