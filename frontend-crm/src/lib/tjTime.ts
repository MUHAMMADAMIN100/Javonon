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
  // Через tjMonthRange (ниже), а не через «первое число следующего месяца
  // минус день»: старая версия клеила месяц как `m + 1`, и в декабре
  // получала строку `2026-13-01` → Invalid Date → «NaN-NaN-NaN» в периоде
  // зарплаты (/salary, единственный потребитель). Теперь длину месяца даёт
  // календарь, а не склейка строк.
  return tjMonthRange(0, d).to;
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

/**
 * «YYYY-MM-DD» в TJ-календаре — значение для <input type="date"> / CrmDatePicker.
 *
 * Для МОМЕНТОВ времени (createdAt, дедлайны) резать ISO через `.slice(0, 10)`
 * нельзя: у момента после 19:00 UTC душанбинский день уже следующий.
 *
 * Дата рождения — отдельный случай: это календарный день, и бэк хранит его
 * ровно UTC-полуночью (`parseCalendarDateUtc` в backend/src/common/tj-time.ts),
 * поэтому для неё и срез, и этот хелпер дают один и тот же верный день.
 */
export function tjDateInput(input: string | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TJ_TZ }).format(d);
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

/* ========================================================================
 * Календарные периоды в Asia/Dushanbe — «этот месяц», «прошлый месяц»,
 * «квартал», «год» для переключателя периода на дашборде.
 *
 * Все хелперы отдают ГРАНИЦЫ строками YYYY-MM-DD, а не Date. Так и надо:
 * бэкенд парсит from/to через parseDate (backend/src/common/query-date.ts),
 * который поднимает date-only строку до 00:00:00.000 / 23:59:59.999 по
 * Душанбе. Если слать сюда ISO-моменты, посчитанные в браузере
 * (`new Date(y, m, 1).toISOString()`, как на /finance), граница уезжает
 * на таймзону КЛИЕНТА: у менеджера из Стамбула «этот месяц» начинался бы
 * 1-го числа в 02:00 по Душанбе, и заявки первой ночи месяца пропадали.
 * Единственная арифметика здесь — по числам года/месяца, уже полученным
 * в TJ через tjYMD(); моменты времени не складываются и не вычитаются.
 * ===================================================================== */

/** Диапазон календарных дней: обе границы включительно. */
export type TjDayRange = { from: string; to: string };

const pad2 = (n: number) => String(n).padStart(2, '0');

const ymdStr = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

/**
 * Сколько дней в месяце (m — 1..12). `Date.UTC(y, m, 0)` — «нулевой» день
 * следующего месяца, то есть последний день текущего; високосный год
 * считается движком. Таймзона тут ни при чём: год и месяц уже вычислены
 * в Душанбе, а вопрос «сколько дней в феврале 2028» ответа от TZ не имеет.
 */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Календарный месяц в TJ со сдвигом: 0 — текущий, -1 — прошлый.
 * Сдвиг считаем в «порядковом номере месяца» (y*12 + m), а не через
 * `setMonth(-1)`: последний переносит и день, из-за чего 31 марта минус
 * месяц даёт 3 марта.
 */
export function tjMonthRange(offset = 0, base: Date = new Date()): TjDayRange {
  const { y, m } = tjYMD(base);
  const index = y * 12 + (m - 1) + offset;
  const ry = Math.floor(index / 12);
  const rm = (index % 12) + 1;
  return { from: ymdStr(ry, rm, 1), to: ymdStr(ry, rm, daysInMonth(ry, rm)) };
}

/** Текущий календарный квартал в TJ (янв–мар / апр–июн / …). */
export function tjQuarterRange(base: Date = new Date()): TjDayRange {
  const { y, m } = tjYMD(base);
  const startMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    from: ymdStr(y, startMonth, 1),
    to: ymdStr(y, endMonth, daysInMonth(y, endMonth)),
  };
}

/**
 * Последние N календарных дней Asia/Dushanbe, обе границы включительно
 * (N=30 → сегодня и 29 предыдущих дней).
 *
 * Счёт идёт по ДНЯМ: `Date.UTC(y, m - 1, d - (n - 1))`, где y/m/d уже
 * получены в Душанбе через tjYMD, а переход через границу месяца/года
 * делает календарь. Прежний вариант на /kpi — `Date.now() - N*24*3600*1000`
 * с последующим toISOString() — отдавал МОМЕНТ посреди суток: «30 дней»
 * начинались во вчерашние 14:37 по Душанбе, и запись, созданная тем же
 * утром, в период не попадала. Ровно та же болезнь, от которой в этом
 * файле уже отказались в tjMonthRange/tjQuarterRange.
 */
export function tjLastDaysRange(days: number, base: Date = new Date()): TjDayRange {
  const { y, m, d } = tjYMD(base);
  const start = new Date(Date.UTC(y, m - 1, d - (days - 1)));
  return {
    from: ymdStr(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
    to: ymdStr(y, m, d),
  };
}

/** Текущий календарный год в TJ. */
export function tjYearRange(base: Date = new Date()): TjDayRange {
  const { y } = tjYMD(base);
  return { from: ymdStr(y, 1, 1), to: ymdStr(y, 12, 31) };
}
