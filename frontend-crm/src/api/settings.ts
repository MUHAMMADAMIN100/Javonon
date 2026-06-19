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

// Удалить весь график для userId (или null = компанийский дефолт).
// После удаления личного графика сотрудник вернётся к компанийскому
// дефолту. После удаления компанийского — clockIn упадёт на hardcoded
// 09:00-18:00 fallback. По ТЗ §3 «полный CRUD».
export const deleteSchedule = (userId?: string | null) =>
  api
    .delete<{ deleted: number }>('/settings/schedule', { params: userId ? { userId } : {} })
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

// --- Bonus Tiers (тарифная сетка комиссии) ---

export interface BonusTier {
  id: string;
  minAmount: number;
  maxAmount: number | null;
  percent: number;
  currency: string;
  order: number;
  isActive: boolean;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listBonusTiers = () =>
  api.get<BonusTier[]>('/settings/bonus-tiers').then((r) => r.data);

export const createBonusTier = (data: Partial<BonusTier>) =>
  api.post<BonusTier>('/settings/bonus-tiers', data).then((r) => r.data);

export const updateBonusTier = (id: string, patch: Partial<BonusTier>) =>
  api.patch<BonusTier>(`/settings/bonus-tiers/${id}`, patch).then((r) => r.data);

export const deleteBonusTier = (id: string) =>
  api.delete(`/settings/bonus-tiers/${id}`).then((r) => r.data);

// --- Salary settings (table of all employees) ---

export interface UserSalarySettings {
  id: string;
  fullName: string;
  email: string;
  role: string;
  baseSalary: number | null;
  hourlyRate: number | null;
  bonusPercent: number | null;
  overtimeMultiplier: number | null;
  customRole?: { id: string; name: string } | null;
}

export const listSalarySettings = () =>
  api.get<UserSalarySettings[]>('/users/salary/list').then((r) => r.data);

export const updateUserSalary = (
  userId: string,
  patch: { baseSalary?: number; hourlyRate?: number; bonusPercent?: number; overtimeMultiplier?: number },
) => api.patch<UserSalarySettings>(`/users/${userId}/salary`, patch).then((r) => r.data);

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
