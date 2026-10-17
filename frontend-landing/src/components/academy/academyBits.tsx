import Icon from '../../Icon';
import { tjFields } from '../../tjDate';
import type { Attendance, WeeklySlot } from '../../studentApi';

/**
 * Общие мелочи вкладки «Академия» в кабинете: цвет итога, уровень,
 * давомот, краткие дни недели, «по каким дням», короткие даты. Цвета
 * итога — как в журнале CRM: от 90 зелёный, 80–89 жёлтый, ниже — красный.
 */

/** Ҳозир / Ғоиб / Дер омад — как в журнале CRM. */
export const ATTENDANCE_TJ: Record<Attendance, string> = {
  PRESENT: 'Ҳозир',
  ABSENT: 'Ғоиб',
  LATE: 'Дер омад',
};

const MONTHS_TJ = ['Январ', 'Феврал', 'Март', 'Апрел', 'Май', 'Июн', 'Июл', 'Август', 'Сентябр', 'Октябр', 'Ноябр', 'Декабр'];

/** «Октябр 2026». */
export function monthTitle(year: number, month: number): string {
  return `${MONTHS_TJ[month - 1] ?? ''} ${year}`;
}

/** Процент простым текстом: «85%» или «—». */
export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v}%`;
}

/** Уровень плашкой; без уровня — «Бе сатҳ». */
export function LevelPill({ name }: { name: string | null | undefined }) {
  return name ? (
    <span className="acad-cab-level">
      <Icon name="stairs" size={15} />
      {name}
    </span>
  ) : (
    <span className="acad-cab-level is-empty">Бе сатҳ</span>
  );
}

const WEEKDAY_SHORT = ['Дш', 'Сш', 'Чш', 'Пш', 'Ҷм', 'Шн', 'Яш'];

/** 1 = душанбе … 7 = якшанбе. */
export function weekdayShort(weekday: number): string {
  return WEEKDAY_SHORT[(weekday - 1 + 7) % 7] ?? '';
}

/** «Дш, Чш, Ҷм · 14:00–16:00»; разное время — через точку с запятой. */
export function patternText(pattern: WeeklySlot[] | undefined): string {
  if (!pattern?.length) return '';
  const byTime = new Map<string, number[]>();
  for (const p of pattern) {
    const key = `${p.from}–${p.to}`;
    const list = byTime.get(key);
    if (list) list.push(p.weekday);
    else byTime.set(key, [p.weekday]);
  }
  return [...byTime.entries()].map(([time, days]) => `${days.map(weekdayShort).join(', ')} · ${time}`).join('; ');
}

/** «05.11» по Душанбе. */
export function dayMonth(input: string | Date): string {
  const f = tjFields(input);
  return `${String(f.day).padStart(2, '0')}.${String(f.month).padStart(2, '0')}`;
}

/** Ключ 'YYYY-MM-DD' → «05.11». */
export function keyDayMonth(key: string): string {
  const [, m, d] = key.split('-');
  return `${d}.${m}`;
}

/** Календарный день (UTC-полночь, срок ДЗ) → «20.10.2026». */
export function calendarDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export function totalTone(total: number | null | undefined): 'good' | 'mid' | 'low' | 'empty' {
  if (total === null || total === undefined) return 'empty';
  if (total >= 90) return 'good';
  if (total >= 80) return 'mid';
  return 'low';
}

/** Итог в процентах цветной плашкой. */
export function TotalPill({ total, title }: { total: number | null | undefined; title?: string }) {
  if (total === null || total === undefined) return <span className="acad-pill is-empty">—</span>;
  return (
    <span className={`acad-pill is-${totalTone(total)}`} title={title}>
      {total}%
    </span>
  );
}

/** Сдвиг дня 'YYYY-MM-DD' на N дней. */
export function addDaysKey(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** День недели дня 'YYYY-MM-DD': 1 = душанбе … 7 = якшанбе. */
export function weekdayOfKey(day: string): number {
  return ((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1;
}

export function fileSize(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export function materialIcon(kind: 'FILE' | 'LINK', mime?: string | null, title?: string): string {
  if (kind === 'LINK') return 'link';
  const m = (mime || '').toLowerCase();
  const name = (title || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'movie';
  if (m.startsWith('audio/')) return 'headphones';
  if (m.includes('pdf') || name.endsWith('.pdf')) return 'picture_as_pdf';
  if (/\.(zip|rar|7z)$/.test(name)) return 'folder_zip';
  return 'description';
}
