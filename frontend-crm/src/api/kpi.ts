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
  /**
   * Валюта, в которой посчитан `salesAmount`. Бэк считает KPI только в
   * отчётной валюте (TJS) — см. KpiService.leaderboard, блок «ВАЛЮТА».
   * Optional: старый бэк поля не отдаёт, тогда fmtMoney берёт дефолт.
   */
  currency?: string;
  /**
   * Приходы в ПРОЧИХ валютах за тот же период: код валюты → сумма в
   * исходной валюте. В `salesAmount` и в сортировку рейтинга НЕ входят
   * (FX-конвертации на бэке нет), но и не теряются молча — показываем
   * подписью, как `nonTjsSales` в SalaryPreview и `nonTjsTotals` в финансах.
   * Пустой объект / undefined — период был чисто в сомони.
   */
  nonTjsSales?: Record<string, number>;
  tasksOpen: number;
  tasksDone: number;
}

export const leaderboard = (params?: { from?: string; to?: string }) =>
  api.get<KpiRow[]>('/kpi/leaderboard', { params }).then((r) => r.data);

export const myKpi = () => api.get<KpiRow | null>('/kpi/me').then((r) => r.data);

export const userKpi = (userId: string) =>
  api.get<KpiRow | null>(`/kpi/${userId}`).then((r) => r.data);
