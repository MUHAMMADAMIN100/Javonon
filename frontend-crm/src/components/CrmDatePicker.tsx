import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const { date: selectedDate, time } = useMemo(() => parseValue(value, showTime), [value, showTime]);
  const [timeValue, setTimeValue] = useState<string>(time || '');

  useEffect(() => {
    setTimeValue(time || '');
  }, [time]);

  const minDate = useMemo(() => parseDateOnly(min), [min]);
  const maxDate = useMemo(() => parseDateOnly(max), [max]);

  const formattedLabel = useMemo(() => {
    if (!selectedDate) return '';
    if (showTime && timeValue) {
      return format(selectedDate, 'd MMMM yyyy', { locale: ru }) + ' ' + timeValue;
    }
    return format(selectedDate, 'd MMMM yyyy', { locale: ru });
  }, [selectedDate, showTime, timeValue]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        wrapperRef.current && !wrapperRef.current.contains(target) &&
        popoverRef.current && !popoverRef.current.contains(target)
      ) {
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

  return (
    <div
      ref={wrapperRef}
      className={'crm-datepicker-wrapper ' + (className || '')}
      style={{ position: 'relative', ...(style || {}) }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
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

      {open && (
        <div ref={popoverRef} className="crm-datepicker-popover" role="dialog">
          <DayPicker
            mode="single"
            selected={selectedDate}
            onSelect={handleSelect}
            locale={ru}
            weekStartsOn={1}
            showOutsideDays
            startMonth={minDate}
            endMonth={maxDate}
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
        </div>
      )}
    </div>
  );
}
