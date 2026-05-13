import axios from 'axios';

const API_BASE =
  (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001';

const TOKEN_KEY = 'javonon_partner_token';

export function getPartnerToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setPartnerToken(t: string) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch {}
}
export function clearPartnerToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

const client = axios.create({
  baseURL: `${API_BASE}/api`,
});
client.interceptors.request.use((cfg) => {
  const t = getPartnerToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

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
}

export interface PartnerDashboard {
  partner: Partner;
  stats: { clicks: number; leads: number; sales: number; paidSales: number };
  recentCommissions: Array<{
    id: string;
    amountCents: number;
    baseAmountCents: number;
    percent: number;
    currency: string;
    status: 'PENDING' | 'APPROVED' | 'PAID' | 'REVERSED';
    note?: string | null;
    createdAt: string;
    paidAt?: string | null;
  }>;
}

export const partnerRegister = (data: {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
}) => client.post<{ token: string; partner: Partner }>('/partner-auth/register', data)
  .then((r) => r.data);

export const partnerLogin = (email: string, password: string) =>
  client.post<{ token: string; partner: Partner }>('/partner-auth/login', { email, password })
    .then((r) => r.data);

export const partnerMe = () =>
  client.get<Partner>('/partner-auth/me').then((r) => r.data);

export const partnerDashboard = () =>
  client.get<PartnerDashboard>('/partner/dashboard').then((r) => r.data);

export const partnerCommissions = (limit = 100) =>
  client.get(`/partner/commissions?limit=${limit}`).then((r) => r.data);

export const partnerPayouts = () =>
  client.get('/partner/payouts').then((r) => r.data);

export const partnerRequestPayout = (body: {
  amountCents: number;
  method?: string;
  details?: string;
}) => client.post('/partner/payouts', body).then((r) => r.data);

export function fmtMoney(cents: number, currency = 'USD') {
  const v = (cents / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v} ${currency}`;
}
