import { api } from './client';

export interface Partner {
  id: string;
  email: string;
  fullName: string;
  phone?: string | null;
  referralCode: string;
  commissionPct: number;
  balanceCents: number;
  totalEarnedCents: number;
  totalPaidCents: number;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  telegramHandle?: string | null;
  telegramId?: string | null;
  createdAt: string;
  updatedAt?: string;
  _count?: { clicks: number; attributions: number; commissions: number };
}

export interface PartnerStats {
  clicksCount: number;
  attributionsCount: number;
  commissionsCount: number;
  payoutsCount: number;
}

export interface PartnerAttribution {
  id: string;
  createdAt: string;
  source?: string | null;
  application?: {
    id: string;
    fullName: string;
    phone: string;
    email?: string | null;
    direction: string;
    status: string;
    createdAt: string;
  } | null;
  student?: {
    id: string;
    fullName: string;
    phone?: string | null;
    email?: string | null;
  } | null;
  telegramUserId?: string | null;
  emailHint?: string | null;
}

export interface PartnerClick {
  id: string;
  createdAt: string;
  source?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  referer?: string | null;
}

export interface PartnerDetailResponse {
  partner: Partner;
  referralUrl: string;
  stats: PartnerStats;
  recentClicks: PartnerClick[];
  recentAttributions: PartnerAttribution[];
}

export interface PartnerAttributionsResponse {
  items: PartnerAttribution[];
  total: number;
  hasMore: boolean;
}

export interface AdminCreatePartnerDto {
  fullName: string;
  email: string;
  phone?: string;
  password?: string;
  commissionPct?: number;
}

export interface AdminCreatePartnerResponse {
  partner: Partner;
  referralUrl: string;
  /** Present only when the backend auto-generated the password. Shown ONCE in UI. */
  plainPassword?: string;
}

export interface AdminDeletePartnerResponse {
  softDeleted?: boolean;
  hardDeleted?: boolean;
  partner?: Partner;
  id?: string;
}

export interface AdminCommission {
  id: string;
  partnerId: string;
  partner?: { id: string; fullName: string; email: string };
  paymentId?: string | null;
  transactionId?: string | null;
  amountCents: number;
  baseAmountCents: number;
  percent: number;
  currency: string;
  status: 'PENDING' | 'APPROVED' | 'PAID' | 'REVERSED';
  paidAt?: string | null;
  createdAt: string;
  note?: string | null;
}

export interface AdminPayout {
  id: string;
  partnerId: string;
  partner?: { id: string; fullName: string; email: string };
  amountCents: number;
  currency: string;
  method?: string | null;
  details?: string | null;
  status: 'REQUESTED' | 'PAID' | 'REJECTED';
  requestedAt: string;
  paidAt?: string | null;
  rejectedAt?: string | null;
}

export const adminListPartners = () =>
  api.get<Partner[]>('/admin/partners').then((r) => r.data);

export const adminCreatePartner = (dto: AdminCreatePartnerDto) =>
  api.post<AdminCreatePartnerResponse>('/admin/partners', dto).then((r) => r.data);

export const adminDeletePartner = (id: string) =>
  api.delete<AdminDeletePartnerResponse>(`/admin/partners/${id}`).then((r) => r.data);

export const adminUpdatePartner = (id: string, patch: {
  commissionPct?: number;
  status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  fullName?: string;
}) =>
  api.patch<Partner>(`/admin/partners/${id}`, patch).then((r) => r.data);

export const adminListCommissions = (params?: {
  partnerId?: string;
  status?: 'PENDING' | 'APPROVED' | 'PAID' | 'REVERSED';
}) =>
  api.get<AdminCommission[]>('/admin/partners/commissions/list', { params })
    .then((r) => r.data);

export const adminMarkCommissionPaid = (id: string) =>
  api.post<AdminCommission>(`/admin/partners/commissions/${id}/pay`).then((r) => r.data);

export const adminListPayouts = (params?: { partnerId?: string }) =>
  api.get<AdminPayout[]>('/admin/partners/payouts/list', { params })
    .then((r) => r.data);

export const adminGetPartner = (id: string) =>
  api.get<PartnerDetailResponse>(`/admin/partners/${id}`).then((r) => r.data);

export const adminGetPartnerAttributions = (
  id: string,
  params?: { take?: number; skip?: number },
) =>
  api
    .get<PartnerAttributionsResponse>(`/admin/partners/${id}/attributions`, { params })
    .then((r) => r.data);

export const adminPayoutPay = (id: string) =>
  api.post<AdminPayout>(`/admin/partners/payouts/${id}/pay`).then((r) => r.data);

export const adminPayoutReject = (id: string) =>
  api.post<AdminPayout>(`/admin/partners/payouts/${id}/reject`).then((r) => r.data);

export function fmtMoneyCents(cents: number, currency = 'TJS') {
  const v = (cents / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v} ${currency}`;
}
