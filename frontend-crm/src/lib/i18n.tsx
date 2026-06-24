import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Минималистичный i18n для CRM (ТЗ-доработка п.11).
 * Без библиотек (react-i18next +50KB) — простой Context с словарём.
 * Переключение языка хранится в localStorage 'javonon_lang'.
 *
 * Использование:
 *   const { t, lang, setLang } = useT();
 *   <button>{t('common.save')}</button>
 *
 * Если ключ не найден — возвращает сам ключ (видно где не переведено).
 *
 * Образцы переводов охватывают Sidebar / Programs / общие кнопки. Полный
 * перевод 30+ страниц — следующий этап (расширение dictionaries.ts).
 */

export type Lang = 'ru' | 'tg';

const DEFAULT_LANG: Lang = 'ru';
const STORAGE_KEY = 'javonon_lang';

const DICT: Record<Lang, Record<string, string>> = {
  ru: {
    'common.save': 'Сохранить',
    'common.cancel': 'Отмена',
    'common.delete': 'Удалить',
    'common.edit': 'Редактировать',
    'common.add': 'Добавить',
    'common.search': 'Поиск',
    'common.loading': 'Загрузка…',
    'common.empty': 'Ничего не найдено',
    'common.yes': 'Да',
    'common.no': 'Нет',
    'sidebar.dashboard': 'Дашборд',
    'sidebar.applications': 'Заявки',
    'sidebar.students': 'Студенты',
    'sidebar.programs': 'Программы',
    'sidebar.tasks': 'Задачи',
    'sidebar.chat': 'Чат',
    'sidebar.time': 'Время',
    'sidebar.reports': 'Мои отчёты',
    'sidebar.calls': 'Звонки',
    'sidebar.kpi': 'KPI',
    'sidebar.profile': 'Мой профиль',
    'sidebar.finance': 'Финансы',
    'sidebar.salary': 'Зарплата',
    'sidebar.users': 'Сотрудники',
    'sidebar.settings': 'Настройки системы',
    'programs.title': 'Программы обучения',
    'programs.new': 'Новая программа',
    'programs.empty': 'Программ пока нет',
    'programs.all': 'Все',
    'programs.field.name': 'Название программы',
    'programs.field.university': 'Университет',
    'programs.field.country': 'Страна',
    'programs.field.city': 'Город',
    'programs.field.major': 'Специальность',
    'programs.field.cost': 'Стоимость / год',
    'programs.field.currency': 'Валюта',
    'programs.field.duration': 'Длительность',
    'programs.field.language': 'Язык обучения',
    'programs.field.disciplines': 'Академические направления / специализации',
    'programs.field.website': 'Официальный сайт университета',
    'programs.field.description': 'Описание',
    'programs.field.published': 'Показывать на лендинге',
    'programs.cta.officialSite': '🌐 Официальный сайт',
    'lang.switch': 'Язык',
    'lang.ru': 'Русский',
    'lang.tg': 'Тоҷикӣ',
  },
  tg: {
    'common.save': 'Сабт',
    'common.cancel': 'Бекор',
    'common.delete': 'Несткунӣ',
    'common.edit': 'Таҳрир',
    'common.add': 'Илова',
    'common.search': 'Ҷустуҷӯ',
    'common.loading': 'Боргузорӣ…',
    'common.empty': 'Ҳеҷ чизе ёфт нашуд',
    'common.yes': 'Ҳа',
    'common.no': 'Не',
    'sidebar.dashboard': 'Тахтаи асосӣ',
    'sidebar.applications': 'Аризаҳо',
    'sidebar.students': 'Донишҷӯён',
    'sidebar.programs': 'Барномаҳо',
    'sidebar.tasks': 'Вазифаҳо',
    'sidebar.chat': 'Чат',
    'sidebar.time': 'Вақт',
    'sidebar.reports': 'Ҳисоботи ман',
    'sidebar.calls': 'Занг',
    'sidebar.kpi': 'KPI',
    'sidebar.profile': 'Профили ман',
    'sidebar.finance': 'Молия',
    'sidebar.salary': 'Маош',
    'sidebar.users': 'Кормандон',
    'sidebar.settings': 'Танзимоти система',
    'programs.title': 'Барномаҳои таълимӣ',
    'programs.new': 'Барномаи нав',
    'programs.empty': 'Ҳоло барнома нест',
    'programs.all': 'Ҳама',
    'programs.field.name': 'Номи барнома',
    'programs.field.university': 'Донишгоҳ',
    'programs.field.country': 'Кишвар',
    'programs.field.city': 'Шаҳр',
    'programs.field.major': 'Тахассус',
    'programs.field.cost': 'Арзиш / сол',
    'programs.field.currency': 'Асъор',
    'programs.field.duration': 'Давомнокӣ',
    'programs.field.language': 'Забони таълим',
    'programs.field.disciplines': 'Самтҳои таълимӣ / тахассусҳо',
    'programs.field.website': 'Сайти расмии донишгоҳ',
    'programs.field.description': 'Тавсиф',
    'programs.field.published': 'Дар сайт нишон додан',
    'programs.cta.officialSite': '🌐 Сайти расмӣ',
    'lang.switch': 'Забон',
    'lang.ru': 'Русӣ',
    'lang.tg': 'Тоҷикӣ',
  },
};

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nState>({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (k) => k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY) as Lang | null;
      return v === 'ru' || v === 'tg' ? v : DEFAULT_LANG;
    } catch {
      return DEFAULT_LANG;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    document.documentElement.setAttribute('lang', lang === 'tg' ? 'tg' : 'ru');
  }, [lang]);

  const t = (key: string): string => DICT[lang]?.[key] ?? key;
  return (
    <I18nContext.Provider value={{ lang, setLang: setLangState, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  return useContext(I18nContext);
}

/** Переключатель языка для шапки/Sidebar. */
export function LangSwitcher() {
  const { lang, setLang } = useT();
  return (
    <div style={{ display: 'inline-flex', gap: 4, padding: 2, borderRadius: 999, background: 'rgba(255,255,255,0.06)' }}>
      <button
        onClick={() => setLang('ru')}
        style={langBtnStyle(lang === 'ru')}
        title="Русский"
      >RU</button>
      <button
        onClick={() => setLang('tg')}
        style={langBtnStyle(lang === 'tg')}
        title="Тоҷикӣ"
      >TJ</button>
    </div>
  );
}

function langBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '3px 8px',
    borderRadius: 999,
    border: 'none',
    cursor: 'pointer',
    background: active ? 'white' : 'transparent',
    color: active ? '#0f172a' : 'rgba(255,255,255,0.75)',
    fontWeight: 600,
    fontSize: 11,
  };
}
