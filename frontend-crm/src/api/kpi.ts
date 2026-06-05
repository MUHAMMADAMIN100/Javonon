import { api } from './client';
import type { Role } from './types';

export interface KpiRow {
  id: string;
  fullName: string;
  email: string;
  // По ТЗ §2: 5 ролей + legacy EMPLOYEE. Раньше тут был узкий
  // 3-ролевой union — новые роли проваливались мимо type-safety.
  role: Role;
  bonusPercent: number | null;
  applicationsAssigned: number;
  applicationsEnrolled: number;
  conversionRate: number;
  studentsCount: number;
  salesAmount: number;
  tasksOpen: number;
  tasksDone: number;
}

export const leaderboard = (params?: { from?: string; to?: string }) =>
  api.get<KpiRow[]>('/kpi/leaderboard', { params }).then((r) => r.data);

export const myKpi = () => api.get<KpiRow | null>('/kpi/me').then((r) => r.data);

export const userKpi = (userId: string) =>
  api.get<KpiRow | null>(`/kpi/${userId}`).then((r) => r.data);
