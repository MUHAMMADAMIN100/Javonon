import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';

/**
 * Выпадающий список в оформлении CRM.
 *
 * Зачем: браузер рисует список вариантов сам — серой системной панелью
 * Windows, которая не имеет ничего общего с остальным интерфейсом. Этот
 * компонент рисует список сам: те же рамки, шрифты, скругления и подсветка,
 * что и у прочих полей.
 *
 * КАК УСТРОЕН. Внутри остаётся НАСТОЯЩИЙ <select> — просто невидимый. Он
 * хранит значение, участвует в отправке формы и в проверках, а варианты
 * компонент читает прямо из него. Поэтому:
 *
 *  • вызывающий код не изменился: те же `value`, `onChange(e.target.value)`,
 *    те же <option> внутри (в том числе собранные через .map или чужим
 *    компонентом вроде <DirectionOptions/>) — их видно через DOM;
 *  • ничего не ломается, если у поля свои проверки или своя разметка.
 *
 * Выбор мы «проигрываем» на скрытом select: ставим значение и отправляем
 * событие change, поэтому обработчики страниц срабатывают ровно как раньше.
 */

type Opt = { value: string; label: string; disabled: boolean; group?: string };

/** С какого числа вариантов показывать строку поиска. */
const SEARCH_FROM = 8;
const MAX_POPOVER_HEIGHT = 320;

/**
 * React следит за значением полей через собственный «трекер» и не пошлёт
 * onChange, если присвоить value напрямую. Штатный обход — записать через
 * родной сеттер прототипа, тогда трекер увидит изменение.
 */
function setNativeValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export default function CrmSelect({
  className,
  style,
  children,
  disabled,
  title,
  'data-testid': testId,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { 'data-testid'?: string }) {
  const { t } = useT();
  const nativeRef = useRef<HTMLSelectElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Opt[]>([]);
  const [current, setCurrent] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [coords, setCoords] = useState<React.CSSProperties>({ top: 0, left: 0, width: 200 });

  const isPhone = typeof window !== 'undefined' && window.innerWidth <= 720;

  /**
   * Читаем варианты из скрытого select. Через DOM, а не через React.Children:
   * половина вызовов отдаёт <option> из .map или из отдельного компонента,
   * и в children их не видно.
   */
  const syncFromNative = useCallback(() => {
    const el = nativeRef.current;
    if (!el) return;
    const next: Opt[] = [];
    for (const o of Array.from(el.options)) {
      next.push({
        value: o.value,
        label: o.textContent || o.value,
        disabled: o.disabled,
        group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : undefined,
      });
    }
    setOptions((prev) => {
      const same =
        prev.length === next.length &&
        prev.every((p, i) => p.value === next[i].value && p.label === next[i].label);
      return same ? prev : next;
    });
    setCurrent(el.value);
  }, []);

  useLayoutEffect(() => { syncFromNative(); });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const selected = options.find((o) => o.value === current);
  const showSearch = options.length >= SEARCH_FROM;

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const choose = (opt: Opt) => {
    if (opt.disabled) return;
    const el = nativeRef.current;
    if (el && el.value !== opt.value) setNativeValue(el, opt.value);
    setCurrent(opt.value);
    close();
    triggerRef.current?.focus();
  };

  /** Позиция списка: под полем, а если снизу не влезает — над ним. */
  const computeCoords = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return false;
    const r = trigger.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    if (window.innerWidth <= 720) {
      // На телефоне список выезжает снизу на всю ширину — попасть пальцем
      // в узкий список под полем почти невозможно.
      setCoords({ left: 8, right: 8, bottom: 8, width: 'auto' as any });
      return true;
    }
    const width = Math.max(r.width, 200);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const flipUp = below < Math.min(MAX_POPOVER_HEIGHT, 220) && above > below;
    setCoords(
      flipUp
        ? { bottom: Math.max(8, window.innerHeight - r.top + 4), left, width }
        : { top: r.bottom + 4, left, width },
    );
    return true;
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    if (!computeCoords()) close();
  }, [open, computeCoords, close]);

  useEffect(() => {
    if (!open) return;
    const onMove = () => { if (!computeCoords()) close(); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, computeCoords, close]);

  // Клик мимо закрывает. mousedown, а не click: иначе закрытие происходит
  // уже после того, как страница под списком получила клик.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, visible.findIndex((o) => o.value === current)));
    if (showSearch) setTimeout(() => searchRef.current?.focus(), 30);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Подсвеченная строка всегда в поле зрения при ходьбе стрелками.
  useEffect(() => {
    if (!open) return;
    popoverRef.current
      ?.querySelector<HTMLElement>('.crm-select-option.is-active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); triggerRef.current?.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, visible.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Home') { e.preventDefault(); setActive(0); return; }
    if (e.key === 'End') { e.preventDefault(); setActive(visible.length - 1); return; }
    if (e.key === 'Enter' || (e.key === 'Tab' && visible[active])) {
      e.preventDefault();
      const opt = visible[active];
      if (opt) choose(opt);
      return;
    }
    // Набор букв без строки поиска — прыжок к первому совпадению, как в
    // обычном списке браузера.
    if (!showSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const ch = e.key.toLowerCase();
      const from = visible.findIndex((o, i) => i > active && o.label.toLowerCase().startsWith(ch));
      const idx = from >= 0 ? from : visible.findIndex((o) => o.label.toLowerCase().startsWith(ch));
      if (idx >= 0) setActive(idx);
    }
  };

  const list = open ? createPortal(
    <>
      {isPhone && <div className="crm-select-scrim" onMouseDown={close} />}
      <div
      ref={popoverRef}
      className={`crm-select-popover${isPhone ? ' is-sheet' : ''}`}
      style={coords}
      role="listbox"
      onKeyDown={onKeyDown}
    >
        {showSearch && (
          <div className="crm-select-search">
          <input
            ref={searchRef}
            className="crm-input"
            value={query}
            placeholder={t('common.search')}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          />
        </div>
      )}
      <div className="crm-select-list">
        {visible.length === 0 && <div className="crm-select-empty">{t('common.empty')}</div>}
        {visible.map((o, i) => (
          <button
            key={`${o.value}-${i}`}
            type="button"
            role="option"
            aria-selected={o.value === current}
            disabled={o.disabled}
            className={
              'crm-select-option' +
              (o.value === current ? ' is-selected' : '') +
              (i === active ? ' is-active' : '')
            }
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(o)}
          >
            <span>{o.label}</span>
            {o.value === current && <span className="crm-select-tick">✓</span>}
          </button>
        ))}
        </div>
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <>
      {/* Настоящий select: хранит значение и отдаёт варианты. Скрыт, но
          присутствует — иначе перестали бы работать отправка формы и
          проверки, завязанные на поле. */}
      <select
        {...rest}
        ref={nativeRef}
        disabled={disabled}
        className="crm-select-native"
        tabIndex={-1}
        aria-hidden="true"
      >
        {children}
      </select>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        data-testid={testId}
        className={`${className || ''} crm-select-trigger${open ? ' is-open' : ''}`.trim()}
        style={style}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className="crm-select-value">{selected ? selected.label : ''}</span>
      </button>
      {list}
    </>
  );
}
