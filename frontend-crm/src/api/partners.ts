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
  createdAt: string;
  _count?: { clicks: number; attributions: number; commissions: number };
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

export const adminListPayouts = () =>
  api.get<AdminPayout[]>('/admin/partners/payouts/list').then((r) => r.data);

export const adminPayoutPay = (id: string) =>
  api.post<AdminPayout>(`/admin/partners/payouts/${id}/pay`).then((r) => r.data);

export const adminPayoutReject = (id: string) =>
  api.post<AdminPayout>(`/admin/partners/payouts/${id}/reject`).then((r) => r.data);

export function fmtMoneyCents(cents: number, currency = 'USD') {
  const v = (cents / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v} ${currency}`;
}
