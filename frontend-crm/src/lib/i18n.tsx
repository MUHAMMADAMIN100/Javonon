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
    'common.upload': 'Загрузить',
    'common.replace': 'Заменить',
    'common.optional': 'опц.',
    'sidebar.dashboard': 'Дашборд',
    'sidebar.applications': 'Заявки',
    'sidebar.students': 'Студенты',
    'sidebar.programs': 'Программы',
    'sidebar.tasks': 'Задачи',
    'sidebar.chat': 'Чат',
    'sidebar.inbox': 'Входящие',
    'sidebar.time': 'Время',
    'sidebar.reports': 'Мои отчёты',
    'sidebar.calls': 'Звонки',
    'sidebar.kpi': 'KPI',
    'sidebar.profile': 'Мой профиль',
    'sidebar.finance': 'Финансы',
    'sidebar.salary': 'Зарплата',
    'sidebar.users': 'Сотрудники',
    'sidebar.settings': 'Настройки системы',
    'sidebar.pipelines': 'Воронки',
    'sidebar.massmail': 'Рассылки',
    'sidebar.offers': 'Оферты',
    'sidebar.lms': 'Обучение',
    'sidebar.partners': 'Партнёры',
    'sidebar.activity': 'Активность',
    'sidebar.excuses': 'Причины',
    'sidebar.attendance': 'Посещаемость',
    'sidebar.knowledge': 'База знаний',
    'sidebar.logout': 'Выйти',
    'sidebar.changePassword': 'Сменить пароль',
    'auth.email': 'Email',
    'auth.password': 'Пароль',
    'auth.login': 'Войти',
    'auth.loginTitle': 'Вход в систему',
    'auth.fullName': 'ФИО',
    'auth.register': 'Зарегистрироваться',
    'programs.title': 'Программы обучения',
    'programs.new': 'Новая программа',
    'programs.edit': 'Редактировать программу',
    'programs.empty': 'Программ пока нет',
    'programs.all': 'Все',
    'programs.filter.city': 'Город',
    'programs.filter.major': 'Специальность',
    'programs.filter.direction': 'Все направления',
    'programs.field.name': 'Название программы',
    'programs.field.university': 'Университет',
    'programs.field.country': 'Страна',
    'programs.field.city': 'Город',
    'programs.field.major': 'Специальность',
    'programs.field.direction': 'Направление',
    'programs.field.cost': 'Стоимость / год',
    'programs.field.costHint': '0 = бесплатная / уточняется',
    'programs.field.currency': 'Валюта',
    'programs.field.duration': 'Длительность',
    'programs.field.language': 'Язык обучения',
    'programs.field.languageEmpty': '— Выберите язык —',
    'programs.field.englishLevel': 'Уровень английского',
    'programs.field.avgScore': 'Средний проходной балл',
    'programs.field.deadline': 'Дедлайн подачи',
    'programs.field.intakes': 'Наборов в год',
    'programs.field.disciplines': 'Академические направления / специализации',
    'programs.field.disciplinesHint': 'Конкретные специализации внутри программы (до 30 шт.)',
    'programs.field.website': 'Официальный сайт университета',
    'programs.field.websiteHint': 'Просто вставь URL — на карточке кнопка появится сама.',
    'programs.field.description': 'Описание',
    'programs.field.image': 'Картинка программы',
    'programs.field.gallery': 'Галерея фото',
    'programs.field.published': 'Показывать на лендинге',
    'programs.cta.officialSite': '🌐 Официальный сайт',
    'programs.cta.back': '← Назад к программам',
    'programs.section.main': 'Основное',
    'programs.section.disciplines': 'Направления',
    'programs.section.scholarships': '🎓 Стипендии и гранты',
    'programs.section.description': 'Описание программы',
    'programs.section.documents': '📎 Документы',
    'programs.section.comments': '💬 Комментарии',
    'programs.scholarship.add': '+ Добавить стипендию',
    'programs.scholarship.empty': 'Стипендий пока нет',
    'programs.documents.empty': 'Документов пока нет',
    'programs.documents.add': '+ Загрузить документ',
    'programs.comments.empty': 'Комментариев пока нет',
    'programs.comments.placeholder': 'Внутренний комментарий — виден только сотрудникам',
    'programs.comments.send': 'Отправить',
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
    'common.upload': 'Боргузорӣ',
    'common.replace': 'Иваз кардан',
    'common.optional': 'ихтиёрӣ',
    'sidebar.dashboard': 'Тахтаи асосӣ',
    'sidebar.applications': 'Аризаҳо',
    'sidebar.students': 'Донишҷӯён',
    'sidebar.programs': 'Барномаҳо',
    'sidebar.tasks': 'Вазифаҳо',
    'sidebar.chat': 'Чат',
    'sidebar.inbox': 'Воридшаванда',
    'sidebar.time': 'Вақт',
    'sidebar.reports': 'Ҳисоботи ман',
    'sidebar.calls': 'Занг',
    'sidebar.kpi': 'KPI',
    'sidebar.profile': 'Профили ман',
    'sidebar.finance': 'Молия',
    'sidebar.salary': 'Маош',
    'sidebar.users': 'Кормандон',
    'sidebar.settings': 'Танзимоти система',
    'sidebar.pipelines': 'Каналҳои фурӯш',
    'sidebar.massmail': 'Паёмҳо',
    'sidebar.offers': 'Қарордодҳо',
    'sidebar.lms': 'Таълим',
    'sidebar.partners': 'Шарикон',
    'sidebar.activity': 'Фаъолият',
    'sidebar.excuses': 'Сабабҳо',
    'sidebar.attendance': 'Иштирок',
    'sidebar.knowledge': 'Базаи дониш',
    'sidebar.logout': 'Баромад',
    'sidebar.changePassword': 'Тағйири парол',
    'auth.email': 'Email',
    'auth.password': 'Парол',
    'auth.login': 'Ворид',
    'auth.loginTitle': 'Ба система ворид шавед',
    'auth.fullName': 'Ному насаб',
    'auth.register': 'Сабти ном',
    'programs.title': 'Барномаҳои таълимӣ',
    'programs.new': 'Барномаи нав',
    'programs.edit': 'Таҳрири барнома',
    'programs.empty': 'Ҳоло барнома нест',
    'programs.all': 'Ҳама',
    'programs.filter.city': 'Шаҳр',
    'programs.filter.major': 'Тахассус',
    'programs.filter.direction': 'Ҳама самтҳо',
    'programs.field.name': 'Номи барнома',
    'programs.field.university': 'Донишгоҳ',
    'programs.field.country': 'Кишвар',
    'programs.field.city': 'Шаҳр',
    'programs.field.major': 'Тахассус',
    'programs.field.direction': 'Самт',
    'programs.field.cost': 'Арзиш / сол',
    'programs.field.costHint': '0 = ройгон / муайян карда мешавад',
    'programs.field.currency': 'Асъор',
    'programs.field.duration': 'Давомнокӣ',
    'programs.field.language': 'Забони таълим',
    'programs.field.languageEmpty': '— Забонро интихоб кунед —',
    'programs.field.englishLevel': 'Сатҳи англисӣ',
    'programs.field.avgScore': 'Балли қабул',
    'programs.field.deadline': 'Мӯҳлати ариза',
    'programs.field.intakes': 'Қабул дар сол',
    'programs.field.disciplines': 'Самтҳои таълимӣ / тахассусҳо',
    'programs.field.disciplinesHint': 'Тахассусҳои мушаххас дар дохили барнома (то 30 дона)',
    'programs.field.website': 'Сайти расмии донишгоҳ',
    'programs.field.websiteHint': 'Танҳо URL гузоред — тугмаи карточка худаш пайдо мешавад.',
    'programs.field.description': 'Тавсиф',
    'programs.field.image': 'Расми барнома',
    'programs.field.gallery': 'Галерея',
    'programs.field.published': 'Дар сайт нишон додан',
    'programs.cta.officialSite': '🌐 Сайти расмӣ',
    'programs.cta.back': '← Бозгашт ба барномаҳо',
    'programs.section.main': 'Маълумоти асосӣ',
    'programs.section.disciplines': 'Самтҳо',
    'programs.section.scholarships': '🎓 Стипендияҳо ва грантҳо',
    'programs.section.description': 'Тавсифи барнома',
    'programs.section.documents': '📎 Ҳуҷҷатҳо',
    'programs.section.comments': '💬 Шарҳҳо',
    'programs.scholarship.add': '+ Илова кардани стипендия',
    'programs.scholarship.empty': 'Стипендия нест',
    'programs.documents.empty': 'Ҳуҷҷатҳо нестанд',
    'programs.documents.add': '+ Боргузории ҳуҷҷат',
    'programs.comments.empty': 'Шарҳҳо нестанд',
    'programs.comments.placeholder': 'Шарҳи дохилӣ — танҳо ба кормандон',
    'programs.comments.send': 'Фиристодан',
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
