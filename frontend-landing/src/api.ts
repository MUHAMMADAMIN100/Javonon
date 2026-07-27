/**
 * База API. ВКЛЮЧАЕТ в себя префикс `/api` (backend вешает его глобально —
 * main.ts: app.setGlobalPrefix('api')), поэтому пути дописываются сразу от
 * ресурса: `${API_URL}/applications/public`, а НЕ `${API_URL}/api/...`.
 * См. .env.example и DEPLOY.md — на Vercel VITE_API_URL тоже задан с `/api`.
 *
 * Экспортируется, чтобы остальные модули лендинга не выводили константу заново:
 * дубли уже разъезжались (referral.ts слал POST на /api/api/referrals/click и
 * молча получал 404, из-за чего клики партнёров вечно были нулевыми).
 */
export const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';

export type Direction =
  | 'BACHELOR'
  | 'MASTER'
  | 'LANGUAGE'
  | 'LANGUAGE_COLLEGE'
  | 'LANGUAGE_BACHELOR'
  | 'COLLEGE';

export const DIRECTION_LABEL: Record<Direction, string> = {
  BACHELOR: 'Бакалавр',
  MASTER: 'Магистр',
  LANGUAGE: 'Курсҳои забон',
  LANGUAGE_COLLEGE: 'Забон + коллеҷ',
  LANGUAGE_BACHELOR: 'Забон + бакалавр',
  COLLEGE: 'Коллеҷ',
};

export type ApplicationSource =
  | 'LANDING_FORM'
  | 'SELF_REGISTRATION'
  | 'REFERRAL'
  | 'INSTAGRAM'
  | 'TELEGRAM'
  | 'GOOGLE_ADS'
  | 'TIKTOK'
  | 'WORD_OF_MOUTH'
  | 'EVENT'
  | 'OTHER';

export const SOURCE_LABEL: Record<ApplicationSource, string> = {
  LANDING_FORM: 'Сомона',
  SELF_REGISTRATION: 'Бақайдгирӣ',
  REFERRAL: 'Бо тавсия',
  INSTAGRAM: 'Instagram',
  TELEGRAM: 'Telegram',
  GOOGLE_ADS: 'Рекламаи Google',
  TIKTOK: 'TikTok',
  WORD_OF_MOUTH: 'Даҳон ба даҳон',
  EVENT: 'Чорабинӣ',
  OTHER: 'Дигар',
};

// По ТЗ §8: предпочтительный канал связи с клиентом.
export type ContactChannel = 'WHATSAPP' | 'PHONE' | 'INSTAGRAM' | 'TELEGRAM' | 'EMAIL';

export interface ApplicationPayload {
  fullName: string;
  phone: string;
  // Доп. контакт (отец/мать/другое лицо) — по ТЗ §8.
  secondaryPhone?: string;
  secondaryContactLabel?: string;
  // Предпочтительный канал связи с клиентом.
  preferredChannel?: ContactChannel;
  email?: string;
  direction: Direction;
  comment?: string;
  programId?: string;
  source?: ApplicationSource;
  /** Реферальный код партнёра — пробрасывается автоматически если есть в localStorage */
  ref?: string;
}

export async function submitApplication(payload: ApplicationPayload) {
  // Автоматически добавляем ref из localStorage если его не передали явно
  let body: any = { ...payload };
  if (!body.ref) {
    try {
      const stored = localStorage.getItem('javonon_ref');
      if (stored) {
        const r = JSON.parse(stored);
        if (r?.code) body.ref = r.code;
      }
    } catch {}
  }
  const res = await fetch(`${API_URL}/applications/public`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || 'Аризаро фиристодан муяссар нашуд');
  }
  return res.json();
}
