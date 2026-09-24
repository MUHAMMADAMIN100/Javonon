import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

/**
 * Возвращает массив элементов пагинации в стиле Google: номера страниц
 * с эллипсисами вокруг текущей. Пример при 50 страницах и текущей 6:
 * `[1, '…', 4, 5, 6, 7, 8, '…', 50]`.
 */
export function buildPageRange(current: number, total: number, siblings = 2): (number | '…')[] {
  if (total <= 3 + siblings * 2) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out: (number | '…')[] = [1];
  const start = Math.max(2, current - siblings);
  const end = Math.min(total - 1, current + siblings);
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
  /** Сколько соседних номеров вокруг текущей — не больше (узкое окно на телефоне — 1). */
  siblings?: number;
};

/**
 * Универсальная пагинация в стиле Google с эллипсисами.
 * Не показывается, если total <= pageSize (всё умещается на одной странице).
 * Использует CSS-классы `.pagination`, `.pg-btn`, `.pg-num` и т.д.
 *
 * Ряд кнопок всегда в одну строку: если номера не влезают (телефон 320 px,
 * окно «подробнее»), соседей вокруг текущей становится меньше — по одному,
 * пока ряд не поместится. На телефоне у стрелок нет слов (прячет CSS).
 */
export default function Pagination({ page, total, pageSize, onChange, siblings = 2 }: Props) {
  const { t } = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const visible = total > pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Ширина места под пагинацию: сменилась (поворот телефона, окно) —
  // подбираем число соседей заново.
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setBoxWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);
  // Пока грузятся шрифты, цифры другой ширины (а без CSS-страховки значок
  // стрелки был бы словом «chevron_left») — после загрузки подбираем заново.
  const [fontsLoaded, setFontsLoaded] = useState(0);
  useEffect(() => {
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) setFontsLoaded((n) => n + 1); });
    return () => { alive = false; };
  }, []);

  // При любой смене входных данных начинаем с `siblings`, а эффект ниже
  // убирает по одному соседу, пока ряд шире своего места. Всё до отрисовки —
  // промежуточные варианты на экране не мелькают.
  const fitKey = `${siblings}|${page}|${totalPages}|${boxWidth}|${fontsLoaded}`;
  const [fitState, setFitState] = useState({ key: fitKey, siblings });
  const fit = fitState.key === fitKey ? fitState.siblings : siblings;
  useLayoutEffect(() => {
    const el = controlsRef.current;
    if (el && fit > 0 && el.scrollWidth > el.clientWidth + 1) setFitState({ key: fitKey, siblings: fit - 1 });
  });

  if (!visible) return null;
  const pageRange = buildPageRange(page, totalPages, fit);
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div className="pagination" ref={rootRef}>
      <div className="pagination-info">
        {t('pagination.page')} {rangeStart}–{rangeEnd} {t('pagination.of')} {total}
      </div>
      <div className="pagination-controls" ref={controlsRef}>
        <button
          type="button"
          className="pg-btn pg-arrow pg-prev"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1}
          aria-label={t('pagination.prev')}
        >
          <Icon name="chevron_left" size={18} />
          <span className="pg-arrow-label">{t('pagination.prev')}</span>
        </button>
        {pageRange.map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="pg-gap">…</span>
          ) : (
            <button
              type="button"
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
          type="button"
          className="pg-btn pg-arrow pg-next"
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          aria-label={t('pagination.next')}
        >
          <span className="pg-arrow-label">{t('pagination.next')}</span>
          <Icon name="chevron_right" size={18} />
        </button>
      </div>
    </div>
  );
}
