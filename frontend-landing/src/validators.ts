// Универсальные валидаторы для форм лендинга и кабинета студента.

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

// По запросу основателя — допускаем и кириллицу. Имя оставлено
// `latinOnly` для backward compatibility с уже импортирующим кодом.
export const latinOnly = (msg = 'Недопустимые символы'): Rule => (v) => {
  const s = String(v ?? '');
  if (!s) return undefined;
  return /^[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9 .,'\-/()&+#@№]*$/.test(s) ? undefined : msg;
};

export const passwordRule = (): Rule => (v) => {
  const s = String(v ?? '');
  if (!s) return 'Введите пароль';
  if (s.length < 6) return 'Минимум 6 символов';
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
