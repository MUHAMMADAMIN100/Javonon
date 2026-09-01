import { api } from './client';

export type UserDocumentType =
  | 'PASSPORT'
  | 'PHOTO'
  | 'CONTRACT'
  | 'DIPLOMA'
  | 'OFFER'
  | 'OTHER';

export const USER_DOCUMENT_LABEL: Record<UserDocumentType, string> = {
  PASSPORT: 'Паспорт',
  PHOTO: 'Фотография',
  CONTRACT: 'Контракт',
  DIPLOMA: 'Диплом',
  OFFER: 'Оферта',
  OTHER: 'Прочее',
};

export interface UserDocument {
  id: string;
  type: UserDocumentType;
  url: string;
  originalName?: string | null;
  size?: number | null;
  comment?: string | null;
  createdAt: string;
}

export interface FullProfile {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: 'FOUNDER' | 'ADMIN' | 'ACCOUNTANT' | 'SALES_MANAGER' | 'CLIENT_MANAGER' | 'EMPLOYEE';
    roles?: string[];
    phone?: string | null;
    passportNo?: string | null;
    hiredAt?: string | null;
    baseSalary?: number | null;
    hourlyRate?: number | null;
    bonusPercent?: number | null;
    kpiTargetPct?: number | null;
    kpiAutoStepPct?: number | null;
    kpiMaxPct?: number | null;
    createdAt: string;
  };
  documents: UserDocument[];
  salary: {
    records: Array<{
      id: string;
      periodStart: string;
      periodEnd: string;
      workedMinutes: number;
      baseAmount: number;
      salesAmount: number;
      bonusAmount: number;
      kpiBonus: number;
      penalties: number;
      netAmount: number;
      currency: string;
      status: 'DRAFT' | 'PAID';
      paidAt?: string | null;
      createdAt: string;
    }>;
    baseSalary: number;
    hourlyRate: number;
    /**
     * ПЕРСОНАЛЬНЫЙ override ставки (User.bonusPercent). 0 = не задан,
     * ставка берётся из сетки. Для показа «бонус % с продаж»
     * бери bonusPercentEffective — иначе все, кто сидит на сетке,
     * увидят «0%» при 6% на экране Зарплаты.
     */
    bonusPercent: number;
    /** Ставка, которая РЕАЛЬНО применяется к объёму этого месяца. */
    bonusPercentEffective?: number;
    /** 'BAND' — ставка сетки; 'PERSONAL' — личный процент. */
    bonusSource?: 'BAND' | 'PERSONAL';
    /** Полоса, в которую попал объём месяца (всегда есть). */
    bonusBand?: {
      key: string;
      minAmount: number;
      maxAmount: number | null;
      percent: number;
    };
    /** Объём за календарный месяц (APPROVED-платежи, TJS). */
    bonusVolume?: number;
    bonusPeriodStart?: string;
    bonusPeriodEnd?: string;
  };
  penalties: {
    list: Array<{
      id: string;
      reason: string;
      amount: number;
      currency: string;
      date: string;
      comment?: string | null;
      applied: boolean;
    }>;
    pendingTotal: number;
  };
  sales: {
    monthAmount: number;
    monthCount: number;
    yearAmount: number;
    yearCount: number;
  };
  attendance: {
    workedMinutes: number;
    lateMinutes: number;
    daysWorked: number;
  };
  kpi: {
    targetPct: number;
    totalLeadsMonth: number;
    ownClientsMonth: number;
    enrolledMonth: number;
    requiredClosed: number;
    achievedPct: number;
    onTrack: boolean;
  };
  dailyReports: Array<{
    id: string;
    date: string;
    callsCount?: number | null;
    meetingsCount?: number | null;
    salesCount?: number | null;
    salesAmount?: number | null;
    comment?: string | null;
  }>;
}

export const getMyFullProfile = () =>
  api.get<FullProfile>('/me/full').then((r) => r.data);

// /me/profile/:id — доступ-чек внутри (ADMIN / self / DataAccessGrant).
// Работает и для админа, и для сотрудника которому выдали доступ.
export const getUserFullProfile = (id: string) =>
  api.get<FullProfile>(`/me/profile/${id}`).then((r) => r.data);

export const updateUserHR = (id: string, patch: Partial<{
  phone: string;
  passportNo: string;
  hiredAt: string;
  baseSalary: number;
  hourlyRate: number;
  bonusPercent: number;
  kpiTargetPct: number;
  kpiAutoStepPct: number;
  kpiMaxPct: number;
  role: string;
}>) => api.patch(`/users/${id}`, patch).then((r) => r.data);

export const uploadUserDocument = (id: string, file: File, type: string, comment?: string) => {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('type', type);
  if (comment) fd.append('comment', comment);
  return api.post<UserDocument>(`/users/${id}/documents`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data);
};

export const deleteUserDocument = (id: string, docId: string) =>
  api.delete(`/users/${id}/documents/${docId}`).then((r) => r.data);

// Self-загрузка: сотрудник сам грузит свой документ через /me/documents.
export const uploadMyDocument = (file: File, type: UserDocumentType, comment?: string) => {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('type', type);
  if (comment) fd.append('comment', comment);
  return api.post<UserDocument>('/me/documents', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data);
};

export const deleteMyDocument = (docId: string) =>
  api.delete(`/me/documents/${docId}`).then((r) => r.data);

export const updateMyDocument = (docId: string, patch: { type?: string; comment?: string }) =>
  api.patch<UserDocument>(`/me/documents/${docId}`, patch).then((r) => r.data);

export const updateUserDocument = (
  userId: string,
  docId: string,
  patch: { type?: string; comment?: string },
) => api.patch<UserDocument>(`/users/${userId}/documents/${docId}`, patch).then((r) => r.data);

/** FOUNDER-only: задать список ролей сотрудника. Первая в массиве станет primary. */
export const setUserRoles = (userId: string, roles: string[]) =>
  api.put(`/users/${userId}/roles`, { roles }).then((r) => r.data);

// Точечный доступ к данным сотрудника
export interface AccessGrant {
  id: string;
  grantedTo: { id: string; fullName: string; email: string; role: string };
  createdAt: string;
}
export const listUserAccess = (id: string) =>
  api.get<AccessGrant[]>(`/users/${id}/access`).then((r) => r.data);
export const grantUserAccess = (id: string, grantedToId: string) =>
  api.post(`/users/${id}/access`, { grantedToId }).then((r) => r.data);
export const revokeUserAccess = (id: string, granteeId: string) =>
  api.delete(`/users/${id}/access/${granteeId}`).then((r) => r.data);

export function fmtMinutes(m: number) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}м`;
  return min ? `${h}ч ${min}м` : `${h}ч`;
}

export function fmtMoney(amount: number, currency = 'TJS') {
  return `${amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${currency}`;
}
