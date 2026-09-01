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

// --- Комиссионная сетка менеджера (полосы) ---
//
// Сетка задана в коде бэкенда (common/bonus-bands.ts) и отдаётся только на
// чтение: ставки — договорённость учредителя, меняются вместе с релизом.
// Ручек создания / правки / удаления здесь больше нет намеренно — бэк на
// POST/PATCH/DELETE отвечает 400. Строки BonusTier в БД сохранены, но не
// читаются.

export interface BonusTier {
  /** Совпадает с key полосы (band1…band5). */
  id: string;
  key: string;
  /** Нижняя граница объёма, включительно. */
  minAmount: number;
  /** Верхняя граница объёма, включительно. null — без верхней границы. */
  maxAmount: number | null;
  /** Ставка, применяемая ко ВСЕМУ объёму (не посрезово). */
  percent: number;
  currency: string;
  order: number;
  isActive: boolean;
  comment: string | null;
  /** Всегда true — сетка правится только релизом. */
  readOnly: boolean;
}

export const listBonusTiers = () =>
  api.get<BonusTier[]>('/settings/bonus-tiers').then((r) => r.data);

// --- Salary settings (table of all employees) ---

export interface UserSalarySettings {
  id: string;
  fullName: string;
  email: string;
  role: string;
  baseSalary: number | null;
  hourlyRate: number | null;
  bonusPercent: number | null;
  customRole?: { id: string; name: string } | null;
  // Поля вычисляются бэком на основе графика сотрудника:
  //   monthHours    — рабочих часов в текущем месяце (за вычетом обеда)
  //   workdays      — рабочих дней в текущем месяце
  //   computedHourly — baseSalary / monthHours, основная почасовая
  monthHours?: number;
  workdays?: number;
  computedHourly?: number;
}

export const listSalarySettings = () =>
  api.get<UserSalarySettings[]>('/users/salary/list').then((r) => r.data);

export const updateUserSalary = (
  userId: string,
  patch: { baseSalary?: number; hourlyRate?: number; bonusPercent?: number },
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
