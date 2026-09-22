import type { Locale } from 'date-fns';
import { ru } from 'date-fns/locale';
import { tr, type Lang } from './i18n';

/**
 * Локаль date-fns для календаря и дат вида «22 сентября 2026».
 *
 * Таджикской локали в date-fns нет. Берём русскую (неделя с понедельника,
 * тот же порядок «день месяц год») и подменяем названия месяцев и дней
 * недели на таджикские из словаря (month.N, weekday.*).
 */
const WEEK_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const tg: Locale = {
  ...ru,
  code: 'tg',
  localize: {
    ...ru.localize,
    month: (n: number, opts?: { width?: string }) => {
      const name = tr(`month.${n + 1}`);
      return opts?.width === 'abbreviated' || opts?.width === 'narrow' ? name.slice(0, 3) : name;
    },
    day: (n: number, opts?: { width?: string }) =>
      opts?.width === 'wide' ? tr(`weekday.${WEEK_KEYS[n]}`) : tr(`weekday.short.${WEEK_KEYS[n].toLowerCase()}`),
  },
};

export function dateLocale(lang: Lang): Locale {
  return lang === 'tg' ? tg : ru;
}
