import { LookupKind } from '@prisma/client';

/**
 * Начальное наполнение справочников («Лиды → Настройки», 13.11.2026).
 *
 * Ключи — ровно прежние значения enum'ов: ими уже подписаны строки
 * Application/Student/Program, и на них держится логика (NEW_LEAD,
 * SUCCESSFUL_LEAD, заглушка BACHELOR, источник OTHER у ручного лида…).
 * Подписи и цвета — те, что CRM показывала до справочника (i18n + badge-*).
 *
 * Заполняется ОДИН раз — когда вида ещё нет в таблице. Системные значения
 * дозаводятся всегда (удалить их нельзя, но строки могли не дожить до
 * этой версии), остальное после первого запуска принадлежит основателю:
 * удалённую им страну мы не воскрешаем.
 */
export interface LookupDefault {
  key: string;
  labelRu: string;
  labelTg: string;
  color?: string | null;
  isSystem?: boolean;
  clientLabel?: string | null;
  isClosed?: boolean;
}

/** Цвета прежних плашек (styles/theme.css, index.css). */
const BLUE = '#1E5BB8';
const AMBER = '#B45309';
const GREEN = '#15803D';
const RED = '#DC2626';
const GRAY = '#64748B';

export const LOOKUP_DEFAULTS: Record<LookupKind, LookupDefault[]> = {
  LEAD_STATUS: [
    { key: 'NEW_LEAD', labelRu: 'Новые лиды', labelTg: 'Лидҳои нав', color: BLUE, isSystem: true, clientLabel: 'Принята' },
    { key: 'IN_PROCESSING', labelRu: 'В обработке', labelTg: 'Дар коркард', color: AMBER, isSystem: true, clientLabel: 'В обработке' },
    { key: 'ONLINE_CONSULTATION', labelRu: 'Онлайн консультации', labelTg: 'Машварати онлайн', color: AMBER, clientLabel: 'Онлайн-консультация' },
    { key: 'OFFLINE_CONSULTATION', labelRu: 'Оффлайн консультации', labelTg: 'Машварати офлайн', color: AMBER, clientLabel: 'Очная консультация' },
    { key: 'THINKING', labelRu: 'Думает', labelTg: 'Фикр дорад', color: AMBER },
    { key: 'OUT_OF_TOWN', labelRu: 'Вне города', labelTg: 'Берун аз шаҳр', color: GRAY },
    { key: 'UNDER_17', labelRu: 'До 17 лет', labelTg: 'Аз 17 сола поён', color: GRAY },
    { key: 'POTENTIAL_LEAD', labelRu: 'Потенциальные лиды', labelTg: 'Лидҳои эҳтимолӣ', color: BLUE },
    { key: 'LOW_QUALITY_LEAD', labelRu: 'Некачественные лиды', labelTg: 'Лиди нолозим', color: RED, isClosed: true },
    { key: 'SUCCESSFUL_LEAD', labelRu: 'Успешные лиды', labelTg: 'Лидҳои муваффақ', color: GREEN, isSystem: true, clientLabel: 'Оформлена' },
  ],
  DIRECTION: [
    // BACHELOR — заглушка направления у лида с сайта (directionConfirmed=false).
    { key: 'BACHELOR', labelRu: 'Бакалавриат', labelTg: 'Бакалавр', isSystem: true },
    { key: 'MASTER', labelRu: 'Магистратура', labelTg: 'Магистр' },
    { key: 'LANGUAGE', labelRu: 'Языковые курсы', labelTg: 'Курсҳои забон' },
    { key: 'LANGUAGE_COLLEGE', labelRu: 'Языковой + колледж', labelTg: 'Забон + коллеҷ' },
    { key: 'LANGUAGE_BACHELOR', labelRu: 'Языковой + бакалавриат', labelTg: 'Забон + бакалавр' },
    { key: 'COLLEGE', labelRu: 'Колледж', labelTg: 'Коллеҷ' },
  ],
  COUNTRY: [
    { key: 'USA', labelRu: 'США', labelTg: 'Амрико' },
    { key: 'KOREA', labelRu: 'Корея', labelTg: 'Корея' },
    { key: 'CHINA', labelRu: 'Китай', labelTg: 'Хитой' },
    { key: 'LATVIA', labelRu: 'Латвия', labelTg: 'Латвия' },
    { key: 'MALAYSIA', labelRu: 'Малайзия', labelTg: 'Малайзия' },
    { key: 'ITALY', labelRu: 'Италия', labelTg: 'Италия' },
    { key: 'GERMANY', labelRu: 'Германия', labelTg: 'Олмон' },
  ],
  LEAD_SOURCE: [
    // Сайт, самозапись и партнёр ставит система; «Другое» — у ручного лида по умолчанию.
    { key: 'LANDING_FORM', labelRu: 'Сайт', labelTg: 'Сайт', color: '#2563EB', isSystem: true },
    { key: 'SELF_REGISTRATION', labelRu: 'Самозапись', labelTg: 'Худсабтином', color: GREEN, isSystem: true },
    { key: 'REFERRAL', labelRu: 'Реферал', labelTg: 'Реферал', color: AMBER, isSystem: true },
    { key: 'INSTAGRAM', labelRu: 'Instagram', labelTg: 'Instagram', color: '#C1358A' },
    { key: 'TELEGRAM', labelRu: 'Telegram', labelTg: 'Telegram', color: '#1E6FA6' },
    { key: 'GOOGLE_ADS', labelRu: 'Google Ads', labelTg: 'Google Ads', color: '#C2410C' },
    { key: 'TIKTOK', labelRu: 'TikTok', labelTg: 'TikTok', color: '#111827' },
    { key: 'WORD_OF_MOUTH', labelRu: 'Сарафан', labelTg: 'Аз шунидаҳо', color: GRAY },
    { key: 'EVENT', labelRu: 'Мероприятие', labelTg: 'Чорабинӣ', color: '#7C3AED' },
    { key: 'OTHER', labelRu: 'Другое', labelTg: 'Дигар', color: GRAY, isSystem: true },
  ],
};

/** Источники, которые ставит только система — в выпадающих списках сотрудника их нет. */
export const MACHINE_SOURCES = ['LANDING_FORM', 'SELF_REGISTRATION', 'REFERRAL'];

/**
 * Статусы, у которых нельзя менять «закрыт»: новый лид, в работе и успешный
 * определяют поток заявки, а не оценку менеджера.
 */
export const FLOW_STATUSES = ['NEW_LEAD', 'IN_PROCESSING', 'SUCCESSFUL_LEAD'];

/**
 * Подписи легаси-статусов старой воронки: строк с ними в справочнике нет
 * (выбрать их заново нельзя), но старая строка или старая вкладка CRM может
 * их прислать — сообщение об ошибке должно быть человеческим.
 */
export const LEGACY_STATUS_LABEL: Record<string, string> = {
  NEW: 'Новый лид',
  IN_PROGRESS: 'В работе',
  COMPLETED: 'Завершена',
  DOCS_REVIEW: 'Документы на проверке',
  DOCS_SUBMITTED: 'Документы поданы',
  PRE_ADMISSION: 'Предварительное зачисление',
  AWAITING_PAYMENT: 'Ожидание оплаты',
  ENROLLED: 'Зачислен',
};

export const LOOKUP_KINDS: LookupKind[] = ['LEAD_STATUS', 'DIRECTION', 'COUNTRY', 'LEAD_SOURCE'];

/** Как назвать вид в сообщениях об ошибке («Выберите страну из списка»). */
export const KIND_ACCUSATIVE: Record<LookupKind, string> = {
  LEAD_STATUS: 'статус',
  DIRECTION: 'направление',
  COUNTRY: 'страну',
  LEAD_SOURCE: 'источник',
};
