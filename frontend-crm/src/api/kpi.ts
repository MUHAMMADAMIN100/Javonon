import { api } from './client';
import type { Role } from './types';

/** Полоса сетки комиссии (common/bonus-bands.ts на бэке). */
export interface BonusBand {
  key: string;
  minAmount: number;
  /** null — без верхней границы. */
  maxAmount: number | null;
  percent: number;
}

/**
 * Бонус менеджера за текущий календарный месяц: набрано, ставка, сколько
 * осталось до следующей. Тот же расчёт, что в «Зарплате»
 * (common/manager-bonus-volume.ts → managerBonusProgress).
 */
export interface BonusProgressData {
  periodStart: string;
  periodEnd: string;
  volume: number;
  band: BonusBand;
  percent: number;
  /** Комиссия на сегодняшний объём (до вычета уже начисленного). */
  bonus: number;
  nextBand: BonusBand | null;
  toNext: number | null;
  bands: BonusBand[];
}

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
  /** Ручные приходы по менеджеру — в «Продажи» не входят. */
  otherIncome?: number;
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
  /** Бонус за текущий месяц (optional: старый бэк поля не отдаёт). */
  bonusProgress?: BonusProgressData;
}

export const leaderboard = (params?: { from?: string; to?: string }) =>
  api.get<KpiRow[]>('/kpi/leaderboard', { params }).then((r) => r.data);

export const myKpi = () => api.get<KpiRow | null>('/kpi/me').then((r) => r.data);

export const userKpi = (userId: string) =>
  api.get<KpiRow | null>(`/kpi/${userId}`).then((r) => r.data);

/* ===================== подробности по строке рейтинга ===================== */

export interface KpiDetailsStudent {
  id: string;
  fullName: string;
  direction: string;
  status: string;
  cabinet: number;
  createdAt: string;
  /** Сколько студент оплатил всего (действующие платежи за обучение, TJS). */
  paidTotal: number;
}

export interface KpiDetailsSale {
  id: string;
  /** В `currency`; у валютной сделки с суммой в сомони — уже в TJS. */
  amount: number;
  currency: string;
  /** Платёж по сделке: когда получены деньги и когда одобрен. */
  paidAt?: string;
  approvedAt?: string | null;
  /** Валютная сделка: исходные сумма и валюта. */
  originalAmount?: number;
  originalCurrency?: string;
  date: string;
  category: string;
  comment: string | null;
  payerName: string | null;
  studentId: string | null;
  student: { id: string; fullName: string } | null;
}

export interface KpiDetailsApplication {
  id: string;
  fullName: string;
  phone: string;
  status: string;
  country: string | null;
  createdAt: string;
  studentId: string | null;
  /** Статус из набора «успешно завершённых» — то, что рейтинг считает зачислением. */
  enrolled: boolean;
}

/**
 * Что стоит за числами строки рейтинга за ТОТ ЖЕ период. Сервер собирает
 * списки теми же условиями, что и сами числа (KpiService, блок «УСЛОВИЯ
 * ВЫБОРКИ»), поэтому totals обязаны совпадать со строкой. Списки обрезаются
 * до listLimit строк, итоги считаются по всем записям.
 */
export interface KpiDetails {
  user: { id: string; fullName: string; role: string };
  currency: string;
  listLimit: number;
  totals: {
    applicationsAssigned: number;
    applicationsEnrolled: number;
    studentsCount: number;
    salesAmount: number;
    salesCount: number;
    otherIncome?: number;
    otherIncomeCount?: number;
  };
  students: KpiDetailsStudent[];
  sales: KpiDetailsSale[];
  /** Приходы в прочих валютах — в сумму «Продажи» не входят. */
  otherCurrencySales: KpiDetailsSale[];
  applications: KpiDetailsApplication[];
  applicationsByStatus: { status: string; count: number }[];
}

/** Руководство — любого сотрудника, сотрудник — только себя (иначе 403). */
export const kpiDetails = (userId: string, params?: { from?: string; to?: string }) =>
  api.get<KpiDetails>(`/kpi/${userId}/details`, { params }).then((r) => r.data);
