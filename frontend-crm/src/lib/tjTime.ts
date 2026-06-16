/**
 * Единый источник «текущего времени» для CRM — Asia/Dushanbe (UTC+5).
 *
 * Зачем: бэк живёт в UTC, ISO-строки от сервера приходят в UTC. Если
 * форматировать через `toLocaleString('ru-RU')` без timeZone — берётся
 * timezone браузера. Если пользователь открывает CRM из Москвы или
 * Стамбула, видит «не своё» время. Все exports тут пишут / читают
 * как Asia/Dushanbe.
 */

export const TJ_TZ = 'Asia/Dushanbe';

/** Сегодняшняя YYYY-MM-DD в Asia/Dushanbe. */
export function tjToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TJ_TZ }).format(new Date());
}

/** Y/M/D в Asia/Dushanbe для произвольной даты. */
export function tjYMD(d: Date = new Date()): { y: number; m: number; d: number } {
  const [y, mo, da] = new Intl.DateTimeFormat('en-CA', { timeZone: TJ_TZ }).format(d).split('-').map(Number);
  return { y, m: mo, d: da };
}

/** Первое число текущего месяца в Asia/Dushanbe (формат YYYY-MM-DD). */
export function tjStartOfMonthStr(d: Date = new Date()): string {
  const { y, m } = tjYMD(d);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** Последнее число текущего месяца в Asia/Dushanbe (формат YYYY-MM-DD). */
export function tjEndOfMonthStr(d: Date = new Date()): string {
  const { y, m } = tjYMD(d);
  // Создаём дату 0-го числа следующего месяца — JS даст последнее число
  // текущего. Делаем это с TJT-полночью.
  const probe = new Date(`${y}-${String(m + 1).padStart(2, '0')}-01T00:00:00+05:00`);
  // Минус 1 день
  probe.setUTCDate(probe.getUTCDate() - 1);
  const last = tjYMD(probe);
  return `${last.y}-${String(last.m).padStart(2, '0')}-${String(last.d).padStart(2, '0')}`;
}

/** «01 июн, 14:32» в TJ-времени. */
export function tjFormatDateTime(input: string | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TJ_TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** «01.06.2026» в TJ-времени. */
export function tjFormatDate(input: string | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TJ_TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(d);
}

/** «14:32» в TJ-времени. */
export function tjFormatTime(input: string | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TJ_TZ,
    hour: '2-digit', minute: '2-digit',
  }).format(d);
}

/** Полная строка: «01.06.2026, 14:32». */
export function tjFormatFull(input: string | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TJ_TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(d);
}
