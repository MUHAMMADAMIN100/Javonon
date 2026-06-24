import Icon from '../Icon';
import { useT } from '../lib/i18n';

/**
 * Возвращает массив элементов пагинации в стиле Google: номера страниц
 * с эллипсисами вокруг текущей. Пример при 50 страницах и текущей 6:
 * `[1, '…', 4, 5, 6, 7, 8, '…', 50]`.
 */
export function buildPageRange(current: number, total: number): (number | '…')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out: (number | '…')[] = [1];
  const start = Math.max(2, current - 2);
  const end = Math.min(total - 1, current + 2);
  if (start > 2) out.push('…');
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push('…');
  out.push(total);
  return out;
}

type Props = {
  /** Текущая страница (1-based) */
  page: number;
  /** Общее количество элементов после фильтрации */
  total: number;
  /** Размер страницы */
  pageSize: number;
  /** Колбек при выборе страницы */
  onChange: (page: number) => void;
};

/**
 * Универсальная пагинация в стиле Google с эллипсисами.
 * Не показывается, если total <= pageSize (всё умещается на одной странице).
 * Использует CSS-классы `.pagination`, `.pg-btn`, `.pg-num` и т.д.
 */
export default function Pagination({ page, total, pageSize, onChange }: Props) {
  const { t } = useT();
  if (total <= pageSize) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageRange = buildPageRange(page, totalPages);
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div className="pagination">
      <div className="pagination-info">
        {t('pagination.page')} {rangeStart}–{rangeEnd} {t('pagination.of')} {total}
      </div>
      <div className="pagination-controls">
        <button
          className="pg-btn pg-arrow"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1}
        >
          <Icon name="chevron_left" size={16} />
          {t('pagination.prev')}
        </button>
        {pageRange.map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="pg-gap">…</span>
          ) : (
            <button
              key={p}
              className={`pg-btn pg-num${p === page ? ' active' : ''}`}
              onClick={() => onChange(p)}
              aria-current={p === page ? 'page' : undefined}
            >
              {p}
            </button>
          ),
        )}
        <button
          className="pg-btn pg-arrow"
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
        >
          {t('pagination.next')}
          <Icon name="chevron_right" size={16} />
        </button>
      </div>
    </div>
  );
}
