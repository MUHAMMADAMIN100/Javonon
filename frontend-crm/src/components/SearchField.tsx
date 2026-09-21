import { useEffect, useState } from 'react';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

/**
 * Поле поиска в строке фильтров списка — одно на все списки, где поиск
 * стоит В строке фильтров (лиды, сделки): лупа слева, крестик справа, Esc
 * очищает. Ширину забирает всё свободное место справа (.list-search).
 */
export default function SearchField({
  value,
  onChange,
  onClear,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Очистить сразу — и поле, и ссылку (без ожидания дебаунса). */
  onClear: () => void;
  placeholder: string;
  testId?: string;
}) {
  const { t } = useT();
  return (
    <div className="list-search">
      <Icon name="search" size={18} className="list-search-icon" />
      <input
        type="search"
        className="crm-input"
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        value={value}
        maxLength={200}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Esc в поле — очистить поиск, а не ждать, пока браузер сотрёт
          // текст без события (у type=search так бывает).
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onClear();
          }
        }}
        autoComplete="off"
      />
      {value && (
        <button
          type="button"
          className="list-search-clear"
          aria-label={t('leads.search.clear')}
          title={t('leads.search.clear')}
          data-testid={testId ? `${testId}-clear` : undefined}
          onClick={onClear}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * Поиск, живущий в ссылке. Буквы в поле появляются сразу, в ссылку (и в
 * запрос) уезжает значение, простоявшее 300 мс — иначе каждая буква была бы
 * запросом. Возвращает текущий текст поля, сеттер и «очистить сейчас».
 */
export function useUrlSearch(urlValue: string, setUrlValue: (v: string) => void) {
  const [input, setInput] = useState(urlValue);
  // Ссылка → поле: «назад», «Сбросить», крестик у плашки.
  useEffect(() => {
    setInput(urlValue);
  }, [urlValue]);
  // Поле → ссылка, с задержкой.
  useEffect(() => {
    if (input === urlValue) return;
    const timer = setTimeout(() => setUrlValue(input), 300);
    return () => clearTimeout(timer);
  }, [input, urlValue, setUrlValue]);
  const clear = () => {
    setInput('');
    setUrlValue('');
  };
  return { input, setInput, clear };
}
