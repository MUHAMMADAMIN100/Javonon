// Общие части раздела «Финансы» (вынесены из pages/Finance.tsx 10.11.2026).
import { NonTjsTotals } from '../../api/finance';
import { useSearchParams } from 'react-router-dom';
import Icon from '../../Icon';
import { fmtDateText, TJ_TZ, tjToday } from '../../lib/tjTime';
import { useT } from '../../lib/i18n';

export function fmtMoney(n: number, currency = 'TJS'): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

export function fmtDate(iso: string): string {
  // «YYYY-MM-DD» — календарный день как есть; момент времени — по Душанбе,
  // а не по часам браузера (иначе операция в 01:00 по Душанбе у бухгалтера
  // в другом поясе попадала бы во вчера).
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return fmtDateText(dayOnly ? `${iso}T00:00:00Z` : iso, {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: dayOnly ? 'UTC' : TJ_TZ,
  });
}

/**
 * Компактная строка вида «В ПЕРИОДЕ ТАКЖЕ · USD +5 000 / −200 · EUR +200».
 * Показываем под KPI/над пирогами когда backend вернул `nonTjsTotals` с
 * ненулевыми суммами. Мотивация: backend считает все агрегаты только в
 * TJS, но фиксирует валютные транзакции периода отдельно — бухгалтер
 * должен видеть, что USD/EUR активность была, иначе дашборд молча
 * «прячет» реальную выручку (см. commit-audit по currency mixing).
 *
 * `kind` фильтрует, что показывать: для income-пирогов не нужно тащить
 * валютные расходы, для expense-пирога — наоборот. Без `kind` (например
 * под netProfit-KPI) показываем и то и другое, чтобы дать полную картину.
 */
export function NonTjsStrip({
  totals,
  color = 'var(--text-soft)',
  kind,
}: {
  totals?: NonTjsTotals | null;
  color?: string;
  kind?: 'income' | 'expense';
}) {
  const { t } = useT();
  if (!totals) return null;
  const entries = Object.entries(totals);
  if (entries.length === 0) return null;

  const parts: string[] = [];
  for (const [cur, bucket] of entries) {
    const bits: string[] = [];
    if ((!kind || kind === 'income') && bucket.income > 0) {
      bits.push(`+${fmtMoney(bucket.income, cur)}`);
    }
    if ((!kind || kind === 'expense') && bucket.expense > 0) {
      bits.push(`−${fmtMoney(bucket.expense, cur)}`);
    }
    if (bits.length > 0) parts.push(`${cur} ${bits.join(' / ')}`);
  }
  if (parts.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 8,
        marginBottom: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.08em',
        color,
        textTransform: 'uppercase',
      }}
      title={t('finance.nonTjs.hint')}
    >
      {t('finance.nonTjs.alsoInPeriod')} · {parts.join(' · ')}
    </div>
  );
}

/**
 * Маленький бэйдж «BASE · TJS» рядом с eyebrow пирога/ранжирования.
 *
 * Мотивация: агрегаты дашборда считаются только в одной валюте
 * (`REPORTING_CURRENCY` на backend), но раньше UI никак не сообщал, в чём
 * именно считает — и пользователь смотрел на пустой пирог или неполный
 * «ТОП» без понимания, что USD/EUR-транзакции просто отфильтрованы (см.
 * audit HIGH — «pie charts silently hide currency-based bias»). Бэйдж
 * ставим справа от eyebrow, tooltip раскрывает причину.
 */
export function CurrencyBadge({ currency }: { currency: string }) {
  const { t } = useT();
  const baseLabel = t('finance.badge.base');
  return (
    <span
      title={t('finance.badge.hint').replace('{currency}', currency)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 6px',
        border: '1px solid var(--border)',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.1em',
        color: 'var(--text-soft)',
        textTransform: 'uppercase',
        lineHeight: 1.2,
      }}
    >
      {baseLabel} · {currency}
    </span>
  );
}

/** «01.09.2026 — 30.09.2026» — период под выручкой. */
export function periodLabel(range: { from?: string; to?: string }, t: (k: string) => string) {
  const d = (iso: string) => fmtDateText(`${iso.slice(0, 10)}T00:00:00Z`, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  if (range.from && range.to) return `${d(range.from)} — ${d(range.to)}`;
  if (range.from) return `${t('finance.kpi.since')} ${d(range.from)}`;
  if (range.to) return `${t('finance.kpi.until')} ${d(range.to)}`;
  return t('finance.kpi.allTime');
}

// ── Месяц, счета, способы оплаты (раздел «Финансы», 10.11.2026) ──────────

/** Текущий месяц по Душанбе, «ГГГГ-ММ». */
export function currentYm(): string {
  return tjToday().slice(0, 7);
}

/** Сдвиг месяца: shiftYm('2026-01', -1) → '2025-12'. */
export function shiftYm(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Границы месяца для API: { from: '2026-11-01', to: '2026-11-30' }. */
export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

/** «Ноябрь 2026» (long) или «нояб.» (short). */
export function monthLabel(ym: string, style: 'long' | 'short' = 'long'): string {
  const txt = fmtDateText(`${ym}-15T00:00:00Z`, style === 'long'
    ? { month: 'long', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', timeZone: 'UTC' });
  const clean = txt.replace(/\s+г\.?$/, '');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Месяц страницы — в ссылке (?ym=ГГГГ-ММ), без новых записей в истории. */
export function useYmParam(): [string, (ym: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('ym') || '';
  const ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : currentYm();
  const setYm = (next: string) =>
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (next === currentYm()) n.delete('ym');
      else n.set('ym', next);
      return n;
    }, { replace: true });
  return [ym, setYm];
}

/** ‹ Ноябрь 2026 › + «Сегодня», если смотрим не текущий месяц. */
export function MonthNav({ ym, onChange, busy }: { ym: string; onChange: (ym: string) => void; busy?: boolean }) {
  const { t } = useT();
  const cur = currentYm();
  return (
    <div className="fin-monthnav" data-testid="fin-monthnav">
      <div className="fin-monthnav-box">
        <button type="button" className="fin-monthnav-arrow" onClick={() => onChange(shiftYm(ym, -1))} aria-label={t('finance.month.prev')} data-testid="fin-month-prev">
          <Icon name="chevron_left" size={20} />
        </button>
        <span className="fin-monthnav-label" data-testid="fin-month-label" aria-live="polite">{monthLabel(ym)}</span>
        <button type="button" className="fin-monthnav-arrow" onClick={() => onChange(shiftYm(ym, 1))} aria-label={t('finance.month.next')} data-testid="fin-month-next">
          <Icon name="chevron_right" size={20} />
        </button>
      </div>
      {ym !== cur && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(cur)} data-testid="fin-month-today">
          {t('finance.month.current')}
        </button>
      )}
      {busy && <span className="fin-monthnav-busy" aria-hidden="true">…</span>}
    </div>
  );
}

/** Цвета для счетов: 8 вариантов, различимых и по светлоте. */
export const ACCOUNT_COLORS = ['#16A34A', '#0E7490', '#7C3AED', '#B45309', '#01368B', '#BE185D', '#475569', '#0E7C86'];

/** Значок счёта: квадрат цвета счёта с буквой (у долларового — «$»). */
export function AccountMark({ account, size = 28 }: { account: { name: string; currency?: string; color?: string | null }; size?: number }) {
  const letter = account.currency === 'USD' ? '$' : (account.name.trim()[0] || '?').toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="fin-acc-mark"
      style={{ width: size, height: size, background: account.color || '#475569', fontSize: Math.round(size * 0.45) }}
    >
      {letter}
    </span>
  );
}

/** Способ оплаты словами; 'NONE' — не указан. */
export function channelLabel(channel: string, t: (k: string) => string): string {
  if (channel === 'NONE') return t('finance.acc.channelNone');
  if (channel === 'CRYPTO') return 'Crypto';
  if (channel === 'OTHER') return t('userDoc.OTHER');
  const k = `finance.channel.${channel}`;
  return t(k) !== k ? t(k) : channel;
}

/** Сумма со знаком: «+1 200 с.» / «−800 с.». */
export function signedMoney(n: number, currency = 'TJS'): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtMoney(Math.abs(n), currency)}`;
}
