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
  overtimeMinutes: number;
  date: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemberStatus extends TimeEntry {
  user: { id: string; fullName: string; role: string; email: string };
}

export const getToday = () => api.get<TimeEntry | null>('/time/today').then((r) => r.data);
export const getHistory = (params?: { from?: string; to?: string; take?: number }) =>
  api.get<TimeEntry[]>('/time/history', { params }).then((r) => r.data);
export const clockIn = () => api.post<TimeEntry>('/time/clock-in').then((r) => r.data);
export const lunchOut = () => api.post<TimeEntry>('/time/lunch-out').then((r) => r.data);
export const lunchIn = () => api.post<TimeEntry>('/time/lunch-in').then((r) => r.data);
export const clockOut = () => api.post<TimeEntry>('/time/clock-out').then((r) => r.data);
export const teamStatus = () => api.get<TeamMemberStatus[]>('/time/team').then((r) => r.data);
