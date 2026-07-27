/**
 * Единый источник правды для базового URL публичного лендинга.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 * --------------------------
 * Два независимых места собирали ссылку на лендинг своей inline-цепочкой
 * env-переменных, и дефолты со временем разъехались:
 *
 *   partners.service.ts     → 'https://javonon.com'                  ← МЁРТВЫЙ
 *   referrals.controller.ts → 'https://javonon-landing.vercel.app'   ← рабочий
 *
 * Домен javonon.com не резолвится в DNS. А модалка «поделиться ссылкой» в
 * кабинете партнёра и ответ adminCreate читают именно partners.service —
 * то есть фаундеры выдавали партнёрам ссылку, которая не открывается.
 * Клик не доходил до лендинга → не было ни атрибуции, ни комиссии, и
 * партнёр винил в этом нас.
 *
 * Поэтому: НИКАКИХ новых `process.env.LANDING_URL || '...'` в коде.
 * Любому месту, которому нужен URL лендинга, звать resolveLandingBaseUrl().
 * Меняется дефолт — меняется здесь, в одной строке, для всех разом.
 */

/** Домен, на который реально задеплоен лендинг. Меняем только тут. */
export const FALLBACK_LANDING_URL = 'https://javonon-landing.vercel.app';

/** Порядок приоритета env-переменных. Первая непустая выигрывает. */
const ENV_KEYS = ['LANDING_URL', 'PUBLIC_LANDING_URL'] as const;

/**
 * Читалка env. Совместима с сигнатурой ConfigService.get, поэтому вызывающий
 * код с внедрённым ConfigService передаёт `k => this.config.get(k)`.
 */
export type EnvGetter = (key: string) => string | undefined;

/**
 * Базовый URL лендинга — без хвостового слэша, гарантированно непустой.
 *
 * @param get — опциональная читалка env (например `k => this.config.get(k)`).
 *              Если не передана — читаем process.env напрямую, чтобы helper
 *              работал и в местах без DI (контроллеры с полями-инициализаторами).
 *
 * Пустая строка или строка из одних пробелов трактуется как «переменная не
 * задана»: в Railway/Vercel легко оставить `LANDING_URL=` пустым, и без этой
 * проверки мы бы вернули '' и склеили ссылку вида '/?ref=ABC123'.
 */
export function resolveLandingBaseUrl(get?: EnvGetter): string {
  const read: EnvGetter = get ?? ((key) => process.env[key]);

  for (const key of ENV_KEYS) {
    const raw = read(key);
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
