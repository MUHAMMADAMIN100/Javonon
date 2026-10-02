import { api } from './client';

export type ExcuseStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type ExcuseKind = 'arrival' | 'lunch';

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
  // Опоздание с обеда (если kind === 'lunch')
  lateLunchMinutes?: number;
  lunchLateExcuseUrl?: string | null;
  lunchLateExcuseReason?: string | null;
  lunchLateExcuseAt?: string | null;
  lunchLateExcuseStatus?: ExcuseStatus | null;
  lunchLateExcuseReviewedAt?: string | null;
  lateLunchPenaltyApplied?: boolean;
  // Discriminator — какой тип объяснения
  kind: ExcuseKind;
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

export const approveLunchExcuse = (id: string) =>
  api.post<{ ok: true; penaltiesRemoved: number }>(`/excuses/${id}/approve-lunch`).then((r) => r.data);

export const rejectLunchExcuse = (id: string) =>
  api.post<{ ok: true }>(`/excuses/${id}/reject-lunch`).then((r) => r.data);

/**
 * Статус опоздания в «Истории»: решение по причине (APPROVED / REJECTED /
 * PENDING), NONE — причины нет и опоздание от 10 минут (штраф), MINOR —
 * причины нет, короче 10 минут (без штрафа).
 */
export type LatenessStatus = ExcuseStatus | 'NONE' | 'MINOR';
/** Фильтр «История»: пусто — все; not_approved — отклонено или без причины. */
export type LatenessStatusFilter = '' | 'approved' | 'not_approved' | 'pending';

export interface LatenessItem {
  /** id отметки прихода — общий у утра и обеда одного дня. */
  id: string;
  kind: ExcuseKind;
  user: { id: string; fullName: string; email: string; isActive: boolean };
  clockIn: string;
  minutes: number;
  status: LatenessStatus;
  reason: string | null;
  url: string | null;
  reviewedAt: string | null;
  /** Штрафы за этот день и вид опоздания, TJS; 0 — штрафа нет. */
  penalty: number;
}

/** Итоги «Истории» — по всем найденным опозданиям, а не по странице. */
export interface LatenessTotals {
  count: number;
  minutes: number;
  arrivalMinutes: number;
  lunchMinutes: number;
  approvedMinutes: number;
  notApprovedMinutes: number;
  pendingMinutes: number;
  minorMinutes: number;
  penalties: number;
}

export const listLateness = (params: {
  userId?: string;
  from?: string;
  to?: string;
  status?: Exclude<LatenessStatusFilter, ''>;
  page?: number;
  pageSize?: number;
}) =>
  api
    .get<{ items: LatenessItem[]; total: number; page: number; pageSize: number; totals: LatenessTotals }>(
      '/excuses/history',
      { params },
    )
    .then((r) => r.data);
