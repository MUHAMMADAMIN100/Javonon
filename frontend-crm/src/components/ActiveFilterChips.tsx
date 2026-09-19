import Icon from '../Icon';

/**
 * Плашки активных фильтров, которые пришли ССЫЛКОЙ, а не выбраны в тулбаре.
 *
 * Зачем отдельно от выпадающих списков: с дашборда в список можно попасть с
 * периодом («за этот месяц») и с условиями вроде «без направления». В
 * тулбаре таких полей нет, и человек видел бы усечённый список без единого
 * намёка на причину — «куда делись остальные заявки». Плашка показывает
 * условие и снимается одним нажатием.
 */
export default function ActiveFilterChips({
  chips,
}: {
  chips: Array<{ key: string; label: string; onClear: () => void }>;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="active-filters">
      {chips.map((c) => (
        <span key={c.key} className="active-filter-chip">
          {c.label}
          <button type="button" onClick={c.onClear} aria-label={`${c.label} — ✕`}>
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** `2026-09-01` → `01.09.2026`. Без Date: строка уже календарный день. */
export function fmtDay(v: string) {
  const [y, m, d] = v.split('-');
  return y && m && d ? `${d}.${m}.${y}` : v;
}
