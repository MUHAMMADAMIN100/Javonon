export type FieldKind = 'text' | 'date' | 'email' | 'tel' | 'number' | 'textarea' | 'radio' | 'year' | 'select';

export interface FieldDef {
  key: string;
  label: string;
  labelEn?: string;
  kind?: FieldKind;
  placeholder?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  optional?: boolean;
  /** разрешена латиница / цифры / базовые знаки пунктуации (адреса, "School #5") */
  latin?: boolean;
  /** ТОЛЬКО латинские буквы + пробел/дефис/апостроф (имена, ФИО, должности, страны) */
  lettersOnly?: boolean;
  /** ТОЛЬКО латинские буквы + цифры (паспорт, специальность, степень, ID) */
  latinDigits?: boolean;
  min?: number;
  max?: number;
  noEmpty?: boolean;
  digitsOnly?: boolean;
  allowPresent?: boolean;
}

export const PRESENT_VALUE = 'PRESENT';
export const PRESENT_LABEL = 'По настоящее время';

export interface SectionDef {
  key: string;
  icon: string;
  title: string;
  titleEn?: string;
  fields?: FieldDef[];
  table?: {
    columns: FieldDef[];
    defaultRows?: number;
    rowLabels?: string[];
    fixedRows?: boolean;
    minRows?: number;
    skipLabels?: string[];
  };
}

export const FORM_SECTIONS: SectionDef[] = [
  {
    key: 'personal',
    icon: 'person',
    title: 'Личные данные',
    titleEn: 'Personal Information',
    fields: [
      { key: 'surname', label: 'Фамилия (как в паспорте)', labelEn: 'Surname', lettersOnly: true },
      { key: 'givenName', label: 'Имя (как в паспорте)', labelEn: 'Given name', lettersOnly: true },
      { key: 'birthDate', label: 'Дата рождения', labelEn: 'Date of Birth', kind: 'date' },
      { key: 'birthPlace', label: 'Место рождения', labelEn: 'Place of Birth', lettersOnly: true },
      { key: 'nationality', label: 'Национальность', labelEn: 'Nationality', lettersOnly: true },
      { key: 'currentCountry', label: 'Текущая страна / город', labelEn: 'Present Country/City', lettersOnly: true },
      { key: 'passportNumber', label: 'Номер паспорта', labelEn: 'Passport No.', latinDigits: true },
      { key: 'passportExpiry', label: 'Срок действия паспорта', labelEn: 'Passport Expiration', kind: 'date' },
      {
        key: 'gender',
        label: 'Пол',
        labelEn: 'Gender',
        kind: 'radio',
        options: [
          { value: 'MALE', label: 'Мужской' },
          { value: 'FEMALE', label: 'Женский' },
        ],
      },
      { key: 'religion', label: 'Религия', labelEn: 'Religion', lettersOnly: true, optional: true },
      { key: 'nativeLanguage', label: 'Родной язык', labelEn: 'Native Language', lettersOnly: true },
      { key: 'officialLanguage', label: 'Официальный язык', labelEn: 'Official Language', lettersOnly: true },
      {
        key: 'maritalStatus',
        label: 'Семейное положение',
        labelEn: 'Marital Status',
        kind: 'radio',
        options: [
          { value: 'SINGLE', label: 'Холост / не замужем' },
          { value: 'MARRIED', label: 'В браке' },
          { value: 'DIVORCED', label: 'Разведен(а)' },
          { value: 'OTHER', label: 'Другое' },
        ],
      },
      {
        key: 'educationLevel',
        label: 'Высший уровень образования',
        labelEn: 'Highest Education Level',
        kind: 'radio',
        options: [
          { value: 'HIGH_SCHOOL', label: 'Средняя школа' },
          { value: 'BACHELOR', label: 'Бакалавр' },
          { value: 'MASTER', label: 'Магистр' },
          { value: 'PHD', label: 'PhD' },
        ],
      },
      {
        key: 'inChina',
        label: 'Сейчас находитесь в Китае?',
        labelEn: 'Are you currently in China?',
        kind: 'radio',
        options: [
          { value: 'YES', label: 'Да' },
          { value: 'NO', label: 'Нет' },
        ],
      },
    ],
  },
  {
    key: 'address',
    icon: 'home',
    title: 'Адрес постоянного проживания',
    titleEn: 'Permanent Address',
    fields: [
      { key: 'home', label: 'Домашний адрес', labelEn: 'Home Address', kind: 'textarea', placeholder: 'Страна, город, улица, дом', latin: true },
      { key: 'tel', label: 'Телефон', labelEn: 'Tel', kind: 'tel' },
      { key: 'email', label: 'Email', labelEn: 'Email', kind: 'email' },
      { key: 'postCode', label: 'Почтовый индекс', labelEn: 'Post code', digitsOnly: true, optional: true },
    ],
  },
  {
    key: 'languages',
    icon: 'translate',
    title: 'Языки',
    titleEn: 'Language Proficiency',
    fields: [
      {
        key: 'chineseProficiency',
        label: 'Уровень китайского',
        labelEn: 'Chinese Proficiency',
        kind: 'select',
        noEmpty: true,
        options: [
          { value: 'NONE', label: 'Не владею' },
          { value: 'BASIC', label: 'Владею' },
          { value: 'GOOD', label: 'Хорошо' },
          { value: 'EXCELLENT', label: 'Отлично' },
          { value: 'NATIVE', label: 'Носитель' },
        ],
      },
      {
        key: 'hskLevel',
        label: 'Уровень HSK',
        labelEn: 'HSK Level',
        kind: 'select',
        noEmpty: true,
        options: [
          { value: 'NO', label: 'Нет' },
          { value: 'HSK1', label: 'HSK 1' },
          { value: 'HSK2', label: 'HSK 2' },
          { value: 'HSK3', label: 'HSK 3' },
          { value: 'HSK4', label: 'HSK 4' },
          { value: 'HSK5', label: 'HSK 5' },
          { value: 'HSK6', label: 'HSK 6' },
        ],
      },
      {
        key: 'englishProficiency',
        label: 'Уровень английского',
        labelEn: 'English Proficiency',
        kind: 'select',
        noEmpty: true,
        options: [
          { value: 'NONE', label: 'Не владею' },
          { value: 'BASIC', label: 'Владею' },
          { value: 'GOOD', label: 'Хорошо' },
          { value: 'EXCELLENT', label: 'Отлично' },
          { value: 'NATIVE', label: 'Носитель' },
        ],
      },
      { key: 'toefl', label: 'TOEFL (балл)', labelEn: 'TOEFL Score', kind: 'number', min: 0, max: 120, optional: true, digitsOnly: true },
      { key: 'ielts', label: 'IELTS (балл)', labelEn: 'IELTS Results', kind: 'number', min: 0, max: 9, optional: true },
    ],
  },
  {
    key: 'education',
    icon: 'school',
    title: 'Образование',
    titleEn: 'Education Background',
    table: {
      rowLabels: [
        'Начальная школа',
        'Средняя школа',
        'Старшая школа',
        'Бакалавриат',
        'Магистратура',
        'Языковые курсы',
      ],
      fixedRows: true,
      columns: [
        { key: 'schoolName', label: 'Название', labelEn: 'School Name', latin: true },
        { key: 'yearFrom', label: 'Год начала', labelEn: 'Year From', kind: 'year' },
        { key: 'yearTo', label: 'Год окончания', labelEn: 'Year To', kind: 'year', allowPresent: true },
        { key: 'major', label: 'Специальность', labelEn: 'Major', latinDigits: true, optional: true },
        { key: 'degree', label: 'Степень', labelEn: 'Degree', latinDigits: true, optional: true },
      ],
    },
  },
  {
    key: 'work',
    icon: 'work',
    title: 'Опыт работы',
    titleEn: 'Work Experience',
    table: {
      minRows: 1,
      columns: [
        { key: 'unit', label: 'Организация', labelEn: 'Working Unit Name', lettersOnly: true },
        { key: 'yearFrom', label: 'Год начала', labelEn: 'Year From', kind: 'year' },
        { key: 'yearTo', label: 'Год окончания', labelEn: 'Year To', kind: 'year', allowPresent: true },
        { key: 'position', label: 'Должность', labelEn: 'Position', lettersOnly: true },
        { key: 'place', label: 'Место работы', labelEn: 'Work Place', lettersOnly: true },
      ],
    },
  },
  {
    key: 'family',
    icon: 'groups',
    title: 'Семья',
    titleEn: 'Family of the Applicant',
    table: {
      rowLabels: ['Отец', 'Мать', 'Супруг(а)'],
      skipLabels: ['Нет отца', 'Нет матери', 'Нет супруга(-и)'],
      fixedRows: true,
      columns: [
        { key: 'fullName', label: 'ФИО', labelEn: 'Full Name', lettersOnly: true },
        { key: 'idNumber', label: 'Паспорт / ID', labelEn: 'ID / Passport', latinDigits: true },
        { key: 'age', label: 'Возраст', labelEn: 'Age', kind: 'number', min: 0, max: 120, digitsOnly: true },
        { key: 'jobTitle', label: 'Должность', labelEn: 'Job Title', lettersOnly: true, optional: true },
        { key: 'workPlace', label: 'Место работы', labelEn: 'Work Place', lettersOnly: true, optional: true },
        { key: 'phone', label: 'Телефон', labelEn: 'Phone', digitsOnly: true },
        { key: 'email', label: 'Email', labelEn: 'E-mail', kind: 'email', optional: true },
      ],
    },
  },
];

export function emptyForm(): any {
  const form: any = {};
  for (const s of FORM_SECTIONS) {
    if (s.fields) {
      form[s.key] = {};
      for (const f of s.fields) form[s.key][f.key] = '';
    } else if (s.table) {
      const rows = s.table.rowLabels?.length || s.table.minRows || 1;
      form[s.key] = Array.from({ length: rows }, () => {
        const row: any = {};
        for (const c of s.table!.columns) row[c.key] = '';
        return row;
      });
    }
  }
  return form;
}

export function countProgress(form: any): { filled: number; total: number } {
  let filled = 0;
  let total = 0;
  for (const s of FORM_SECTIONS) {
    if (s.fields) {
      for (const f of s.fields) {
        if (f.optional) continue;
        total++;
        if (form?.[s.key]?.[f.key]?.toString().trim()) filled++;
      }
    } else if (s.table) {
      const rows = form?.[s.key] || [];
      for (const row of rows) {
        if (row?.__notAttended) continue;
        for (const c of s.table.columns) {
          if (c.optional) continue;
          total++;
          if (row?.[c.key]?.toString().trim()) filled++;
        }
      }
    }
  }
  return { filled, total };
}

export function displayValue(def: FieldDef, raw: any): string {
  const v = raw?.toString().trim();
  if (!v) return '—';
  if (def.kind === 'year' && def.allowPresent && v === PRESENT_VALUE) return PRESENT_LABEL;
  if (def.options) {
    const opt = def.options.find((o) => o.value === v);
    return opt?.label || v;
  }
  return v;
}

// По запросу основателя разрешена кириллица во всех формах. Регексы
// принимают и латиницу, и русский (включая Ёё), и цифры/пунктуацию.
// Защита от HTML-инъекций и фигурных скобок остаётся в onChange-фильтре.
export const LATIN_RE = /^[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9 .,'\-/()&+#@№]*$/;
/** Только буквы (любой алфавит) + пробел/дефис/апостроф — для ФИО, должностей */
export const LETTERS_RE = /^[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ\s'\-]*$/;
/** Только буквы и цифры — для паспорта/специальности/степени */
export const LATIN_DIGITS_RE = /^[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9]*$/;

// Email по RFC обязан быть в Latin — здесь кириллицу НЕ разрешаем.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Валидация одного поля анкеты. Возвращает строку-ошибку или undefined.
 * row передаётся для cross-field проверок внутри строки таблицы (yearFrom/yearTo).
 */
export function validateField(def: FieldDef, raw: any, row?: any): string | undefined {
  const v = raw == null ? '' : String(raw).trim();

  if (!v) {
    return def.optional ? undefined : 'Обязательное поле';
  }

  if (def.lettersOnly && !LETTERS_RE.test(v)) return 'Допустимы только буквы';
  if (def.latinDigits && !LATIN_DIGITS_RE.test(v)) return 'Допустимы только буквы и цифры (без символов)';
  if (def.latin && !LATIN_RE.test(v)) return 'Недопустимые символы';
  // digitsOnly без kind=number (например, телефон родственника, индекс): только цифры
  if (def.digitsOnly && def.kind !== 'number' && !/^\d+$/.test(v)) return 'Только цифры';

  if (def.kind === 'email') {
    if (!EMAIL_RE.test(v)) return 'Некорректный email';
    return undefined;
  }

  if (def.kind === 'tel') {
    const digits = v.replace(/\D/g, '');
    if (digits.length < 7) return 'Номер слишком короткий (мин. 7 цифр)';
    if (digits.length > 15) return 'Номер слишком длинный (макс. 15 цифр)';
    return undefined;
  }

  if (def.kind === 'number') {
    const n = Number(v.replace(',', '.'));
    if (!Number.isFinite(n)) return 'Должно быть числом';
    if (def.digitsOnly && !Number.isInteger(n)) return 'Только целое число';
    if (def.min !== undefined && n < def.min) return `Минимум ${def.min}`;
    if (def.max !== undefined && n > def.max) return `Максимум ${def.max}`;
    return undefined;
  }

  if (def.kind === 'date') {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return 'Некорректная дата';
    // Дата рождения должна быть в прошлом
    if (def.key === 'birthDate' && d.getTime() > Date.now()) return 'Дата рождения должна быть в прошлом';
    // Срок действия паспорта — в будущем
    if (def.key === 'passportExpiry' && d.getTime() < Date.now()) return 'Срок действия паспорта истёк';
    return undefined;
  }

  if (def.kind === 'year') {
    if (v === PRESENT_VALUE) {
      // 'По настоящее время' допустимо только в yearTo
      if (def.key !== 'yearTo') return 'Недопустимое значение';
      return undefined;
    }
    const year = Number(v);
    if (!Number.isInteger(year)) return 'Год';
    // Cross-field: yearTo >= yearFrom
    if (def.key === 'yearTo' && row?.yearFrom && row.yearFrom !== PRESENT_VALUE) {
      const yf = Number(row.yearFrom);
      if (Number.isInteger(yf) && year < yf) return 'Год окончания раньше года начала';
    }
    return undefined;
  }

  if (def.kind === 'select' && def.options) {
    const ok = def.options.some((o) => o.value === v);
    if (!ok) return 'Выберите значение из списка';
    return undefined;
  }

  if (def.kind === 'radio' && def.options) {
    const ok = def.options.some((o) => o.value === v);
    if (!ok) return 'Выберите вариант';
    return undefined;
  }

  // textarea / text — длина не более 2000 символов
  if (v.length > 2000) return 'Слишком длинное значение (>2000 символов)';
  return undefined;
}
