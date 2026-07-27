import { useEffect, useMemo, useRef, useState } from 'react';

export type Country = {
  cc: string;     // ISO-2 lowercase, например 'tj' — для flagcdn.com
  code: string;   // dial code, например '+992'
  label: string;
  minDigits: number;
  maxDigits: number;
};

// Полный список стран для подачи заявки/анкеты студента.
// Лимит длины номера — 7..15 цифр всего (E.164), без жёсткой привязки к стране.
export const COUNTRIES: Country[] = [
  { cc: 'tj', code: '+992', label: 'Тоҷикистон',  minDigits: 7, maxDigits: 15 },
  { cc: 'ru', code: '+7',   label: 'Русия',       minDigits: 7, maxDigits: 15 },
  { cc: 'kz', code: '+7',   label: 'Қазоқистон',  minDigits: 7, maxDigits: 15 },
  { cc: 'uz', code: '+998', label: 'Ӯзбекистон',  minDigits: 7, maxDigits: 15 },
  { cc: 'kg', code: '+996', label: 'Қирғизистон', minDigits: 7, maxDigits: 15 },
  { cc: 'cn', code: '+86',  label: 'Хитой',       minDigits: 7, maxDigits: 15 },
  { cc: 'tm', code: '+993', label: 'Туркманистон',minDigits: 7, maxDigits: 15 },
  { cc: 'af', code: '+93',  label: 'Афғонистон',  minDigits: 7, maxDigits: 15 },
  { cc: 'tr', code: '+90',  label: 'Туркия',      minDigits: 7, maxDigits: 15 },
  { cc: 'ae', code: '+971', label: 'Аморати Муттаҳидаи Араб', minDigits: 7, maxDigits: 15 },
  { cc: 'sa', code: '+966', label: 'Арабистони Саудӣ', minDigits: 7, maxDigits: 15 },
  { cc: 'ir', code: '+98',  label: 'Эрон',        minDigits: 7, maxDigits: 15 },
  { cc: 'in', code: '+91',  label: 'Ҳиндустон',   minDigits: 7, maxDigits: 15 },
  { cc: 'pk', code: '+92',  label: 'Покистон',    minDigits: 7, maxDigits: 15 },
  { cc: 'bd', code: '+880', label: 'Бангладеш',   minDigits: 7, maxDigits: 15 },
  { cc: 'us', code: '+1',   label: 'ИМА',         minDigits: 7, maxDigits: 15 },
  { cc: 'gb', code: '+44',  label: 'Британияи Кабир', minDigits: 7, maxDigits: 15 },
  { cc: 'de', code: '+49',  label: 'Олмон',       minDigits: 7, maxDigits: 15 },
  { cc: 'fr', code: '+33',  label: 'Фаронса',     minDigits: 7, maxDigits: 15 },
  { cc: 'it', code: '+39',  label: 'Италия',      minDigits: 7, maxDigits: 15 },
  { cc: 'es', code: '+34',  label: 'Испания',     minDigits: 7, maxDigits: 15 },
  { cc: 'kr', code: '+82',  label: 'Кореяи Ҷанубӣ', minDigits: 7, maxDigits: 15 },
  { cc: 'jp', code: '+81',  label: 'Ҷопон',       minDigits: 7, maxDigits: 15 },
  { cc: 'th', code: '+66',  label: 'Таиланд',     minDigits: 7, maxDigits: 15 },
  { cc: 'vn', code: '+84',  label: 'Ветнам',      minDigits: 7, maxDigits: 15 },
  { cc: 'my', code: '+60',  label: 'Малайзия',    minDigits: 7, maxDigits: 15 },
  { cc: 'id', code: '+62',  label: 'Индонезия',   minDigits: 7, maxDigits: 15 },
  { cc: 'mn', code: '+976', label: 'Муғулистон',  minDigits: 7, maxDigits: 15 },
  { cc: 'az', code: '+994', label: 'Озарбойҷон',  minDigits: 7, maxDigits: 15 },
  { cc: 'am', code: '+374', label: 'Арманистон',  minDigits: 7, maxDigits: 15 },
  { cc: 'ge', code: '+995', label: 'Гурҷистон',   minDigits: 7, maxDigits: 15 },
  { cc: 'by', code: '+375', label: 'Беларус',     minDigits: 7, maxDigits: 15 },
  { cc: 'ua', code: '+380', label: 'Украина',     minDigits: 7, maxDigits: 15 },
  { cc: 'eg', code: '+20',  label: 'Миср',        minDigits: 7, maxDigits: 15 },
];

const flagUrl = (cc: string, size: 20 | 40 | 80 = 40) =>
  `https://flagcdn.com/w${size}/${cc}.png`;

const findCountryByPhone = (phone: string): { idx: number; rest: string } => {
  if (!phone) return { idx: 0, rest: '' };
  const normalized = phone.startsWith('+') ? phone : `+${phone}`;
  // Сортируем по длине кода — длинные сначала, чтобы +998 не падал в +9
  const sorted = COUNTRIES.map((c, i) => ({ c, i })).sort(
    (a, b) => b.c.code.length - a.c.code.length,
  );
  for (const { c, i } of sorted) {
    if (normalized.startsWith(c.code)) {
      return { idx: i, rest: normalized.slice(c.code.length).replace(/\D/g, '') };
    }
  }
  return { idx: 0, rest: normalized.replace(/\D/g, '') };
};

interface Props {
  /** Полный номер с кодом, например "+992123456789" */
  value: string;
  /** Возвращает полный номер с кодом */
  onChange: (fullPhone: string) => void;
  error?: boolean;
  placeholder?: string;
}

/**
 * Поле телефона с кастомным dropdown стран:
 *  - реальные флаги (PNG с flagcdn.com)
 *  - поле поиска внутри списка
 *  - dial-code и название страны
 * По умолчанию подставляет +992 🇹🇯.
 */
export default function PhoneInput({ value, onChange, error, placeholder }: Props) {
  // Lazy initializer: вычисляется один раз при монтировании по props.value.
  const [countryIdx, setCountryIdx] = useState(() => findCountryByPhone(value || '+992').idx);
  const [local, setLocal] = useState(() => findCountryByPhone(value || '+992').rest);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Синхронизация с внешним value. countryIdx/local держим в ref чтобы effect
  // мог их сравнить без попадания в deps (иначе зацикливание).
  const stateRef = useRef({ countryIdx, local });
  stateRef.current = { countryIdx, local };
  useEffect(() => {
    if (!value) {
      setLocal('');
      return;
    }
    const parsed = findCountryByPhone(value);
    if (parsed.idx !== stateRef.current.countryIdx || parsed.rest !== stateRef.current.local) {
      setCountryIdx(parsed.idx);
      setLocal(parsed.rest);
    }
  }, [value]);

  // Закрытие dropdown по клику вне или Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // фокусируем поиск
    setTimeout(() => searchRef.current?.focus(), 30);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const country = COUNTRIES[countryIdx];

  const update = (idx: number, digits: string) => {
    setCountryIdx(idx);
    setLocal(digits);
    const c = COUNTRIES[idx];
    onChange(digits ? `${c.code}${digits}` : '');
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return COUNTRIES.map((c, i) => ({ c, i }));
    return COUNTRIES
      .map((c, i) => ({ c, i }))
      .filter(({ c }) =>
        c.label.toLowerCase().includes(q) ||
        c.code.includes(q) ||
        c.cc.includes(q),
      );
  }, [search]);

  const pick = (idx: number) => {
    update(idx, local);
    setOpen(false);
    setSearch('');
  };

  // Inline-стили на критичные для layout И визуальные свойства,
  // чтобы перебить любые глобальные правила и кеши. Внешний вид
  // подобран ровно как у обычного <input> на лендинге.
  const wrapStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    flexWrap: 'nowrap',
    width: '100%',
    boxSizing: 'border-box',
    border: `1.5px solid ${error ? 'var(--danger, #dc2626)' : 'var(--border, #e5e7eb)'}`,
    borderRadius: 10,
    background: error ? '#fef2f2' : '#fff',
    overflow: 'hidden',
  };
  const btnStyle: React.CSSProperties = {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 10px',
    border: 'none',
    borderRight: '1px solid var(--border, #e5e7eb)',
    background: 'transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    height: 'auto',
  };
  const inputStyle: React.CSSProperties = {
    flex: '1 1 0',
    minWidth: 0,
    width: 'auto',
    maxWidth: '100%',
    border: 'none',
    background: 'transparent',
    outline: 'none',
    padding: '12px 14px',
    fontSize: 16, /* >=16 чтобы iOS не зумил при focus */
    color: 'var(--text, #0f172a)',
    boxShadow: 'none',
  };

  return (
    <div
      ref={wrapRef}
      className={`phone-input-wrap${error ? ' input-error' : ''}`}
      style={wrapStyle}
    >
      <button
        type="button"
        className="phone-country-btn"
        style={btnStyle}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <img
          src={flagUrl(country.cc)}
          srcSet={`${flagUrl(country.cc, 40)} 1x, ${flagUrl(country.cc, 80)} 2x`}
          alt={country.label}
          className="phone-country-flag"
          loading="lazy"
        />
        <span
          className="phone-country-code"
          style={{ color: '#0f172a', fontSize: 13, fontWeight: 600 }}
        >
          {country.code}
        </span>
        <span
          className="phone-country-caret"
          style={{ color: '#64748b', fontSize: 10, marginLeft: 4 }}
        >
          ▾
        </span>
      </button>

      <input
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={local}
        maxLength={country.maxDigits}
        placeholder={placeholder || '9'.repeat(country.minDigits)}
        style={inputStyle}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, country.maxDigits);
          update(countryIdx, digits);
        }}
      />

      {open && (
        <div className="phone-dropdown" role="listbox">
          <div className="phone-dropdown-search">
            <input
              ref={searchRef}
              type="text"
              placeholder="Ҷустуҷӯи кишвар ё код..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="phone-dropdown-list">
            {filtered.length === 0 ? (
              <div className="phone-dropdown-empty">Ёфт нашуд</div>
            ) : (
              filtered.map(({ c, i }) => (
                <button
                  key={`${c.cc}-${c.code}`}
                  type="button"
                  role="option"
                  aria-selected={i === countryIdx}
                  className={`phone-dropdown-item${i === countryIdx ? ' active' : ''}`}
                  onClick={() => pick(i)}
                >
                  <img
                    src={flagUrl(c.cc)}
                    srcSet={`${flagUrl(c.cc, 40)} 1x, ${flagUrl(c.cc, 80)} 2x`}
                    alt=""
                    className="phone-country-flag"
                    loading="lazy"
                  />
                  <span className="phone-dropdown-label">{c.label}</span>
                  <span className="phone-dropdown-code">{c.code}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
