import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import Icon from '../Icon';
import Loading from './Loading';
import SearchField from './SearchField';
import { SortSelect, SortTh, useTableSort, type SortColumn } from './TableSort';
import { matchesSearch } from '../lib/listSearch';
import { useT } from '../lib/i18n';

/**
 * Окно «подробнее» по клику на карточку-цифру (дашборд, «Текущий месяц» в
 * профиле сотрудника). Одно на все карточки, чтобы окна были одинаковыми:
 * сверху итоги и разбивки, ниже записи, из которых сложилась цифра, — с
 * поиском и сортировкой; клик по строке открывает карточку записи.
 *
 * Оформление — то же, что у окна KPI (классы kpi-details-*).
 */

export type DetailsColumn<T> = SortColumn<T> & {
  /** Как нарисовать ячейку; по умолчанию — значение сортировки. */
  render?: (row: T) => ReactNode;
  align?: 'right';
};

export type DetailsGroup = { title: string; items: { label: string; value: string }[] };
export type DetailsTile = { label: string; value: string; sub?: string; accent?: boolean };

/** Разбивка «по чему-то»: считает строки (или сумму) по ключу, крупные первыми. */
export function groupBy<T>(
  rows: T[],
  keyOf: (row: T) => string,
  opts: { sum?: (row: T) => number; format?: (n: number) => string; limit?: number; more?: (n: number) => string } = {},
): { label: string; value: string }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    map.set(k, (map.get(k) ?? 0) + (opts.sum ? opts.sum(r) : 1));
  }
  const all = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const limit = opts.limit ?? 8;
  const fmt = opts.format ?? ((n: number) => String(n));
  const shown = all.slice(0, limit).map(([label, n]) => ({ label, value: fmt(n) }));
  if (all.length > limit && opts.more) shown.push({ label: opts.more(all.length - limit), value: '' });
  return shown;
}

export default function DetailsModal<T>({
  title,
  subtitle,
  tiles,
  groups,
  note,
  rows,
  loading,
  error,
  columns,
  rowKey,
  rowHref,
  searchOf,
  phonesOf,
  listHref,
  emptyText,
  onClose,
  testId,
}: {
  title: string;
  subtitle?: string;
  tiles?: DetailsTile[];
  groups?: DetailsGroup[];
  note?: ReactNode;
  rows: T[] | undefined;
  loading: boolean;
  error?: boolean;
  columns: DetailsColumn<T>[];
  rowKey: (row: T) => string;
  /** Куда ведёт клик по строке. */
  rowHref?: (row: T) => string | null;
  /** Что ищет поиск (текст) и какие номера — по цифрам. */
  searchOf?: (row: T) => (string | null | undefined)[];
  phonesOf?: (row: T) => (string | null | undefined)[];
  /** «Открыть в списке» — раздел с теми же фильтрами и периодом. */
  listHref?: string;
  emptyText: string;
  onClose: () => void;
  testId?: string;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = (rows ?? []).filter((r) =>
    searchOf ? matchesSearch(search, searchOf(r), phonesOf ? phonesOf(r) : []) : true,
  );
  // Окно — не страница: сортировку в ссылку не пишем.
  const sort = useTableSort(shown, columns, { persist: false });

  return (
    <motion.div
      className="dialog-backdrop kpi-details details-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // mousedown, а не click: выделил текст и отпустил мышь за краем окна —
      // это не «клик мимо».
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        className="dialog-card kpi-details-card details-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        initial={{ opacity: 0, scale: 0.97, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 16 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="kpi-details-head">
          <div style={{ minWidth: 0 }}>
            <div className="kpi-details-name">{title}</div>
            {subtitle && <div className="kpi-details-sub">{subtitle}</div>}
          </div>
          <button type="button" className="lead-modal-close" aria-label={t('common.close')} data-testid="details-close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>

        {loading && <Loading />}
        {error && <div className="error-banner">{t('toast.error')}</div>}

        {!loading && !error && (
          <>
            {tiles && tiles.length > 0 && (
              <div className="kpi-details-tiles">
                {tiles.map((tile) => (
                  <div key={tile.label} className={`kpi-details-tile${tile.accent ? ' is-accent' : ''}`}>
                    <div className="kpi-details-tile-label">{tile.label}</div>
                    <div className="kpi-details-tile-value" data-testid="details-tile-value">{tile.value}</div>
                    {tile.sub && <div className="kpi-details-tile-sub">{tile.sub}</div>}
                  </div>
                ))}
              </div>
            )}

            {groups?.filter((g) => g.items.length > 0).map((g) => (
              <div key={g.title} className="details-group">
                <div className="details-group-title">{g.title}</div>
                <div className="kpi-details-chips">
                  {g.items.map((it) => (
                    <span key={it.label} className="badge badge-gray">
                      {it.label}{it.value && <> · <b>{it.value}</b></>}
                    </span>
                  ))}
                </div>
              </div>
            ))}

            {note && <div className="kpi-details-note">{note}</div>}

            {(rows?.length ?? 0) === 0 ? (
              <div className="empty" style={{ padding: '24px 0' }}>{emptyText}</div>
            ) : (
              <>
                {searchOf && (
                  <div className="filters" style={{ marginBottom: 10 }}>
                    <SearchField
                      value={search}
                      onChange={setSearch}
                      onClear={() => setSearch('')}
                      placeholder={t('details.search')}
                      testId="details-search"
                    />
                  </div>
                )}
                {shown.length === 0 ? (
                  <div className="empty" style={{ padding: '24px 0' }}>{t('common.empty')}</div>
                ) : (
                  <div className="kpi-details-body">
                    <SortSelect sort={sort} />
                    <table className="table" style={{ width: '100%' }} data-testid="details-table">
                      <thead>
                        <tr>
                          {columns.map((c) => (
                            <SortTh key={c.key} sort={sort} col={c.key} style={c.align ? { textAlign: c.align } : undefined} />
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sort.sorted.map((r) => {
                          const href = rowHref?.(r) ?? null;
                          return (
                            <tr
                              key={rowKey(r)}
                              className={href ? 'details-row-link' : undefined}
                              onClick={href ? () => navigate(href) : undefined}
                            >
                              {columns.map((c, i) => {
                                const v = c.render ? c.render(r) : c.value(r);
                                return (
                                  <td
                                    key={c.key}
                                    data-label={i === 0 ? undefined : c.label}
                                    style={c.align ? { textAlign: c.align } : undefined}
                                  >
                                    {v === null || v === undefined || v === '' ? (
                                      <span style={{ color: 'var(--text-light)' }}>—</span>
                                    ) : v instanceof Date ? (
                                      v.toLocaleDateString('ru-RU')
                                    ) : (
                                      (v as ReactNode)
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {listHref && (
              <div className="details-footer">
                <button type="button" className="btn btn-secondary btn-sm" data-testid="details-open-list" onClick={() => navigate(listHref)}>
                  {t('details.openList')} <Icon name="arrow_forward" size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
