import { COUNTRIES } from '../components/PhoneInput';

/**
 * Проверка телефона лида — ОДНА для «Нового лида» и для правки в карточке
 * (QA-3, BUG-09: при создании была маска и понятные ошибки, при правке —
 * свободный текст, и «abcdefghijklmnop» давало «Номер слишком короткий»).
 * Номер приходит из PhoneInput в виде «+<код><цифры>».
 */
const CODES = [...COUNTRIES].sort((a, b) => b.code.length - a.code.length);

/** Ключ текста ошибки (i18n) или undefined, если номер в порядке. */
export function leadPhoneError(value: string): string | undefined {
  const v = (value || '').trim();
  const matched = CODES.find((c) => v.startsWith(c.code));
  if (!matched) return 'leads.err.phoneCode';
  const rest = v.slice(matched.code.length);
  if (/[^\d\s\-()]/.test(rest)) return 'leads.err.phoneDigits';
  const digits = rest.replace(/\D/g, '');
  if (matched.code === '+992' && digits.length !== 9) return 'validate.phoneTj';
  if (digits.length < matched.minDigits) return 'leads.err.phoneShort';
  if (digits.length > matched.maxDigits) return 'leads.err.phoneLong';
  return undefined;
}

/** Есть ли в номере цифры кроме кода страны (код подставляет само поле). */
export function phoneHasOwnDigits(value: string): boolean {
  const v = (value || '').trim();
  const code = CODES.find((c) => v.startsWith(c.code));
  return (code ? v.slice(code.code.length) : v).replace(/\D/g, '').length > 0;
}
