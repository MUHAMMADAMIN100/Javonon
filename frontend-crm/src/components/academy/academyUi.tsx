import Icon from '../../Icon';
import { useT } from '../../lib/i18n';
import { absFileUrl } from '../../lib/fileUrl';
import { TJ_TZ } from '../../lib/tjTime';
import { FLAGS_FOR_DECISION, type AcademyStatus } from '../../api/academy';
import type { WeeklySlot } from '../../api/studyGroups';

/**
 * Мелкие общие кусочки академии: цвет итога недели, статус ученика,
 * точки флагов, «по каким дням», аватар, короткие даты. Один источник,
 * чтобы журнал, списки и карточки выглядели одинаково.
 */

/** Цвет итога недели — как в журнале с образца: от 90 зелёный, 80–89 жёлтый, ниже — красный. */
export type TotalTone = 'good' | 'mid' | 'low' | 'draft';

export function totalTone(total: number | null | undefined, final = true): TotalTone {
  if (total === null || total === undefined || !final) return 'draft';
  if (total >= 90) return 'good';
  if (total >= 80) return 'mid';
  return 'low';
}

export function TotalBadge({
  total,
  final = true,
  testId,
}: {
  total: number | null | undefined;
  final?: boolean;
  testId?: string;
}) {
  const { t } = useT();
  const tone = totalTone(total, final);
  if (total === null || total === undefined) {
    return <span className="acad-total is-empty" data-testid={testId}>—</span>;
  }
  return (
    <span
      className={`acad-total is-${tone}`}
      data-testid={testId}
      title={final ? undefined : t('academy.total.draftHint')}
    >
      {total}
    </span>
  );
}

const STATUS_CLASS: Record<AcademyStatus, string> = {
  ACTIVE: 'acad-status is-active',
  PENDING: 'acad-status is-pending',
  EXPELLED: 'acad-status is-expelled',
  NO_GROUP: 'acad-status is-nogroup',
};

export function AcademyStatusBadge({ status, testId }: { status: AcademyStatus; testId?: string }) {
  const { t } = useT();
  return (
    <span className={STATUS_CLASS[status]} data-testid={testId}>
      {status === 'PENDING' && <Icon name="flag" size={13} />}
      {t(`academy.status.${status}`)}
    </span>
  );
}

/** Красные флаги: три кружка, закрашенные по числу флагов (и «+N» сверх трёх). */
export function FlagDots({ count, testId }: { count: number; testId?: string }) {
  const { t } = useT();
  const dots = Array.from({ length: FLAGS_FOR_DECISION }, (_, i) => i < count);
  return (
    <span
      className={`acad-flags${count >= FLAGS_FOR_DECISION ? ' is-full' : ''}`}
      title={`${t('academy.flags.title')}: ${count}`}
      data-testid={testId}
      data-count={count}
    >
      {dots.map((on, i) => (
        <span key={i} className={`acad-flag-dot${on ? ' is-on' : ''}`} />
      ))}
      {count > FLAGS_FOR_DECISION && <span className="acad-flag-more">+{count - FLAGS_FOR_DECISION}</span>}
    </span>
  );
}

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Ключ словаря дня недели: 1 = Пн … 7 = Вс. */
export function weekdayKey(weekday: number): string {
  return WEEKDAY_KEYS[(weekday - 1 + 7) % 7];
}

/**
 * «Пн, Ср, Пт · 14:00–16:00»; разное время — через точку с запятой:
 * «Пн, Ср · 14:00–16:00; Сб · 10:00–12:00».
 */
export function usePatternText() {
  const { t } = useT();
  return (pattern: WeeklySlot[] | undefined | null): string => {
    if (!pattern?.length) return '';
    const byTime = new Map<string, number[]>();
    for (const p of pattern) {
      const key = `${p.from}–${p.to}`;
      const list = byTime.get(key);
      if (list) list.push(p.weekday);
      else byTime.set(key, [p.weekday]);
    }
    return [...byTime.entries()]
      .map(([time, days]) => `${days.map((d) => t(`weekday.short.${weekdayKey(d)}`)).join(', ')} · ${time}`)
      .join('; ');
  };
}

/** День недели момента по Душанбе: 1 = Пн … 7 = Вс. */
export function tjWeekdayOf(iso: string | Date): number {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TJ_TZ, weekday: 'short' }).format(d);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name) + 1;
}

/** «05.11» по Душанбе. */
export function shortDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat('ru-RU', { timeZone: TJ_TZ, day: '2-digit', month: '2-digit' }).format(d);
}

/** Календарный ключ 'YYYY-MM-DD' → «05.11». */
export function shortKey(key: string): string {
  const [, m, d] = key.split('-');
  return `${d}.${m}`;
}

/** «05.11 – 11.11» для недели по ключам. */
export function weekRange(from: string, to: string): string {
  return `${shortKey(from)} – ${shortKey(to)}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
}

export function Avatar({ name, photoUrl, size = 36 }: { name: string; photoUrl?: string | null; size?: number }) {
  return photoUrl ? (
    <img className="acad-avatar" src={absFileUrl(photoUrl)} alt="" style={{ width: size, height: size }} />
  ) : (
    <span
      className="acad-avatar is-initials"
      data-initials={initials(name)}
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    />
  );
}

/** Размер файла: «1,2 МБ», «340 КБ». */
export function fileSize(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Иконка материала по типу файла. */
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
