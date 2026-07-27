import axios from 'axios';

// VITE_API_URL уже содержит /api на конце (см. .env.example и DEPLOY.md),
// поэтому дефолт тоже с /api — иначе baseURL выродится в /api/api и всё
// партнёрское API отдаст 404.
const API_BASE =
  (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';

/**
 * Origin бэкенда без хвостового `/api` и без хвостовых слэшей.
 *
 * Нормализуем обе формы записи VITE_API_URL (с суффиксом `/api` и голым
 * origin'ом) — так же, как это уже делает PublicProgramsSection через свой
 * API_ROOT. Ссылка, собранная руками, не должна зависеть от того, кто как
 * заполнил переменную на Vercel.
 */
const API_ROOT = String(API_BASE)
  .replace(/\/+$/, '')
  .replace(/\/api$/, '');

/**
 * Короткая партнёрская ссылка вида `<api-origin>/api/r/CODE`.
 *
 * ЭТО МАРШРУТ БЭКЕНДА, А НЕ СТРАНИЦА ЛЕНДИНГА.
 * Его обслуживает NestJS — backend/src/partners/referrals.controller.ts,
 * `@Get('r/:code')`: он записывает клик (registerClick) и отдаёт 302 либо в
 * Telegram-бот, либо на лендинг с `?ref=` и якорем `#apply`.
 *
 * Почему НЕ `window.location.origin`: origin здесь — домен лендинга
 * (javonon-landing.vercel.app). Роута `/r` в main.tsx нет, а vercel.json
 * переписывает `/(.*)` в `/index.html` — браузер грузил SPA, React Router не
 * находил совпадения, и партнёр вместе со всеми, кому он переслал ссылку,
 * получал белый экран. Клик, атрибуция и комиссия терялись молча — ровно тот
 * класс потерь, ради которого написан backend/src/common/landing-url.ts.
 *
 * Почему в пути есть `/api`: backend/src/main.ts зовёт
 * `app.setGlobalPrefix('api')` без exclude, поэтому контроллер реально слушает
 * `/api/r/:code`. Ссылка на `<api-origin>/r/CODE` вернула бы 404.
 */
export function partnerShortLink(code: string): string {
  return `${API_ROOT}/api/r/${encodeURIComponent(code)}`;
}

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
  baseURL: API_BASE,
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
    /** Валюта baseAmountCents (валюта платежа клиента). Опционально —
     *  legacy-записи без поля рендерятся через currency. */
    baseCurrency?: string;
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

export function fmtMoney(cents: number, currency = 'TJS') {
  const v = (cents / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v} ${currency}`;
}
