import { api } from './client';

export interface Partner {
  id: string;
  email: string;
  fullName: string;
  phone?: string | null;
  referralCode: string;
  /**
   * Full referral link built by the backend (`<landing>/?ref=CODE#apply`).
   * The ONLY source of truth for the share link — never rebuild it on the
   * client: the base domain and the mandatory `#apply` anchor live in
   * backend/src/common/landing-url.ts + partners.service.buildReferralUrl.
   *
   * Optional because it is only present on payloads that the backend
   * decorates: `GET /admin/partners` (adminList). Nested `partner` objects
   * (create / detail responses) omit it — those responses carry a sibling
   * top-level `referralUrl` instead.
   */
  referralUrl?: string;
  /**
   * Flat commission rate (in TJS cents) paid per successful client payment.
   * This is the current commission source-of-truth (Variant A: fixed sum,
   * not %). Defaults to 50000 (= 500.00 TJS) on the backend.
   */
  commissionAmountCents: number;
  /**
   * @deprecated Legacy percent-based commission. Kept in the payload because
   * the backend still returns it (additive-only schema), but the frontend
   * MUST NOT read this to render the current rate — use
   * {@link Partner.commissionAmountCents} + {@link fmtCommissionRate} instead.
   */
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

/**
 * Row of `GET /admin/partners`. Structurally identical to {@link Partner};
 * it exists as a named type because this is the one payload where the backend
 * decorates every row with `referralUrl` (partners.service.adminList), so a
 * consumer typed as this may read the field instead of rebuilding the link.
 *
 * Still optional on the type: the CRM (Vercel) can ship ahead of the API
 * (Railway), and the pre-decoration backend omits it — callers fall back to
 * lib/landingUrl.buildReferralUrl for that window only.
 */
export type AdminPartnerListItem = Partner;

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
  /**
   * Flat commission rate in whole TJS (integer 0..100000). Server converts
   * to cents (× 100). Replaces the legacy `commissionPct` — if you still
   * send `commissionPct`, the server accepts it for backwards compatibility
   * but IGNORES it.
   */
  commissionAmountTjs?: number;
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
  /** Валюта baseAmountCents (валюта платежа клиента). Может отсутствовать у
   *  legacy-записей, созданных до введения поля — фронт откатывается на
   *  currency в этом случае. */
  baseCurrency?: string;
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
  api.get<AdminPartnerListItem[]>('/admin/partners').then((r) => r.data);

export const adminCreatePartner = (dto: AdminCreatePartnerDto) =>
  api.post<AdminCreatePartnerResponse>('/admin/partners', dto).then((r) => r.data);

export const adminDeletePartner = (id: string) =>
  api.delete<AdminDeletePartnerResponse>(`/admin/partners/${id}`).then((r) => r.data);

export const adminUpdatePartner = (id: string, patch: {
  /** Flat commission rate in whole TJS (integer 0..100000). */
  commissionAmountTjs?: number;
  /** @deprecated Legacy — server accepts and ignores it. */
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
  const v = ((cents ?? 0) / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v} ${currency}`;
}

/**
 * Format a flat commission rate stored in cents as a whole-TJS label,
 * e.g. `50000` → "500 TJS". The rate is always TJS and always an integer
 * number of whole тенге — no fractional cents, so we render 0 decimals.
 * Uses Russian locale grouping so 100000 cents → "1 000 TJS".
 */
export function fmtCommissionRate(cents: number): string {
  const whole = Math.round((cents ?? 0) / 100);
  const v = whole.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${v} TJS`;
}
