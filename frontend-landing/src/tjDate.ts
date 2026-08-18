/**
 * ДАТЫ КАБИНЕТА — ВСЕГДА В ДУШАНБИНСКИХ СУТКАХ.
 *
 * Бэкенд отдаёт datetime в UTC (`startsAt`, `dueDate`), а сутки в этом
 * продукте определяются по Asia/Dushanbe — ровно так их считает
 * backend/src/common/tj-time.ts, и по ним же cron переводит этапы в OVERDUE.
 * Если рисовать браузерным локальным временем, студент с телефоном на
 * московском часовом поясе увидел бы занятие «вчера в 23:00» вместо
 * «сегодня в 04:00», а этап с dueDate 18-го — просроченным на сутки раньше,
 * чем его таким посчитает сервер.
 *
 * Поэтому все поля дат вынимаем через Intl с явным timeZone, а не через
 * getDate()/getHours(). Сырой арифметики над Date (`+ 86400000`) здесь тоже
 * нет: разница в днях считается по календарным полям (см. tjDayDiff).
 *
 * Месяцы и дни недели — таджикские: локали 'tg' в браузерах нет, а ru-RU в
 * кабинете, где весь текст на таджикском, выглядит чужеродно.
 */

export const TJ_TZ = 'Asia/Dushanbe';

const TJ_MONTHS = [
  'январ', 'феврал', 'март', 'апрел', 'май', 'июн',
  'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр',
];

/** Индекс — как у Date.getUTCDay(): 0 = воскресенье. */
const TJ_WEEKDAYS = [
  'якшанбе', 'душанбе', 'сешанбе', 'чоршанбе', 'панҷшанбе', 'ҷумъа', 'шанбе',
];

export type TjFields = {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
};

/**
 * Форматтер строим лениво и с запасным вариантом: если движок вдруг собран
 * без базы IANA-зон, `timeZone: 'Asia/Dushanbe'` бросит RangeError прямо в
 * конструкторе — и весь кабинет упал бы на пустом экране из-за подписи под
 * занятием. Тогда молча откатываемся на локальное время браузера.
 */
let partsFmt: Intl.DateTimeFormat | null = null;
function getPartsFmt(): Intl.DateTimeFormat {
  if (partsFmt) return partsFmt;
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // hourCycle, а не hour12:false: часть движков на hour12:false отдаёт
    // полночь как «24:00».
    hourCycle: 'h23',
  };
  try {
    partsFmt = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: TJ_TZ });
  } catch {
    partsFmt = new Intl.DateTimeFormat('en-GB', opts);
  }
  return partsFmt;
}

/** Календарные поля момента в душанбинских сутках. */
export function tjFields(input: string | Date): TjFields {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return { year: 0, month: 1, day: 1, hour: 0, minute: 0 };
  const parts = getPartsFmt().formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/** Стабильный ключ душанбинских суток — для группировки занятий по дням. */
export function tjDayKey(input: string | Date): string {
  const f = tjFields(input);
  return `${f.year}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`;
}

/**
 * Разница в КАЛЕНДАРНЫХ днях (a − b) по душанбинскому календарю.
 * Считаем по полям через Date.UTC, а не вычитанием timestamp'ов: так «завтра»
 * остаётся завтрашним днём, а не «через 24 часа».
 */
export function tjDayDiff(a: string | Date, b: string | Date): number {
  const fa = tjFields(a);
  const fb = tjFields(b);
  const da = Date.UTC(fa.year, fa.month - 1, fa.day);
  const db = Date.UTC(fb.year, fb.month - 1, fb.day);
  return Math.round((da - db) / 86400000);
}

/** «14:30» */
export function tjTime(input: string | Date): string {
  const f = tjFields(input);
  return `${String(f.hour).padStart(2, '0')}:${String(f.minute).padStart(2, '0')}`;
}

/** «18 август» */
export function tjDateShort(input: string | Date): string {
  const f = tjFields(input);
  return `${f.day} ${TJ_MONTHS[f.month - 1] ?? ''}`;
}

/** «18 августи 2026» — изафет, как в таджикской записи полной даты. */
export function tjDateFull(input: string | Date): string {
  const f = tjFields(input);
  const month = TJ_MONTHS[f.month - 1] ?? '';
  return `${f.day} ${month}${month ? 'и' : ''} ${f.year}`;
}

/** «сешанбе» */
export function tjWeekday(input: string | Date): string {
  const f = tjFields(input);
  const idx = new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay();
  return TJ_WEEKDAYS[idx] ?? '';
}

/**
 * Заголовок дня для списка занятий: «Имрӯз» / «Пагоҳ», иначе
 * «сешанбе, 18 август». Точку отсчёта передаём явно, чтобы у всех строк
 * одного рендера было одно «сегодня».
 */
export function tjDayLabel(input: string | Date, now: Date): string {
  const diff = tjDayDiff(input, now);
  if (diff === 0) return 'Имрӯз';
  if (diff === 1) return 'Пагоҳ';
  return `${tjWeekday(input)}, ${tjDateShort(input)}`;
}

/**
 * Подпись к сроку платежа: «то 18 августи 2026», а для прошедших —
 * с пометкой, сколько дней назад. Тон нейтральный: студента за просрочку
 * здесь не отчитывают, это делает менеджер.
 */
export function tjDueLabel(input: string | Date, now: Date): string {
  const diff = tjDayDiff(input, now);
  if (diff === 0) return 'Мӯҳлат — имрӯз';
  if (diff === 1) return 'Мӯҳлат — пагоҳ';
  return `Мӯҳлат — ${tjDateFull(input)}`;
}
