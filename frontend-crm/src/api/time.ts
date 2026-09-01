import { api } from './client';

export type TimeEntryStatus = 'WORKING' | 'ON_LUNCH' | 'OFF';

export interface TimeEntry {
  id: string;
  userId: string;
  status: TimeEntryStatus;
  clockIn: string;
  lunchOut: string | null;
  lunchIn: string | null;
  clockOut: string | null;
  totalMinutes: number;
  totalLunchMinutes: number;
  lateMinutes: number;
  clockInLat?: number | null;
  clockInLon?: number | null;
  clockInProofUrl?: string | null;
  lateExcuseUrl?: string | null;
  lateExcuseReason?: string | null;
  lateExcuseAt?: string | null;
  // По ТЗ §5: статус одобрения причины опоздания основателем.
  // PENDING — ждёт; APPROVED — одобрена; REJECTED — отклонена; null — нет причины.
  lateExcuseStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  lateExcuseReviewedAt?: string | null;
  latePenaltyApplied?: boolean;
  // Опоздание с обеда + объяснение (по аналогии с lateExcuse*).
  lateLunchMinutes?: number;
  lateLunchPenaltyApplied?: boolean;
  lunchLateExcuseUrl?: string | null;
  lunchLateExcuseReason?: string | null;
  lunchLateExcuseAt?: string | null;
  lunchLateExcuseStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  lunchLateExcuseReviewedAt?: string | null;
  date: string;
  createdAt: string;
  updatedAt: string;
}

/** Расширенный ответ lunchIn — добавлен флаг для фронта. */
export interface LunchInResult extends TimeEntry {
  requiresLunchExcuse: boolean;
}

export interface TeamMemberStatus extends TimeEntry {
  user: { id: string; fullName: string; role: string; email: string };
}

export const getToday = () => api.get<TimeEntry | null>('/time/today').then((r) => r.data);
export const getHistory = (params?: { from?: string; to?: string; take?: number }) =>
  api.get<TimeEntry[]>('/time/history', { params }).then((r) => r.data);

export const clockIn = (body?: { lat?: number; lon?: number; proofUrl?: string }) =>
  api.post<TimeEntry>('/time/clock-in', body || {}).then((r) => r.data);

export const lunchOut = () => api.post<TimeEntry>('/time/lunch-out').then((r) => r.data);
export const lunchIn = () => api.post<LunchInResult>('/time/lunch-in').then((r) => r.data);
export const clockOut = () => api.post<TimeEntry>('/time/clock-out').then((r) => r.data);
export const teamStatus = () => api.get<TeamMemberStatus[]>('/time/team').then((r) => r.data);

export const uploadTimeProof = (file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  return api.post<{ url: string; originalName: string; size: number }>(
    '/time/proofs',
    fd,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  ).then((r) => r.data);
};

export const submitLateExcuse = (entryId: string, body: { excuseUrl?: string; excuseReason?: string }) =>
  api.post<TimeEntry>(`/time/${entryId}/excuse`, body).then((r) => r.data);

export const submitLunchLateExcuse = (entryId: string, body: { excuseUrl?: string; excuseReason?: string }) =>
  api.post<TimeEntry>(`/time/${entryId}/lunch-excuse`, body).then((r) => r.data);
