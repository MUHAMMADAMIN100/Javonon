/** Ключ перевода по русскому правилу окончаний: 1 операция, 2 операции, 5 операций. */
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/**
 * «4 месяцев» → «4 месяца» (QA-3, BUG-24). Срок программы — свободный текст,
 * который вводит сотрудник; число с единицей времени приводим к правильному
 * окончанию при показе. Всё остальное («1 семестр», «2 года + язык») — как есть.
 */
const UNITS: Array<[RegExp, [string, string, string]]> = [
  [/^(?:мес\.?|месяц[а-я]*)$/i, ['месяц', 'месяца', 'месяцев']],
  [/^(?:год[а-я]*|лет)$/i, ['год', 'года', 'лет']],
  [/^недел[а-я]*$/i, ['неделя', 'недели', 'недель']],
  [/^(?:дн[а-я]*|день)$/i, ['день', 'дня', 'дней']],
];

export function fmtDurationRu(text: string | null | undefined): string {
  const raw = (text || '').trim();
  const m = /^(\d{1,3})\s*([A-Za-zА-Яа-яЁё.]+)$/.exec(raw);
  if (!m) return raw;
  const n = Number(m[1]);
  const unit = UNITS.find(([re]) => re.test(m[2]));
  if (!unit) return raw;
  const [one, few, many] = unit[1];
  return `${n} ${ruPlural(n, one, few, many)}`;
}
