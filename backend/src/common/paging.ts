import { BadRequestException } from '@nestjs/common';

/**
 * Порции длинных списков: журнал «Финансов», «Посещаемость команды»,
 * «Сделки» (все и одобренные).
 *
 * Сервер отдаёт за один запрос не больше LIST_TAKE_MAX строк, а CRM
 * показывает список целиком: догружает его порциями ?skip=0, 1000, 2000…
 * (frontend-crm lib/loadAllPages.ts), пока порция не придёт неполной.
 * Раньше страницы просили 200 строк и молча показывали только их: журнал
 * писал «Всего операций: 200», хотя за период их было больше (02.11.2026).
 *
 * Чтобы порции стыковались без дублей и пропусков, порядок строк у такого
 * списка должен быть однозначным — последним ключом сортировки идёт id.
 */
export const LIST_TAKE_MAX = 1000;

/** Postgres OFFSET и Prisma skip — целое; больше этого порций не бывает. */
const SKIP_MAX = 2_147_483_647;

/**
 * ?skip — сколько строк пропустить с начала списка. Пусто — с начала.
 * Мусор и отрицательные — 400: параметр новый, старых клиентов с кривым
 * значением у него нет, а молча начать с нуля значило бы показать дубли.
 */
export function parseSkip(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (!/^\d+$/.test(v)) throw new BadRequestException('skip должен быть целым числом >= 0');
  const n = Number(v);
  if (n > SKIP_MAX) throw new BadRequestException('skip слишком большой');
  return n;
}

/**
 * Мягкий потолок ?take для «Посещаемости» и «Сделок»: так эти адреса вели
 * себя всегда — мусор даёт значение по умолчанию, лишнее срезается до
 * потолка, без 400. Отрицательное число раньше уходило в Prisma как есть
 * и разворачивало выборку с конца — теперь тоже значение по умолчанию.
 */
export function clampTake(v: number | undefined, def: number): number {
  if (v === undefined || !Number.isFinite(v) || v < 1) return def;
  return Math.min(Math.floor(v), LIST_TAKE_MAX);
}
