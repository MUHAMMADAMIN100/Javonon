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

/**
 * Страна назначения, которую спрашивает лендинг вместо старого «Ҳадаф».
 * Значения — 1:1 ключи backend-энума `Country` (prisma/schema.prisma),
 * поэтому строки НЕЛЬЗЯ переименовывать: они уходят в БД как есть.
 * Порядок в COUNTRY_ORDER задан основателем и определяет порядок в <select>.
 */
export type Country =
  | 'USA'
  | 'KOREA'
  | 'CHINA'
  | 'LATVIA'
  | 'MALAYSIA'
  | 'ITALY'
  | 'GERMANY';

export const COUNTRY_ORDER: Country[] = [
  'USA',
  'KOREA',
  'CHINA',
  'LATVIA',
  'MALAYSIA',
  'ITALY',
  'GERMANY',
];

export const COUNTRY_LABEL: Record<Country, string> = {
  USA: 'Амрико',
  KOREA: 'Корея',
  CHINA: 'Хитой',
  LATVIA: 'Латвия',
  MALAYSIA: 'Малайзия',
  ITALY: 'Италия',
  GERMANY: 'Олмон',
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
  /** Номер WhatsApp. Лендинг шлёт его всегда: при галочке «тот же номер» — копию phone. */
  whatsappPhone?: string;
  /** Дата рождения, ISO `YYYY-MM-DD`. На бэке конвертируется в Date и переносится в Student.birthday. */
  birthday?: string;
  /** Страна назначения — то, что лендинг спрашивает вместо направления. */
  country?: Country;
  // Доп. контакт (отец/мать/другое лицо) — по ТЗ §8.
  // Форма лендинга их БОЛЬШЕ НЕ СПРАШИВАЕТ, но backend по-прежнему принимает
  // их в CreateApplicationDto, и менеджер дозаполняет эти поля в карточке
  // заявки (PATCH /applications/:id). Из типа не убираем.
  secondaryPhone?: string;
  secondaryContactLabel?: string;
  // Предпочтительный канал связи с клиентом.
  preferredChannel?: ContactChannel;
  email?: string;
  // `direction` здесь НЕТ: backend его на создании больше не принимает
  // (CreateApplicationDto), заявке всегда проставляется плейсхолдер
  // Direction.BACHELOR с directionConfirmed=false. Настоящее направление
  // выставляет менеджер в CRM. Не добавляй поле обратно — ValidationPipe
  // ({ whitelist: true }) молча срежет его на бэке.
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
