import { api } from './client';

export interface DailyReport {
  id: string;
  userId: string;
  date: string;
  callsCount: number;
  meetingsCount: number;
  applicationsContacted: number;
  activitySummary: string | null;
  challenges: string | null;
  createdAt: string;
  user?: { id: string; fullName: string; role: string };
}

export const reportToday = () => api.get<DailyReport | null>('/reports/today').then((r) => r.data);
export const reportsMine = (params?: { from?: string; to?: string; take?: number }) =>
  api.get<DailyReport[]>('/reports/me', { params }).then((r) => r.data);
export const reportsAll = (params?: { userId?: string; from?: string; to?: string; take?: number }) =>
  api.get<DailyReport[]>('/reports/all', { params }).then((r) => r.data);
export const upsertReport = (data: {
  date?: string;
  callsCount?: number;
  meetingsCount?: number;
  applicationsContacted?: number;
  activitySummary?: string;
  challenges?: string;
}) => api.post<DailyReport>('/reports', data).then((r) => r.data);
