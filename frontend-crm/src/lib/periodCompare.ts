/**
 * С чем сравнивать период — общий расчёт для главной и «Финансы → Аналитика»
 * (редизайн 2026).
 *
 * «Этот месяц / квартал / год» идут не до конца — сравниваем с ТЕМИ ЖЕ днями
 * прошлого месяца / квартала / года (9 ноября → 1–9 октября), иначе 9 дней
 * сравнивались бы с полным месяцем и всё «падало» бы на 70%. «Прошлый месяц»
 * — с позапрошлым целиком. «Свой период» — с таким же отрезком перед ним.
 * «Всё время» — без сравнения (null).
 */
export function prevRangeOf(r: { from?: string; to?: string }, period: string, today: string): { from: string; to: string } | null {
  if (!r.from || !r.to) return null;
  const end = r.to < today ? r.to : today;
  if (end < r.from) return null;
  const shift = (ymd: string, months: number, clampToMonthEnd = false) => {
    const y = +ymd.slice(0, 4), m = +ymd.slice(5, 7) - 1, d = +ymd.slice(8, 10);
    const target = new Date(Date.UTC(y, m + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    const day = clampToMonthEnd ? last : Math.min(d, last);
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)).toISOString().slice(0, 10);
  };
  // QA-2: «Свой период» 1–30 ноября давал ▲19%, «Этот месяц» с теми же
  // датами — ▲507%. Целый календарный месяц сравниваем одинаково.
  const lastDay = (ymd: string) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7), 0)).getUTCDate();
  const wholeMonth = period === 'custom' && r.from.slice(8, 10) === '01' && r.from.slice(0, 7) === r.to.slice(0, 7) && +r.to.slice(8, 10) === lastDay(r.to);
  const back = period === 'month' || period === 'prev' || wholeMonth ? 1 : period === 'quarter' ? 3 : period === 'year' ? 12 : 0;
  if (back > 0) {
    return { from: shift(r.from, -back), to: period === 'prev' ? shift(r.to, -back, true) : shift(end, -back) };
  }
  const day = (x: string) => Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10));
  const DAY = 86_400_000;
  const len = Math.round((day(end) - day(r.from)) / DAY) + 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(day(r.from) - len * DAY), to: iso(day(r.from) - DAY) };
}

export type Delta = { text: string; tone: 'good' | 'bad' | 'flat' };

/** «▲ 12%» и хорошо ли это: рост расходов — плохо, рост дохода — хорошо. */
export function compareValues(cur: number | null | undefined, before: number | null | undefined, upIsGood = true): Delta | undefined {
  if (cur == null || before == null) return undefined;
  if (before === 0) {
    if (cur === 0) return { text: '0%', tone: 'flat' };
    return { text: `${cur > 0 ? '+' : '−'}${Math.abs(Math.round(cur)).toLocaleString('ru-RU')}`, tone: (cur > 0) === upIsGood ? 'good' : 'bad' };
  }
  const pct = Math.round(((cur - before) / Math.abs(before)) * 100);
  if (pct === 0) return { text: '0%', tone: 'flat' };
  const up = pct > 0;
  return { text: `${up ? '▲' : '▼'} ${Math.abs(pct)}%`, tone: up === upIsGood ? 'good' : 'bad' };
}
