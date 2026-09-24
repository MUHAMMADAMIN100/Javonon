import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import CrmSelect from './CrmSelect';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

/**
 * Сортировка таблиц по клику на заголовок колонки — одна на всю CRM.
 *
 * Клик по заголовку: А→Я, ещё раз — Я→А, третий — исходный порядок (тот,
 * в котором строки пришли: обычно «новые сверху»). Сортируется ВЕСЬ
 * список, а не видимая страница: все списки CRM грузятся целиком и режутся
 * на страницы уже в браузере, поэтому хук ставится ДО .slice() пагинации.
 *
 * Сортировка живёт в ссылке (`?sort=fullName`, `?sort=-fullName` — минус
 * значит Я→А), как фильтры: переживает «назад» из карточки и F5. Таблиц на
 * странице бывает несколько — у каждой своё имя параметра (`param`). Для
 * таблиц во всплывающих окнах ссылка не нужна — `persist: false`.
 *
 * На ширине ≤900px таблицы превращаются в карточки и заголовков не видно —
 * там сортировку выбирают списком <SortSelect> над карточками.
 */

export type SortType = 'text' | 'number' | 'date';
export type SortValue = string | number | Date | null | undefined;

export type SortColumn<T> = {
  key: string;
  /** Подпись для списка сортировки на телефоне — та же, что в заголовке. */
  label: string;
  /** text — по алфавиту, number — по величине, date — по времени. */
  type?: SortType;
  value: (row: T) => SortValue;
};

export type SortDir = 'asc' | 'desc';

export type TableSort<T> = {
  sorted: T[];
  key: string | null;
  dir: SortDir;
  columns: SortColumn<T>[];
  toggle: (key: string) => void;
  set: (key: string | null, dir?: SortDir) => void;
  /** Подпись колонки по ключу — для data-label ячейки (подпись в карточке на телефоне). */
  label: (key: string) => string;
};

// Кириллица, таджикские буквы и латиница — одним алфавитным порядком;
// numeric: «Группа 2» раньше «Группа 10»; base: регистр и ё/е не делят список.
const collator = new Intl.Collator(['ru', 'tg', 'en'], { sensitivity: 'base', numeric: true });

function toComparable(v: SortValue, type: SortType): string | number | null {
  if (v === null || v === undefined) return null;
  if (type === 'text') {
    const s = String(v).trim();
    return s ? s : null;
  }
  if (v instanceof Date) {
    const n = v.getTime();
    return Number.isNaN(n) ? null : n;
  }
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  const s = v.trim();
  if (!s) return null;
  const n = type === 'date' ? Date.parse(s) : Number(s);
  return Number.isNaN(n) ? null : n;
}

function parseParam(raw: string | null): { key: string | null; dir: SortDir } {
  if (!raw) return { key: null, dir: 'asc' };
  return raw.startsWith('-') ? { key: raw.slice(1), dir: 'desc' } : { key: raw, dir: 'asc' };
}

export function useTableSort<T>(
  rows: T[],
  columns: SortColumn<T>[],
  opts: {
    /** Имя параметра в ссылке. По умолчанию `sort`. */
    param?: string;
    /** false — не писать в ссылку (таблицы в окнах). */
    persist?: boolean;
    /** Параметр страницы в ссылке, который надо сбросить при смене сортировки. */
    pageParam?: string;
    /** Вызывается при смене сортировки — сбросить номер страницы, если он в useState. */
    onChange?: () => void;
  } = {},
): TableSort<T> {
  const { param = 'sort', persist = true, pageParam, onChange } = opts;
  const [searchParams, setSearchParams] = useSearchParams();
  const [local, setLocal] = useState<string | null>(null);

  const raw = persist ? searchParams.get(param) : local;
  const parsed = parseParam(raw);
  // Колонку из чужой/старой ссылки, которой в таблице нет, молча игнорируем.
  const column = columns.find((c) => c.key === parsed.key) ?? null;
  const key = column ? column.key : null;
  const dir = parsed.dir;

  const set = useCallback(
    (nextKey: string | null, nextDir: SortDir = 'asc') => {
      const value = nextKey ? (nextDir === 'desc' ? `-${nextKey}` : nextKey) : null;
      if (persist) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (value) next.set(param, value);
            else next.delete(param);
            // Новый порядок смотрят с первой страницы.
            if (pageParam) next.delete(pageParam);
            return next;
          },
          // Сортировка — правка текущего экрана, а не переход: в историю не кладём.
          { replace: true },
        );
      } else {
        setLocal(value);
      }
      onChange?.();
    },
    [persist, param, pageParam, onChange, setSearchParams],
  );

  const toggle = useCallback(
    (k: string) => {
      if (key !== k) set(k, 'asc');
      else if (dir === 'asc') set(k, 'desc');
      else set(null);
    },
    [key, dir, set],
  );

  const sorted = useMemo(() => sortRows(rows, column, dir), [rows, column, dir]);

  /** Подпись колонки по ключу — для data-label ячейки (подпись в карточке на телефоне). */
  const label = (k: string) => columns.find((c) => c.key === k)?.label ?? '';
  return { sorted, key, dir, columns, toggle, set, label };
}

/**
 * Ранги значений списка (статус, страна…) по их подписи — тем же сравнением,
 * что у таблицы. Для серверной сортировки: сервер не знает подписей на языке
 * интерфейса, поэтому получает готовый порядок «значение:ранг». Одинаковые
 * подписи — одинаковый ранг (как равные значения в sortRows).
 */
export function labelRanks(values: readonly string[], label: (v: string) => string): string {
  const sorted = [...values].sort((a, b) => collator.compare(label(a), label(b)));
  let rank = 0;
  return sorted
    .map((v, i) => {
      if (i > 0 && collator.compare(label(sorted[i - 1]), label(v)) !== 0) rank = i;
      return `${v}:${rank}`;
    })
    .join(',');
}

/**
 * Сама сортировка — отдельно от хука, чтобы тем же порядком можно было
 * разложить второй набор строк без своих заголовков (продажи в другой
 * валюте в окне KPI).
 */
export function sortRows<T>(rows: T[], column: SortColumn<T> | null | undefined, dir: SortDir): T[] {
  if (!column) return rows;
  const type = column.type ?? 'text';
  const decorated = rows.map((row, i) => ({ row, i, v: toComparable(column.value(row), type) }));
  decorated.sort((a, b) => {
    // Пустые значения — всегда в конце, в какую сторону ни сортируй:
    // «—» наверху списка Я→А никому не нужны.
    if (a.v === null && b.v === null) return a.i - b.i;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    const c =
      typeof a.v === 'number' && typeof b.v === 'number'
        ? a.v - b.v
        : collator.compare(String(a.v), String(b.v));
    // При равенстве — исходный порядок (устойчивая сортировка).
    return c === 0 ? a.i - b.i : dir === 'asc' ? c : -c;
  });
  return decorated.map((d) => d.row);
}

/**
 * Заголовок колонки с сортировкой. Подпись — children, а если их нет, то
 * label колонки. Колонки без сортировки (кнопки действий) остаются обычным <th>.
 */
export function SortTh<T>({
  sort,
  col,
  children,
  style,
  className,
  before,
  wrapClassName,
}: {
  sort: TableSort<T>;
  col: string;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
  /** Что стоит в заголовке ПЕРЕД подписью (галочка «вся страница»): в кнопку её не вложить. */
  before?: ReactNode;
  wrapClassName?: string;
}) {
  const { t } = useT();
  const column = sort.columns.find((c) => c.key === col);
  const active = sort.key === col;
  const button = (
    <button
      type="button"
      className={`th-sort${active ? ' is-active' : ''}`}
      onClick={() => sort.toggle(col)}
      title={t('sort.hint')}
      data-testid={`sort-${col}`}
      data-sort-type={column?.type ?? 'text'}
    >
      <span>{children ?? column?.label}</span>
      <Icon
        name={active ? (sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'swap_vert'}
        size={14}
        className="th-sort-icon"
      />
    </button>
  );
  return (
    <th
      style={style}
      className={className}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {before ? (
        <div className={wrapClassName}>
          {before}
          {button}
        </div>
      ) : (
        button
      )}
    </th>
  );
}

/** Подписи направлений: для текста — алфавит, для чисел и дат — своими словами. */
function dirLabel(t: (k: string) => string, type: SortType, dir: SortDir) {
  if (type === 'number') return t(dir === 'asc' ? 'sort.num.asc' : 'sort.num.desc');
  if (type === 'date') return t(dir === 'asc' ? 'sort.date.asc' : 'sort.date.desc');
  return t(dir === 'asc' ? 'sort.text.asc' : 'sort.text.desc');
}

/**
 * Сортировка для телефона: заголовки таблицы там скрыты (строки становятся
 * карточками), поэтому тот же выбор — списком. На широком экране не видна.
 */
export function SortSelect<T>({ sort }: { sort: TableSort<T> }) {
  const { t } = useT();
  const value = sort.key ? (sort.dir === 'desc' ? `-${sort.key}` : sort.key) : '';
  return (
    <div className="sort-mobile">
      <Icon name="swap_vert" size={18} className="sort-mobile-icon" />
      <CrmSelect
        className="crm-select"
        aria-label={t('sort.label')}
        data-testid="sort-mobile"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) sort.set(null);
          else if (v.startsWith('-')) sort.set(v.slice(1), 'desc');
          else sort.set(v, 'asc');
        }}
      >
        <option value="">{t('sort.default')}</option>
        {sort.columns.flatMap((c) => [
          <option key={c.key} value={c.key}>
            {`${c.label}: ${dirLabel(t, c.type ?? 'text', 'asc')}`}
          </option>,
          <option key={`-${c.key}`} value={`-${c.key}`}>
            {`${c.label}: ${dirLabel(t, c.type ?? 'text', 'desc')}`}
          </option>,
        ])}
      </CrmSelect>
    </div>
  );
}
