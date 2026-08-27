import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { format, parse, isValid } from 'date-fns';
import { ru } from 'date-fns/locale';

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  showTime?: boolean;
  className?: string;
  style?: React.CSSProperties;
  min?: string;
  max?: string;
};

const POPOVER_HEIGHT = 380;
// Диапазон селектов месяца/года в шапке календаря. Если поле задаёт свои
// min/max (например, дата рождения), они сужают диапазон — показывать годы,
// в которых все дни заведомо запрещены, бессмысленно.
const DROPDOWN_MIN_YEAR = 1900;
const DROPDOWN_YEARS_AHEAD = 5;
// 320px: 7 колонок × 36px + 6 × 2px spacing + 2×12px padding = 300px
// содержимого + запас 20px чтобы цифры не липли к правой границе.
const DEFAULT_POPOVER_WIDTH = 320;

function parseValue(value: string, showTime?: boolean): { date: Date | undefined; time: string } {
  if (!value) return { date: undefined, time: '' };
  const datePart = value.includes('T') ? value.split('T')[0] : value;
  const timePart = value.includes('T') ? (value.split('T')[1] || '').slice(0, 5) : '';
  const parsed = parse(datePart, 'yyyy-MM-dd', new Date());
  if (!isValid(parsed)) return { date: undefined, time: showTime ? timePart : '' };
  return { date: parsed, time: showTime ? timePart : '' };
}

function parseDateOnly(value?: string): Date | undefined {
  if (!value) return undefined;
  const datePart = value.includes('T') ? value.split('T')[0] : value;
  const parsed = parse(datePart, 'yyyy-MM-dd', new Date());
  return isValid(parsed) ? parsed : undefined;
}

export default function CrmDatePicker({
  value,
  onChange,
  placeholder = 'Выберите дату',
  disabled,
  showTime,
  className,
  style,
  min,
  max,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // top — если открываемся вниз, bottom — если вверх: при развороте popover
  // прижат к верху поля независимо от своей реальной высоты.
  const [coords, setCoords] = useState<React.CSSProperties>({
    top: 0,
    left: 0,
    width: DEFAULT_POPOVER_WIDTH,
  });

  const { date: selectedDate, time } = useMemo(() => parseValue(value, showTime), [value, showTime]);
  const [timeValue, setTimeValue] = useState<string>(time || '');

  useEffect(() => {
    setTimeValue(time || '');
  }, [time]);

  const minDate = useMemo(() => parseDateOnly(min), [min]);
  const maxDate = useMemo(() => parseDateOnly(max), [max]);
  const startMonth = useMemo(
    () => minDate ?? new Date(DROPDOWN_MIN_YEAR, 0, 1),
    [minDate],
  );
  const endMonth = useMemo(
    () => maxDate ?? new Date(new Date().getFullYear() + DROPDOWN_YEARS_AHEAD, 11, 1),
    [maxDate],
  );

  const formattedLabel = useMemo(() => {
    if (!selectedDate) return '';
    if (showTime && timeValue) {
      return format(selectedDate, 'd MMMM yyyy', { locale: ru }) + ' ' + timeValue;
    }
    return format(selectedDate, 'd MMMM yyyy', { locale: ru });
  }, [selectedDate, showTime, timeValue]);

  const close = useCallback(() => setOpen(false), []);

  const computeCoords = useCallback((): boolean => {
    const trigger = triggerRef.current;
    if (!trigger) return false;
    const rect = trigger.getBoundingClientRect();

    // If trigger is fully off-screen, signal caller to close.
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    let popoverWidth = DEFAULT_POPOVER_WIDTH;
    let left: number;
    if (window.innerWidth < 340) {
      popoverWidth = window.innerWidth - 16;
      left = 8;
    } else {
      left = Math.min(
        Math.max(8, rect.left),
        window.innerWidth - popoverWidth - 8,
      );
    }

    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const flipUp = spaceBelow < POPOVER_HEIGHT && spaceAbove > spaceBelow;

    setCoords(
      flipUp
        ? { bottom: Math.max(8, window.innerHeight - rect.top + 4), left, width: popoverWidth }
        : { top: rect.bottom + 4, left, width: popoverWidth },
    );
    return true;
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    if (!computeCoords()) close();
  }, [open, computeCoords, close]);

  // Пока календарь открыт, следим за положением триггера покадрово: форма
  // может сдвинуться без scroll/resize (ошибка валидации под соседним
  // полем и т.п.) — popover должен остаться под своим полем.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const trigger = triggerRef.current;
      if (trigger) {
        const r = trigger.getBoundingClientRect();
        const sig = `${r.top}|${r.left}|${r.width}|${r.height}|${window.innerHeight}`;
        if (sig !== last) {
          last = sig;
          if (!computeCoords()) { close(); return; }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, computeCoords, close]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => {
      // Reposition on scroll/resize so the popover stays anchored to the
      // trigger — including when scrolling inside a modal that contains it.
      // Only close if the trigger has moved fully off-screen.
      if (!computeCoords()) close();
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, close, computeCoords]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedTrigger = triggerRef.current && triggerRef.current.contains(target);
      const clickedPopover = popoverRef.current && popoverRef.current.contains(target);
      if (!clickedTrigger && !clickedPopover) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const emitChange = useCallback((d: Date | undefined, t: string) => {
    if (!d) {
      onChange('');
      return;
    }
    const datePart = format(d, 'yyyy-MM-dd');
    if (showTime) {
      const safeTime = /^\d{2}:\d{2}$/.test(t) ? t : '00:00';
      onChange(datePart + 'T' + safeTime);
    } else {
      onChange(datePart);
    }
  }, [onChange, showTime]);

  const handleSelect = (day: Date | undefined) => {
    if (!day) {
      emitChange(undefined, timeValue);
      return;
    }
    emitChange(day, timeValue);
    if (!showTime) close();
  };

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = e.target.value;
    setTimeValue(t);
    if (selectedDate) emitChange(selectedDate, t);
  };

  const handleToday = () => {
    const today = new Date();
    emitChange(today, timeValue || (showTime ? format(today, 'HH:mm') : ''));
    if (!showTime) close();
  };

  const handleClear = () => {
    setTimeValue('');
    onChange('');
    close();
  };

  const isEmpty = !value || !selectedDate;

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      className="crm-datepicker-popover"
      role="dialog"
      style={{
        position: 'fixed',
        zIndex: 9999,
        ...coords,
      }}
    >
      <DayPicker
        mode="single"
        selected={selectedDate}
        onSelect={handleSelect}
        locale={ru}
        weekStartsOn={1}
        showOutsideDays
        captionLayout="dropdown"
        // Открываться на месяце выбранной даты. Без этого DayPicker берёт
        // «сегодня» и прижимает его к границам min/max — у даты рождения
        // календарь всегда открывался на самом позднем допустимом месяце.
        defaultMonth={selectedDate}
        startMonth={startMonth}
        endMonth={endMonth}
        disabled={(minDate || maxDate) ? [
          ...(minDate ? [{ before: minDate }] : []),
          ...(maxDate ? [{ after: maxDate }] : []),
        ] : undefined}
      />
      {showTime && (
        <div className="crm-datepicker-time">
          <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>Время:</span>
          <input
            type="time"
            className="crm-input"
            style={{ padding: '6px 10px', fontSize: 13, width: 'auto' }}
            value={timeValue}
            onChange={handleTimeChange}
          />
        </div>
      )}
      <div className="crm-datepicker-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleToday}
        >
          Сегодня
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleClear}
        >
          Очистить
        </button>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div
      ref={wrapperRef}
      className={'crm-datepicker-wrapper ' + (className || '')}
      style={{ position: 'relative', ...(style || {}) }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        // Открываем по mousedown с preventDefault: клик не уводит фокус из
        // соседнего поля — иначе его blur показывает ошибку валидации,
        // форма сдвигается, и mouseup уже не попадает по кнопке.
        // onClick — для клавиатуры (Enter/Space дают click с detail === 0).
        onMouseDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          setOpen((o) => !o);
        }}
        onClick={(e) => {
          if (disabled || e.detail !== 0) return;
          setOpen((o) => !o);
        }}
        className={'crm-datepicker-trigger' + (isEmpty ? ' empty' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span>{isEmpty ? placeholder : formattedLabel}</span>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0, opacity: 0.7 }}
        >
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
      </button>
      {popover}
    </div>
  );
}
