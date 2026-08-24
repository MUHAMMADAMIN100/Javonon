// Универсальные валидаторы для форм CRM. Каждая функция возвращает
// строку-ошибку или undefined, если значение валидно.

import { tjYMD } from '../lib/tjTime';

export type Rule = (v: any) => string | undefined;

export const required = (msg = 'Обязательное поле'): Rule =>
  (v) => (v === undefined || v === null || String(v).trim() === '' ? msg : undefined);

export const minLen = (n: number, msg?: string): Rule =>
  (v) => (String(v ?? '').trim().length < n ? (msg || `Минимум ${n} символов`) : undefined);

export const maxLen = (n: number, msg?: string): Rule =>
  (v) => (String(v ?? '').length > n ? (msg || `Максимум ${n} символов`) : undefined);

export const email = (msg = 'Некорректный email'): Rule => (v) => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s) ? undefined : msg;
};

export const numberRule = (opts: { min?: number; max?: number; integer?: boolean } = {}): Rule => (v) => {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return 'Должно быть числом';
  if (opts.integer && !Number.isInteger(n)) return 'Должно быть целым числом';
  if (opts.min !== undefined && n < opts.min) return `Не меньше ${opts.min}`;
  if (opts.max !== undefined && n > opts.max) return `Не больше ${opts.max}`;
  return undefined;
};

export const positive = (msg = 'Должно быть больше нуля'): Rule => (v) => {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return msg;
  return undefined;
};

// Телефон по E.164: от 7 до 15 цифр всего (с учётом кода страны).
export const phoneRule = (msg = 'Некорректный номер телефона'): Rule => (v) => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return 'Номер слишком короткий';
  if (digits.length > 15) return msg;
  return undefined;
};

export const passwordRule = (msg = 'Минимум 8 символов, буквы и цифры'): Rule => (v) => {
  const s = String(v ?? '');
  if (!s) return undefined;
  if (s.length < 8) return 'Минимум 8 символов';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return msg;
  return undefined;
};

export const noBadChars = (msg = 'Недопустимые символы'): Rule => (v) => {
  const s = String(v ?? '');
  if (/[<>{}[\]\\]/.test(s)) return msg;
  return undefined;
};

export const compose = (...rules: Rule[]): Rule => (v) => {
  for (const r of rules) {
    const e = r(v);
    if (e) return e;
  }
  return undefined;
};

/** Валидирует объект по карте { field: Rule }. Возвращает map с ошибками. */
export function validateAll<T extends Record<string, any>>(
  values: T,
  rules: Partial<Record<keyof T, Rule>>,
): Partial<Record<keyof T, string>> {
  const errors: Partial<Record<keyof T, string>> = {};
  (Object.keys(rules) as (keyof T)[]).forEach((k) => {
    const rule = rules[k];
    if (!rule) return;
    const err = rule(values[k]);
    if (err) errors[k] = err;
  });
  return errors;
}

export const hasErrors = (errs: Record<string, string | undefined>) =>
  Object.values(errs).some(Boolean);

/* ============================================================
   Дата рождения.

   Возраст считаем в Asia/Dushanbe — тем же поясом, что и backend
   (common/tj-time.ts, ApplicationsService.parseBirthday) и что и форма
   лендинга (frontend-landing/src/validators.ts). Иначе сотрудник на
   границе суток увидел бы «14 лет» на фронте и получил 400 от бэка.

   Здесь только ЧИСТЫЕ хелперы без текстов: сообщения об ошибке форма
   берёт из i18n (RU/TJ), а не из дефолтных строк валидатора.
   ============================================================ */

/** Границы возраста заявителя — совпадают с backend parseBirthday. */
export const MIN_AGE = 14;
export const MAX_AGE = 60;

const isoDate = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Границы для date-picker'а, чтобы заведомо невозможную дату нельзя было
 * выбрать вовсе, а не ловить её только на сабмите.
 *   max = сегодня − MIN_AGE лет           (в этот день исполняется ровно 14)
 *   min = сегодня − (MAX_AGE+1) лет + 1 день (в этот день ещё ровно 60)
 */
export function birthdayBounds(): { min: string; max: string } {
  const { y, m, d } = tjYMD();
  const max = isoDate(y - MIN_AGE, m, d);
  // Арифметика через UTC, чтобы не зависеть от пояса браузера.
  const minDate = new Date(Date.UTC(y - MAX_AGE - 1, m - 1, d));
  minDate.setUTCDate(minDate.getUTCDate() + 1);
  return { min: isoDate(minDate.getUTCFullYear(), minDate.getUTCMonth() + 1, minDate.getUTCDate()), max };
}

/**
 * Полных лет на сегодня (Душанбе) для даты `YYYY-MM-DD`.
 * `undefined` — строка не дата или дата несуществующая (31.02).
 */
export function ageFromBirthday(value: string): number | undefined {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!parsed) return undefined;
  const by = Number(parsed[1]);
  const bm = Number(parsed[2]);
  const bd = Number(parsed[3]);
  const probe = new Date(Date.UTC(by, bm - 1, bd));
  if (
    probe.getUTCFullYear() !== by ||
    probe.getUTCMonth() !== bm - 1 ||
    probe.getUTCDate() !== bd
  ) {
    return undefined;
  }
  const { y, m, d } = tjYMD();
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}
