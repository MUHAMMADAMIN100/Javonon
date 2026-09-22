/**
 * Откуда браузеру можно ходить в API и открывать сокет — ОДНО правило для
 * HTTP (main.ts) и WebSocket (realtime.gateway.ts).
 *
 *  - точные адреса из CORS_ORIGINS (через запятую);
 *  - основные домены проекта (на случай, если их забыли в env);
 *  - поддомены javonon.com — домен наш;
 *  - localhost / 127.0.0.1 — только вне production.
 *
 * Раньше пропускался ЛЮБОЙ *.vercel.app: завести проект на Vercel может
 * кто угодно, и его страница проходила CORS как своя. Превью-сборки Vercel
 * теперь добавляются в CORS_ORIGINS явно.
 */
const ALWAYS_ALLOWED_HOSTS = [
  'javonon.com',
  'www.javonon.com',
  'javonon-crm.vercel.app',
  'javonon-landing.vercel.app',
  'javonon.vercel.app',
  // Боевой домен лендинга; CRM открывается на нём же через /admin (rewrite Vercel).
  'javonongroup.tj',
  'www.javonongroup.tj',
];

const VERCEL_TEAM_RE = /^javonon-[a-z0-9-]+-muhammadamin100s-projects\.vercel\.app$/;

export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.host;
  const env = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.some((o) => o === origin || o === host || o === `${url.protocol}//${host}`)) return true;
  if (ALWAYS_ALLOWED_HOSTS.includes(host)) return true;
  if (url.hostname.endsWith('.javonon.com')) return true;
  // Адреса сборок Vercel нашей команды (javonon-…-muhammadamin100s-projects.vercel.app):
  // суффикс команды принадлежит только нашему аккаунту — чужой проект такой
  // адрес получить не может. Без этого CRM, открытая по адресу конкретной
  // сборки (кнопка в панели Vercel), не могла сделать ни одного запроса.
  if (VERCEL_TEAM_RE.test(url.hostname)) return true;
  if (process.env.NODE_ENV !== 'production' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
  return false;
}
