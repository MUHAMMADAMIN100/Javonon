/**
 * Единый источник правды для базового URL публичного лендинга — фронтовый
 * двойник backend/src/common/landing-url.ts.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 * --------------------------
 * В CRM было ДВА независимых inline-выражения под одну и ту же переменную
 * VITE_LANDING_URL, и дефолты разъехались:
 *
 *   Partners.tsx (buildReferralUrl) → 'https://javonon.com'                ← МЁРТВЫЙ
 *   Sidebar.tsx  (база знаний)      → 'https://javonon-landing.vercel.app' ← рабочий
 *
 * Домен javonon.com не резолвится в DNS, а VITE_LANDING_URL в проде не задан —
 * то есть кнопка «скопировать ссылку» в списке партнёров и QR-код отдавали
 * партнёру ссылку, которая не открывается. Ровно та же болезнь, ради которой
 * на бэке появился resolveLandingBaseUrl, просто переехавшая на фронт.
 *
 * Поэтому: НИКАКИХ новых `import.meta.env.VITE_LANDING_URL || '...'` в коде.
 * Меняется домен — меняется здесь, в одной строке, для всей CRM разом.
 */

/** Домен, на который реально задеплоен лендинг. Меняем только тут. */
export const FALLBACK_LANDING_URL = 'https://javonon-landing.vercel.app';

/** Порядок приоритета env-переменных. Первая непустая выигрывает. */
const ENV_KEYS = ['VITE_LANDING_URL', 'VITE_PUBLIC_LANDING_URL'] as const;

/**
 * Базовый URL лендинга — без хвостового слэша, гарантированно непустой.
 *
 * Пустая строка или строка из одних пробелов трактуется как «переменная не
 * задана»: в Vercel легко оставить `VITE_LANDING_URL=` пустым, и без этой
 * проверки мы бы вернули '' и склеили ссылку вида '/?ref=ABC123'.
 */
export function resolveLandingBaseUrl(): string {
  const env = (import.meta as any).env || {};

  for (const key of ENV_KEYS) {
    const raw = env[key];
    if (typeof raw !== 'string') continue;

    const trimmed = raw.trim();
    if (!trimmed) continue; // пустая/пробельная == не задана

    // Снимаем хвостовые слэши: вызывающий код сам добавляет '/?ref=...',
    // иначе получим '.../\/?ref=' с двойным слэшем.
    const normalized = trimmed.replace(/\/+$/, '');
    if (!normalized) continue; // значение было ровно '/' — это мусор, не URL

    return normalized;
  }

  return FALLBACK_LANDING_URL;
}

/**
 * Реферальная ссылка партнёра — АВАРИЙНЫЙ путь.
 *
 * Канонический источник ссылки — backend: adminList/adminCreate/adminGetOne
 * возвращают готовый `referralUrl`, собранный partners.service.buildReferralUrl.
 * Эта функция нужна ровно на один случай: CRM (Vercel) выкатили раньше бэка
 * (Railway), и в ответе списка поля ещё нет — лучше отдать рабочую ссылку по
 * коду, чем скопировать в буфер и зашить в QR строку "undefined".
 *
 * Формат обязан совпадать с бэковым посимвольно, включая '#apply': лендинг
 * длинный, форма заявки внизу, без якоря приглашённый падает на первый экран.
 * Фрагмент строго последним — всё после '#' в query уже не попадает.
 */
export function buildReferralUrl(code: string): string {
  return `${resolveLandingBaseUrl()}/?ref=${code}#apply`;
}
