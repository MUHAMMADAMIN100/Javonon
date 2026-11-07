import { tr } from './i18n';

/**
 * Ответ сервера с ошибкой — в понятный текст (QA №25, UX «ошибки по-русски»).
 *
 * Проверки сервера (class-validator) отдают массив английских фраз вида
 * «email must be an email», а наши — русские, но с английским именем поля
 * («phone должен содержать только цифры»). Раньше CRM выводила массив как
 * есть, и React склеивал его без пробела: «…цифрыemail must be an email».
 * Здесь: массив → строки через «; », повторы убираются, стандартные фразы
 * переводятся, имя поля заменяется подписью. Подключено один раз в
 * api/client.ts — все 150+ мест, что показывают response.data.message,
 * получают уже готовый текст.
 */

const FIELD_KEYS: Record<string, string> = {
  phone: 'srv.field.phone',
  whatsappPhone: 'srv.field.whatsapp',
  secondaryPhone: 'srv.field.secondaryPhone',
  email: 'srv.field.email',
  fullName: 'srv.field.fullName',
  name: 'srv.field.name',
  title: 'srv.field.title',
  comment: 'srv.field.comment',
  description: 'srv.field.description',
  birthday: 'srv.field.birthday',
  amount: 'srv.field.amount',
  password: 'srv.field.password',
  currency: 'srv.field.currency',
  date: 'srv.field.date',
  status: 'srv.field.status',
  country: 'srv.field.country',
  direction: 'srv.field.direction',
};

function field(name: string): string {
  const key = FIELD_KEYS[name];
  if (!key) return name;
  const v = tr(key);
  return v === key ? name : v;
}

const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^(\w+) must be an email$/, () => tr('srv.email')],
  [/^(\w+) should not be empty$/, (m) => tr('srv.required').replace('{f}', field(m[1]))],
  [/^(\w+) must be longer than or equal to (\d+) characters$/, (m) => tr('srv.minLen').replace('{f}', field(m[1])).replace('{n}', m[2])],
  [/^(\w+) must be shorter than or equal to (\d+) characters$/, (m) => tr('srv.maxLen').replace('{f}', field(m[1])).replace('{n}', m[2])],
  [/^(\w+) must not be less than (-?[\d.]+)$/, (m) => tr('srv.min').replace('{f}', field(m[1])).replace('{n}', m[2])],
  [/^(\w+) must not be greater than (-?[\d.]+)$/, (m) => tr('srv.max').replace('{f}', field(m[1])).replace('{n}', m[2])],
  [/^(\w+) must be a valid ISO 8601 date string$/, (m) => tr('srv.date').replace('{f}', field(m[1]))],
  [/^(\w+) must be (?:a number|an integer number|a positive number).*$/, (m) => tr('srv.number').replace('{f}', field(m[1]))],
  [/^(\w+) must be one of the following values.*$/, (m) => tr('srv.oneOf').replace('{f}', field(m[1]))],
  [/^(\w+) must be (?:a string|a boolean|an array|a UUID|a valid enum value).*$/, (m) => tr('srv.invalid').replace('{f}', field(m[1]))],
  // Наши русские тексты с английским именем поля в начале.
  [/^([a-zA-Z]+) (должен|должна|должно|содержит|не может|обязател\S*)(.*)$/, (m) => `${field(m[1])} ${m[2]}${m[3]}`],
];

function translateOne(raw: string): string {
  const s = raw.trim();
  for (const [re, fn] of RULES) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return s;
}

/** Текст ошибки сервера, готовый к показу. undefined — сообщения нет. */
export function serverMessage(message: unknown): string | undefined {
  if (message === undefined || message === null) return undefined;
  const list = (Array.isArray(message) ? message : [message])
    .filter((m) => typeof m === 'string' && m.trim())
    .map((m) => translateOne(m as string));
  if (!list.length) return undefined;
  return Array.from(new Set(list)).join('; ');
}
