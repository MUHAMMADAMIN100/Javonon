/**
 * Единая утилита работы со временем по Asia/Dushanbe (UTC+5, фиксированный
 * offset, без DST).
 *
 * Зачем: Railway-сервер живёт в UTC. Если использовать `new Date()` и
 * `.toISOString().slice(0,10)`, день «съезжает» на 5 часов относительно
 * ожиданий FOUNDER'а и сотрудников. Все границы суток / периодов /
 * cron'ов в этой системе должны считаться в Душанбе.
 *
 * Принципы:
 *  - В БД храним полноценный UTC `DateTime` — это правильно.
 *  - В коде, где нужно «сегодня» / «начало дня» / «день недели» / минуты
 *    с полуночи, используем эти хелперы.
 *  - Cron'ы навешивают `{ timeZone: 'Asia/Dushanbe' }` (см. cron.service.ts).
 */

export const TJ_TZ = 'Asia/Dushanbe';

/** YYYY-MM-DD в Asia/Dushanbe. */
export function tjLocalDay(d: Date = new Date()): string {
  // en-CA даёт YYYY-MM-DD — кратчайший путь без склейки руками.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TJ_TZ }).format(d);
}

/** Часы и минуты в Asia/Dushanbe для конкретного момента. */
export function tjLocalHHMM(d: Date = new Date()): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TJ_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value || '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value || '0');
  return { h, m };
}

/** Минут от полуночи Asia/Dushanbe для конкретного момента. */
export function tjMinutesFromMidnight(d: Date = new Date()): number {
  const { h, m } = tjLocalHHMM(d);
  return h * 60 + m;
}

/** День недели (0=Sun … 6=Sat) в Asia/Dushanbe. */
export function tjWeekday(d: Date = new Date()): number {
  const dayName = new Intl.DateTimeFormat('en-US', {
    timeZone: TJ_TZ,
    weekday: 'short',
  }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayName);
}

/** Y/M/D в Asia/Dushanbe (числа). */
export function tjYMD(d: Date = new Date()): { y: number; m: number; d: number } {
  const day = tjLocalDay(d); // YYYY-MM-DD
  const [y, mo, da] = day.split('-').map(Number);
  return { y, m: mo, d: da };
}

/** Полночь Asia/Dushanbe для указанного момента, возвращённая как Date
 *  (значение в UTC; toISOString даст 19:00 предыдущего дня UTC = 00:00 в
 *  Душанбе). */
export function tjStartOfDay(d: Date = new Date()): Date {
  const day = tjLocalDay(d);
  // Asia/Dushanbe = UTC+5 круглый год → 00:00 в Душанбе = 19:00 UTC предыдущего дня.
  // Готовый ISO с явным offset проще всего: `2026-06-16T00:00:00+05:00`.
  return new Date(`${day}T00:00:00+05:00`);
}

/** Полночь Asia/Dushanbe следующего дня (эксклюзивный верх). */
export function tjStartOfNextDay(d: Date = new Date()): Date {
  const start = tjStartOfDay(d);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/** Конец суток Asia/Dushanbe (23:59:59.999). Удобно для inclusive-фильтра. */
export function tjEndOfDay(d: Date = new Date()): Date {
  return new Date(tjStartOfNextDay(d).getTime() - 1);
}

/** Парсинг YYYY-MM-DD пришедшего из UI как полночи Asia/Dushanbe.
 *  Раньше `new Date('2026-06-16')` давало UTC-полночь, в Душанбе уже
 *  05:00 → день показывался криво при фильтре «с какой по какую». */
export function tjParseLocalDate(input: string): Date {
  // Допускаем уже полную ISO-строку с временем (если UI кладёт T...).
  if (/T\d/.test(input)) return new Date(input);
  return new Date(`${input}T00:00:00+05:00`);
}

/** Парсинг конца периода: 23:59:59.999 ТJT для указанного YYYY-MM-DD. */
export function tjParseLocalDateEnd(input: string): Date {
  if (/T\d/.test(input)) return new Date(input);
  return new Date(`${input}T23:59:59.999+05:00`);
}

/** Начало месяца Asia/Dushanbe (для границ зарплатного периода). */
export function tjStartOfMonth(d: Date = new Date()): Date {
  const { y, m } = tjYMD(d);
  const mm = String(m).padStart(2, '0');
  return new Date(`${y}-${mm}-01T00:00:00+05:00`);
}

/** Эксклюзивный верх — первое число следующего месяца Asia/Dushanbe. */
export function tjStartOfNextMonth(d: Date = new Date()): Date {
  const { y, m } = tjYMD(d);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const mm = String(nm).padStart(2, '0');
  return new Date(`${ny}-${mm}-01T00:00:00+05:00`);
}

/** Конец месяца Asia/Dushanbe (последнее мгновение). */
export function tjEndOfMonth(d: Date = new Date()): Date {
  return new Date(tjStartOfNextMonth(d).getTime() - 1);
}
