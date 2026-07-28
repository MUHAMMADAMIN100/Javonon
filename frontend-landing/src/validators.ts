// Универсальные валидаторы для форм лендинга и кабинета студента.

export type Rule = (v: any) => string | undefined;

export const required = (msg = 'Майдони ҳатмӣ'): Rule =>
  (v) => (v === undefined || v === null || String(v).trim() === '' ? msg : undefined);

export const minLen = (n: number, msg?: string): Rule =>
  (v) => (String(v ?? '').trim().length < n ? (msg || `Ҳадди ақал ${n} аломат`) : undefined);

export const maxLen = (n: number, msg?: string): Rule =>
  (v) => (String(v ?? '').length > n ? (msg || `Ҳадди аксар ${n} аломат`) : undefined);

export const email = (msg = 'Почтаи электронӣ нодуруст'): Rule => (v) => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s) ? undefined : msg;
};

// По запросу основателя — допускаем и кириллицу. Имя оставлено
// `latinOnly` для backward compatibility с уже импортирующим кодом.
export const latinOnly = (msg = 'Аломатҳои иҷозатнашуда'): Rule => (v) => {
  const s = String(v ?? '');
  if (!s) return undefined;
  return /^[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9 .,'\-/()&+#@№]*$/.test(s) ? undefined : msg;
};

/* ============================================================
   Дата рождения (лендинг: «Санаи таваллуд»).
   Возраст считаем в Asia/Dushanbe — тем же часовым поясом, что и
   backend (common/tj-time). Иначе клиент из другого пояса на границе
   суток получил бы «14 лет» на фронте и 400 от бэка (или наоборот).
   ============================================================ */
export const MIN_AGE = 14;
export const MAX_AGE = 60;

const TJ_TZ = 'Asia/Dushanbe';

/** Сегодняшняя календарная дата в Душанбе, без времени. */
function todayTj(): { y: number; m: number; d: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TJ_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const y = get('year');
    const m = get('month');
    const d = get('day');
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) return { y, m, d };
  } catch {
    // Intl без tzdata (очень старые движки) — падаем на локальное время.
  }
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Границы для `<input type="date" min max>` — чтобы браузер сам не давал
 * выбрать заведомо невозможную дату, а не ловил её только на сабмите.
 *  max = сегодня − MIN_AGE лет      (в этот день исполняется ровно MIN_AGE)
 *  min = сегодня − (MAX_AGE+1) лет + 1 день (в этот день ещё ровно MAX_AGE)
 */
export function birthdayBounds(): { min: string; max: string } {
  const { y, m, d } = todayTj();
  const max = iso(y - MIN_AGE, m, d);
  // Date-арифметика через UTC, чтобы не зависеть от локального пояса браузера.
  const minDate = new Date(Date.UTC(y - MAX_AGE - 1, m - 1, d));
  minDate.setUTCDate(minDate.getUTCDate() + 1);
  const min = iso(minDate.getUTCFullYear(), minDate.getUTCMonth() + 1, minDate.getUTCDate());
  return { min, max };
}

/** Полных лет на сегодня (Душанбе) для даты `YYYY-MM-DD`. */
export function ageFromBirthday(value: string): number | undefined {
  const mres = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!mres) return undefined;
  const by = Number(mres[1]);
  const bm = Number(mres[2]);
  const bd = Number(mres[3]);
  // Проверяем, что дата реальная (31.02 и т.п. отсекаем).
  const probe = new Date(Date.UTC(by, bm - 1, bd));
  if (
    probe.getUTCFullYear() !== by ||
    probe.getUTCMonth() !== bm - 1 ||
    probe.getUTCDate() !== bd
  ) {
    return undefined;
  }
  const { y, m, d } = todayTj();
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

export const birthdayRule = (): Rule => (v) => {
  const s = String(v ?? '').trim();
  if (!s) return 'Санаи таваллудро нависед';
  const age = ageFromBirthday(s);
  if (age === undefined) return 'Сана нодуруст';
  if (age < MIN_AGE || age > MAX_AGE) return `Синну сол бояд аз ${MIN_AGE} то ${MAX_AGE} сол бошад`;
  return undefined;
};

export const passwordRule = (): Rule => (v) => {
  const s = String(v ?? '');
  if (!s) return 'Рамзро ворид кунед';
  if (s.length < 6) return 'Ҳадди ақал 6 аломат';
  return undefined;
};

export const compose = (...rules: Rule[]): Rule => (v) => {
  for (const r of rules) {
    const e = r(v);
    if (e) return e;
  }
  return undefined;
};

export const hasErrors = (errs: Record<string, string | undefined>) =>
  Object.values(errs).some(Boolean);
