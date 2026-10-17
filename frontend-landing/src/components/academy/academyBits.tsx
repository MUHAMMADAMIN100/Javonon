import { tjFields } from '../../tjDate';
import type { WeeklySlot } from '../../studentApi';

/**
 * Общие мелочи вкладки «Академия» в кабинете: цвет итога недели, краткие
 * дни недели, «по каким дням», короткие даты. Цвета итога — как в журнале
 * CRM: от 90 зелёный, 80–89 жёлтый, ниже — красный, без экзамена — серый.
 */

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

export function totalTone(total: number | null | undefined, final = true): 'good' | 'mid' | 'low' | 'draft' {
  if (total === null || total === undefined || !final) return 'draft';
  if (total >= 90) return 'good';
  if (total >= 80) return 'mid';
  return 'low';
}

export function TotalPill({ total, final = true, title }: { total: number | null | undefined; final?: boolean; title?: string }) {
  if (total === null || total === undefined) return <span className="acad-pill is-empty">—</span>;
  return (
    <span className={`acad-pill is-${totalTone(total, final)}`} title={title}>
      {total}
    </span>
  );
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
