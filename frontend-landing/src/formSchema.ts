export type FieldKind = 'text' | 'date' | 'email' | 'tel' | 'number' | 'textarea' | 'radio' | 'year' | 'select';

export interface FieldDef {
  key: string;
  label: string;
  labelEn?: string;
  kind?: FieldKind;
  placeholder?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  /** не учитывается в подсчёте «N из M полей» */
  optional?: boolean;
  /** разрешена только латиница / цифры / базовые знаки (адреса, поля типа "School #5") */
  latin?: boolean;
  /** ТОЛЬКО латинские буквы + пробел/дефис/апостроф (имена, ФИО, должности, страны) */
  lettersOnly?: boolean;
  /** ТОЛЬКО латинские буквы + цифры (паспорт, специальность, степень, ID) */
  latinDigits?: boolean;
  /** для number-полей: ограничение значения */
  min?: number;
  max?: number;
  /** для select: убрать пустой пункт «выберите» */
  noEmpty?: boolean;
  /** только цифры (без минусов, ведущих нулей и пр.) */
  digitsOnly?: boolean;
  /** для year-полей: добавить опцию «По настоящее время» */
  allowPresent?: boolean;
}

export const PRESENT_VALUE = 'PRESENT';
export const PRESENT_LABEL = 'То ҳол';

export interface SectionDef {
  key: string;
  icon: string;
  title: string;
  titleEn?: string;
  fields?: FieldDef[];
  table?: {
    columns: FieldDef[];
    defaultRows?: number;
    rowLabels?: string[]; // названия строк для education (Primary school, Secondary school, ...)
    fixedRows?: boolean; // если true — нельзя добавлять/удалять строки
    minRows?: number;
    /** Подпись чекбокса «отсутствует» для каждой строки. Если не задано — «Не учился(-ась)» */
    skipLabels?: string[];
  };
}

export const FORM_SECTIONS: SectionDef[] = [
  {
    key: 'personal',
    icon: 'person',
    title: 'Маълумоти шахсӣ',
    titleEn: 'Personal Information',
    fields: [
      { key: 'surname', label: 'Насаб (мувофиқи шиноснома)', labelEn: 'Surname', lettersOnly: true },
      { key: 'givenName', label: 'Ном (мувофиқи шиноснома)', labelEn: 'Given name', lettersOnly: true },
      { key: 'birthDate', label: 'Санаи таваллуд', labelEn: 'Date of Birth', kind: 'date' },
      { key: 'birthPlace', label: 'Ҷои таваллуд', labelEn: 'Place of Birth', lettersOnly: true },
      { key: 'nationality', label: 'Миллат', labelEn: 'Nationality', lettersOnly: true },
      { key: 'currentCountry', label: 'Кишвар / шаҳри ҳозира', labelEn: 'Present Country/City', lettersOnly: true },
      { key: 'passportNumber', label: 'Рақами шиноснома', labelEn: 'Passport No.', latinDigits: true },
      { key: 'passportExpiry', label: 'Мӯҳлати эътибори шиноснома', labelEn: 'Passport Expiration', kind: 'date' },
      {
        key: 'gender',
        label: 'Ҷинс',
        labelEn: 'Gender',
        kind: 'radio',
        options: [
          { value: 'MALE', label: 'Мард' },
          { value: 'FEMALE', label: 'Зан' },
        ],
      },
      { key: 'religion', label: 'Дин', labelEn: 'Religion', lettersOnly: true, optional: true },
      { key: 'nativeLanguage', label: 'Забони модарӣ', labelEn: 'Native Language', lettersOnly: true },
      { key: 'officialLanguage', label: 'Забони расмӣ', labelEn: 'Official Language', lettersOnly: true },
      {
        key: 'maritalStatus',
        label: 'Ҳолати оилавӣ',
        labelEn: 'Marital Status',
        kind: 'radio',
        options: [
          { value: 'SINGLE', label: 'Муҷаррад' },
          { value: 'MARRIED', label: 'Оиладор' },
          { value: 'DIVORCED', label: 'Ҷудошуда' },
          { value: 'OTHER', label: 'Дигар' },
        ],
      },
      {
        key: 'educationLevel',
        label: 'Сатҳи баландтарини маълумот',
        labelEn: 'Highest Education Level',
        kind: 'radio',
        options: [
          { value: 'HIGH_SCHOOL', label: 'Мактаби миёна' },
          { value: 'BACHELOR', label: 'Бакалавр' },
          { value: 'MASTER', label: 'Магистр' },
          { value: 'PHD', label: 'PhD' },
        ],
      },
      {
        key: 'inChina',
        label: 'Ҳоло дар Хитой ҳастед?',
        labelEn: 'Are you currently in China?',
        kind: 'radio',
        options: [
          { value: 'YES', label: 'Ҳа' },
          { value: 'NO', label: 'Не' },
        ],
      },
    ],
  },
  {
    key: 'address',
    icon: 'home',
    title: 'Суроғаи доимии зист',
    titleEn: 'Permanent Address',
    fields: [
      { key: 'home', label: 'Суроғаи хона', labelEn: 'Home Address', kind: 'textarea', placeholder: 'Кишвар, шаҳр, кӯча, хона', latin: true },
      { key: 'tel', label: 'Телефон', labelEn: 'Tel', kind: 'tel' },
      { key: 'email', label: 'Почтаи электронӣ', labelEn: 'Email', kind: 'email' },
      { key: 'postCode', label: 'Индекси почта', labelEn: 'Post code', digitsOnly: true, optional: true },
    ],
  },
  {
    key: 'languages',
    icon: 'translate',
    title: 'Забонҳо',
    titleEn: 'Language Proficiency',
    fields: [
      {
        key: 'chineseProficiency',
        label: 'Сатҳи забони хитоӣ',
        labelEn: 'Chinese Proficiency',
        kind: 'select',
        noEmpty: true,
        options: [
          { value: 'NONE', label: 'Намедонам' },
          { value: 'BASIC', label: 'Ибтидоӣ' },
          { value: 'GOOD', label: 'Хуб' },
          { value: 'EXCELLENT', label: 'Аъло' },
          { value: 'NATIVE', label: 'Забони модарӣ' },
        ],
      },
      {
        key: 'hskLevel',
        label: 'Сатҳи HSK',
        labelEn: 'HSK Level',
        kind: 'select',
        noEmpty: true,
        options: [
          { value: 'NO', label: 'Не' },
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
        label: 'Сатҳи забони англисӣ',
        labelEn: 'English Proficiency',
        kind: 'select',
        noEmpty: true,
        options: [
          { value: 'NONE', label: 'Намедонам' },
          { value: 'BASIC', label: 'Ибтидоӣ' },
          { value: 'GOOD', label: 'Хуб' },
          { value: 'EXCELLENT', label: 'Аъло' },
          { value: 'NATIVE', label: 'Забони модарӣ' },
        ],
      },
      { key: 'toefl', label: 'TOEFL (хол)', labelEn: 'TOEFL Score', kind: 'number', min: 0, max: 120, optional: true, digitsOnly: true },
      { key: 'ielts', label: 'IELTS (хол)', labelEn: 'IELTS Results', kind: 'number', min: 0, max: 9, optional: true },
    ],
  },
  {
    key: 'education',
    icon: 'school',
    title: 'Таҳсилот',
    titleEn: 'Education Background',
    table: {
      rowLabels: [
        'Мактаби ибтидоӣ',
        'Мактаби миёна',
        'Синфҳои болоӣ',
        'Бакалавр',
        'Магистратура',
        'Курсҳои забонӣ',
      ],
      fixedRows: true,
      columns: [
        { key: 'schoolName', label: 'Номи муассиса', labelEn: 'School Name', latin: true },
        { key: 'yearFrom', label: 'Соли оғоз', labelEn: 'Year From', kind: 'year' },
        { key: 'yearTo', label: 'Соли хатм', labelEn: 'Year To', kind: 'year', allowPresent: true },
        { key: 'major', label: 'Ихтисос', labelEn: 'Major', latinDigits: true, optional: true },
        { key: 'degree', label: 'Дараҷа', labelEn: 'Degree', latinDigits: true, optional: true },
      ],
    },
  },
  {
    key: 'work',
    icon: 'work',
    title: 'Таҷрибаи корӣ',
    titleEn: 'Work Experience',
    table: {
      minRows: 1,
      columns: [
        { key: 'unit', label: 'Ташкилот', labelEn: 'Working Unit Name', lettersOnly: true },
        { key: 'yearFrom', label: 'Соли оғоз', labelEn: 'Year From', kind: 'year' },
        { key: 'yearTo', label: 'Соли анҷом', labelEn: 'Year To', kind: 'year', allowPresent: true },
        { key: 'position', label: 'Вазифа', labelEn: 'Position', lettersOnly: true },
        { key: 'place', label: 'Ҷои кор', labelEn: 'Work Place', lettersOnly: true },
      ],
    },
  },
  {
    key: 'family',
    icon: 'groups',
    title: 'Оила',
    titleEn: 'Family of the Applicant',
    table: {
      rowLabels: ['Падар', 'Модар', 'Ҳамсар'],
      skipLabels: ['Падар надорам', 'Модар надорам', 'Ҳамсар надорам'],
      fixedRows: true,
      columns: [
        { key: 'fullName', label: 'Ному насаб', labelEn: 'Full Name', lettersOnly: true },
        { key: 'idNumber', label: 'Шиноснома / ID', labelEn: 'ID / Passport', latinDigits: true },
        { key: 'age', label: 'Синну сол', labelEn: 'Age', kind: 'number', min: 0, max: 120, digitsOnly: true },
        { key: 'jobTitle', label: 'Вазифа', labelEn: 'Job Title', lettersOnly: true, optional: true },
        { key: 'workPlace', label: 'Ҷои кор', labelEn: 'Work Place', lettersOnly: true, optional: true },
        { key: 'phone', label: 'Телефон', labelEn: 'Phone', digitsOnly: true },
        { key: 'email', label: 'Почтаи электронӣ', labelEn: 'E-mail', kind: 'email', optional: true },
      ],
    },
  },
];

/** Создаёт пустой объект формы с правильной структурой */
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

/** Подсчитывает количество заполненных полей (optional не учитывается) */
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
        // Строки с пометкой "не учился" вообще не считаем
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

// По запросу основателя разрешена кириллица во всех формах. Регексы
// принимают и латиницу, и русский (включая Ёё), и цифры/пунктуацию.
export const LATIN_RE = /^[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9 .,'\-/()&+#@№]*$/;
/** Только буквы (любой алфавит) + пробел/дефис/апостроф — для ФИО, должностей */
export const LETTERS_RE = /^[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ\s'\-]*$/;
/** Только буквы и цифры — для паспорта/специальности/степени */
export const LATIN_DIGITS_RE = /^[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9]*$/;

// Email по RFC обязан быть в латинице — здесь кириллицу НЕ разрешаем.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function validateField(def: FieldDef, raw: any, row?: any): string | undefined {
  const v = raw == null ? '' : String(raw).trim();

  if (!v) {
    return def.optional ? undefined : 'Майдони ҳатмӣ';
  }

  if (def.lettersOnly && !LETTERS_RE.test(v)) return 'Танҳо ҳарфҳо иҷозат дода мешаванд';
  if (def.latinDigits && !LATIN_DIGITS_RE.test(v)) return 'Танҳо ҳарфҳо ва рақамҳо (бе аломатҳо)';
  if (def.latin && !LATIN_RE.test(v)) return 'Аломатҳои иҷозатнашуда';
  // digitsOnly без kind=number (например, телефон родственника, индекс): только цифры
  if (def.digitsOnly && def.kind !== 'number' && !/^\d+$/.test(v)) return 'Танҳо рақамҳо';

  if (def.kind === 'email') {
    if (!EMAIL_RE.test(v)) return 'Почтаи электронӣ нодуруст';
    return undefined;
  }

  if (def.kind === 'tel') {
    const digits = v.replace(/\D/g, '');
    if (digits.length < 7) return 'Рақам хеле кӯтоҳ аст (ҳадди ақал 7 рақам)';
    if (digits.length > 15) return 'Рақам хеле дароз аст (ҳадди аксар 15 рақам)';
    return undefined;
  }

  if (def.kind === 'number') {
    const n = Number(v.replace(',', '.'));
    if (!Number.isFinite(n)) return 'Бояд рақам бошад';
    if (def.digitsOnly && !Number.isInteger(n)) return 'Танҳо адади бутун';
    if (def.min !== undefined && n < def.min) return `Ҳадди ақал ${def.min}`;
    if (def.max !== undefined && n > def.max) return `Ҳадди аксар ${def.max}`;
    return undefined;
  }

  if (def.kind === 'date') {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return 'Сана нодуруст';
    if (def.key === 'birthDate' && d.getTime() > Date.now()) return 'Санаи таваллуд бояд дар гузашта бошад';
    if (def.key === 'passportExpiry' && d.getTime() < Date.now()) return 'Мӯҳлати эътибори шиноснома гузаштааст';
    return undefined;
  }

  if (def.kind === 'year') {
    if (v === PRESENT_VALUE) {
      if (def.key !== 'yearTo') return 'Қимати иҷозатнашуда';
      return undefined;
    }
    const year = Number(v);
    if (!Number.isInteger(year)) return 'Сол';
    if (def.key === 'yearTo' && row?.yearFrom && row.yearFrom !== PRESENT_VALUE) {
      const yf = Number(row.yearFrom);
      if (Number.isInteger(yf) && year < yf) return 'Соли хатм аз соли оғоз пештар аст';
    }
    return undefined;
  }

  if (def.kind === 'select' && def.options) {
    const ok = def.options.some((o) => o.value === v);
    if (!ok) return 'Аз рӯйхат интихоб кунед';
    return undefined;
  }

  if (def.kind === 'radio' && def.options) {
    const ok = def.options.some((o) => o.value === v);
    if (!ok) return 'Вариантро интихоб кунед';
    return undefined;
  }

  if (v.length > 2000) return 'Қимат хеле дароз аст (>2000 аломат)';
  return undefined;
}
