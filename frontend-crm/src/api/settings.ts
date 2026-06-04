import { api } from './client';

export type Weekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  MON: 'Понедельник',
  TUE: 'Вторник',
  WED: 'Среда',
  THU: 'Четверг',
  FRI: 'Пятница',
  SAT: 'Суббота',
  SUN: 'Воскресенье',
};

export interface ScheduleDay {
  id: string | null;
  userId: string | null;
  weekday: Weekday;
  isWorkday: boolean;
  startMinute: number;
  endMinute: number;
  lunchStartMinute: number | null;
  lunchEndMinute: number | null;
}

export interface PenaltyRule {
  id: string;
  minLateMinutes: number;
  maxLateMinutes: number | null;
  amount: number;
  currency: string;
  isActive: boolean;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Schedule ---
export const getSchedule = (userId?: string | null) =>
  api
    .get<ScheduleDay[]>('/settings/schedule', { params: userId ? { userId } : {} })
    .then((r) => r.data);

export const upsertSchedule = (userId: string | null, days: Partial<ScheduleDay>[]) =>
  api
    .put<ScheduleDay[]>('/settings/schedule', { userId, days })
    .then((r) => r.data);

// --- Penalty Rules ---
export const listPenaltyRules = () =>
  api.get<PenaltyRule[]>('/settings/penalty-rules').then((r) => r.data);

export const createPenaltyRule = (data: Partial<PenaltyRule>) =>
  api.post<PenaltyRule>('/settings/penalty-rules', data).then((r) => r.data);

export const updatePenaltyRule = (id: string, patch: Partial<PenaltyRule>) =>
  api.patch<PenaltyRule>(`/settings/penalty-rules/${id}`, patch).then((r) => r.data);

export const deletePenaltyRule = (id: string) =>
  api.delete(`/settings/penalty-rules/${id}`).then((r) => r.data);

// --- Work Location ---
export const getActiveLocation = () =>
  api.get<WorkLocation | null>('/settings/work-location').then((r) => r.data);

export const listLocations = () =>
  api.get<WorkLocation[]>('/settings/work-locations').then((r) => r.data);

export const createLocation = (data: Partial<WorkLocation>) =>
  api.post<WorkLocation>('/settings/work-locations', data).then((r) => r.data);

export const updateLocation = (id: string, patch: Partial<WorkLocation>) =>
  api.patch<WorkLocation>(`/settings/work-locations/${id}`, patch).then((r) => r.data);

export const deleteLocation = (id: string) =>
  api.delete(`/settings/work-locations/${id}`).then((r) => r.data);

// --- Helpers ---
export function minutesToHHMM(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map((x) => parseInt(x, 10) || 0);
  return Math.max(0, Math.min(1439, h * 60 + m));
}
