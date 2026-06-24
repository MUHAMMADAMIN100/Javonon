import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../lib/i18n';

export type Country = {
  cc: string;
  code: string;
  label: string;
  minDigits: number;
  maxDigits: number;
};

export const COUNTRIES: Country[] = [
  { cc: 'tj', code: '+992', label: 'Таджикистан', minDigits: 7, maxDigits: 15 },
  { cc: 'ru', code: '+7',   label: 'Россия',      minDigits: 7, maxDigits: 15 },
  { cc: 'kz', code: '+7',   label: 'Казахстан',   minDigits: 7, maxDigits: 15 },
  { cc: 'uz', code: '+998', label: 'Узбекистан',  minDigits: 7, maxDigits: 15 },
  { cc: 'kg', code: '+996', label: 'Кыргызстан',  minDigits: 7, maxDigits: 15 },
  { cc: 'cn', code: '+86',  label: 'Китай',       minDigits: 7, maxDigits: 15 },
  { cc: 'tm', code: '+993', label: 'Туркменистан',minDigits: 7, maxDigits: 15 },
  { cc: 'af', code: '+93',  label: 'Афганистан',  minDigits: 7, maxDigits: 15 },
  { cc: 'tr', code: '+90',  label: 'Турция',      minDigits: 7, maxDigits: 15 },
  { cc: 'ae', code: '+971', label: 'ОАЭ',         minDigits: 7, maxDigits: 15 },
  { cc: 'sa', code: '+966', label: 'Саудовская Аравия', minDigits: 7, maxDigits: 15 },
  { cc: 'ir', code: '+98',  label: 'Иран',        minDigits: 7, maxDigits: 15 },
  { cc: 'in', code: '+91',  label: 'Индия',       minDigits: 7, maxDigits: 15 },
  { cc: 'pk', code: '+92',  label: 'Пакистан',    minDigits: 7, maxDigits: 15 },
  { cc: 'bd', code: '+880', label: 'Бангладеш',   minDigits: 7, maxDigits: 15 },
  { cc: 'us', code: '+1',   label: 'США',         minDigits: 7, maxDigits: 15 },
  { cc: 'gb', code: '+44',  label: 'Великобритания', minDigits: 7, maxDigits: 15 },
  { cc: 'de', code: '+49',  label: 'Германия',    minDigits: 7, maxDigits: 15 },
  { cc: 'fr', code: '+33',  label: 'Франция',     minDigits: 7, maxDigits: 15 },
  { cc: 'it', code: '+39',  label: 'Италия',      minDigits: 7, maxDigits: 15 },
  { cc: 'es', code: '+34',  label: 'Испания',     minDigits: 7, maxDigits: 15 },
  { cc: 'kr', code: '+82',  label: 'Южная Корея', minDigits: 7, maxDigits: 15 },
  { cc: 'jp', code: '+81',  label: 'Япония',      minDigits: 7, maxDigits: 15 },
  { cc: 'th', code: '+66',  label: 'Таиланд',     minDigits: 7, maxDigits: 15 },
  { cc: 'vn', code: '+84',  label: 'Вьетнам',     minDigits: 7, maxDigits: 15 },
  { cc: 'my', code: '+60',  label: 'Малайзия',    minDigits: 7, maxDigits: 15 },
  { cc: 'id', code: '+62',  label: 'Индонезия',   minDigits: 7, maxDigits: 15 },
  { cc: 'mn', code: '+976', label: 'Монголия',    minDigits: 7, maxDigits: 15 },
  { cc: 'az', code: '+994', label: 'Азербайджан', minDigits: 7, maxDigits: 15 },
  { cc: 'am', code: '+374', label: 'Армения',     minDigits: 7, maxDigits: 15 },
  { cc: 'ge', code: '+995', label: 'Грузия',      minDigits: 7, maxDigits: 15 },
  { cc: 'by', code: '+375', label: 'Беларусь',    minDigits: 7, maxDigits: 15 },
  { cc: 'ua', code: '+380', label: 'Украина',     minDigits: 7, maxDigits: 15 },
  { cc: 'eg', code: '+20',  label: 'Египет',      minDigits: 7, maxDigits: 15 },
];

const flagUrl = (cc: string, size: 20 | 40 | 80 = 40) =>
  `https://flagcdn.com/w${size}/${cc}.png`;

const findCountryByPhone = (phone: string): { idx: number; rest: string } => {
  if (!phone) return { idx: 0, rest: '' };
  const normalized = phone.startsWith('+') ? phone : `+${phone}`;
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
  value: string;
  onChange: (fullPhone: string) => void;
  error?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

export default function PhoneInput({ value, onChange, error, placeholder, disabled }: Props) {
  const { t } = useT();
  const [countryIdx, setCountryIdx] = useState(() => findCountryByPhone(value || '+992').idx);
  const [local, setLocal] = useState(() => findCountryByPhone(value || '+992').rest);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Синхронизация с внешним value через ref, чтобы не зацикливаться.
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
  // подобран ровно как у обычного <input> в .af-field / .form-group.
  const wrapStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    flexWrap: 'nowrap',
    width: '100%',
    boxSizing: 'border-box',
    border: `1px solid ${error ? 'var(--danger, #dc2626)' : 'var(--border, #e5e7eb)'}`,
    borderRadius: 8,
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
    padding: '10px 12px',
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
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
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
        {/* inline color/font — родительский контейнер мог быть тёмная тема
            (color:white), из-за этого var(--text) терялся. Жёсткая фиксация. */}
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
        disabled={disabled}
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
              placeholder={t('common.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="phone-dropdown-list">
            {filtered.length === 0 ? (
              <div className="phone-dropdown-empty">{t('common.empty')}</div>
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
