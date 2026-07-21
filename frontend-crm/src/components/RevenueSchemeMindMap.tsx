import type { RevenueScheme, RevenueBucket } from '../api/revenue-scheme';
import { useT, type Lang } from '../lib/i18n';

/**
 * Локаль для Intl.NumberFormat. Держим здесь, а не в i18n.tsx, чтобы
 * форматирование чисел жило рядом с местом использования; переключение
 * `ru` → `ru-RU`, `tg` → `tg-TJ`.
 */
function moneyLocale(lang: Lang): string {
  return lang === 'tg' ? 'tg-TJ' : 'ru-RU';
}

/**
 * Пассивная визуализация схемы распределения — mind-map:
 *   центральный узел «100% Доход» → лучи к фондам → под-узлы (статьи).
 *
 * Читает `scheme`, ничего не мутирует. Основной формат — SVG:
 *   • FOUNDER всегда должен видеть «стройную картину», даже если фондов
 *     стало 12 или у одного фонда >10 статей;
 *   • масштабирование через `viewBox` — SVG подстроит себя под ширину
 *     контейнера (`.card`), горизонтальный overflow-скролл включаем на
 *     обёртке — на мобильном (<768px) переключаемся на вертикальную
 *     schemeList-разметку, чтобы не терять читаемость.
 *
 * Ветки красятся по `bucket.color`; item-узлы:
 *   • PERCENTAGE-фонд: показываем только name статьи (это подпись);
 *   • FIXED_SUM-фонд:  показываем «Alijon-10 000» (name + сумма в TJS,
 *     формат: разряды через тонкий пробел; десятки копеек скрываются
 *     если целая сумма).
 */

const FALLBACK_COLOR = '#94a3b8';

function bucketColor(b: RevenueBucket): string {
  if (b.color && b.color.trim() && b.color !== '#ffffff') return b.color;
  return FALLBACK_COLOR;
}

function fmtTjs(cents: number | null | undefined, locale: string): string {
  if (cents == null) return '';
  const tjs = cents / 100;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(tjs);
}

function bucketHeadline(b: RevenueBucket): string {
  if (b.kind === 'PERCENTAGE') {
    const pct = b.percent ?? 0;
    return `${pct}% · ${b.name}`;
  }
  return b.name;
}

function itemLabel(
  item: { name: string; amountCents: number | null },
  kind: 'PERCENTAGE' | 'FIXED_SUM',
  locale: string,
): string {
  if (kind === 'FIXED_SUM' && item.amountCents != null) {
    return `${item.name} — ${fmtTjs(item.amountCents, locale)}`;
  }
  return item.name;
}

type Translator = (k: string) => string;

export default function RevenueSchemeMindMap({ scheme }: { scheme: RevenueScheme | null | undefined }) {
  const { t, lang } = useT();
  const locale = moneyLocale(lang);

  if (!scheme || scheme.buckets.length === 0) {
    return (
      <div style={{ color: 'var(--text-soft)', fontSize: 13, padding: '8px 4px' }}>
        {t('settings.revenueScheme.mindmap.empty')}
      </div>
    );
  }

  const buckets = [...scheme.buckets].sort((a, b) => a.order - b.order);

  return (
    <div>
      {/* Desktop / tablet: horizontal SVG mind-map. */}
      <div
        className="revenue-mindmap-desktop"
        style={{ overflowX: 'auto', width: '100%' }}
      >
        <MindMapSvg buckets={buckets} t={t} locale={locale} />
      </div>

      {/* Mobile: vertical stacked list. Показываем ниже 768px через CSS class,
          но `display` управляется inline-fallback: при slot-based rendering
          без глобального CSS полагаемся на @media внутри style-tag ниже. */}
      <style>{`
        @media (max-width: 767px) {
          .revenue-mindmap-desktop { display: none; }
          .revenue-mindmap-mobile { display: block !important; }
        }
      `}</style>
      <div
        className="revenue-mindmap-mobile"
        style={{ display: 'none', marginTop: 8 }}
      >
        <MindMapMobile buckets={buckets} t={t} locale={locale} />
      </div>
    </div>
  );
}

// ============================================================================
// SVG horizontal mind-map
// ============================================================================

function MindMapSvg({
  buckets,
  t,
  locale,
}: {
  buckets: RevenueBucket[];
  t: Translator;
  locale: string;
}) {
  // Динамические высоты: расширяем viewBox по количеству фондов/статей,
  // чтобы >7 фондов не «слипались».
  const bucketCount = buckets.length;
  // Считаем места для statей: FIXED_SUM статьи важны, PERCENTAGE — не критично.
  const rowsPerBucket = buckets.map((b) => Math.max(1, b.items.length));
  const totalRows = rowsPerBucket.reduce((s, r) => s + r, 0);

  const rowHeight = 30;
  const bucketGap = 20;
  const centralPad = 60;
  const height = Math.max(
    360,
    totalRows * rowHeight + bucketCount * bucketGap + centralPad,
  );
  const width = 900;

  // Позиции: центр слева (x=140), фонды в столбце x=430, статьи x=720.
  const centerX = 140;
  const centerY = height / 2;
  const bucketX = 430;
  const itemX = 720;

  // Раскладываем фонды по вертикали пропорционально числу их строк.
  let cursorY = centralPad / 2;
  const bucketPositions = buckets.map((b, i) => {
    const rows = rowsPerBucket[i];
    const blockH = rows * rowHeight + bucketGap;
    const y = cursorY + blockH / 2;
    cursorY += blockH;
    return { bucket: b, y, blockH };
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: 'auto', minWidth: 600, display: 'block' }}
      role="img"
      aria-label={t('settings.revenueScheme.mindmap.aria')}
    >
      {/* Ветки центр → фонд */}
      {bucketPositions.map(({ bucket, y }) => {
        const color = bucketColor(bucket);
        // bezier-«ветка»: небольшая S-кривая
        const midX = (centerX + bucketX) / 2;
        const d = `M ${centerX + 60} ${centerY} C ${midX} ${centerY}, ${midX} ${y}, ${bucketX - 4} ${y}`;
        return (
          <path
            key={`edge-${bucket.id}`}
            d={d}
            stroke={color}
            strokeWidth={2}
            fill="none"
            opacity={0.7}
          />
        );
      })}

      {/* Центральный узел «100% Доход» */}
      <g>
        <ellipse
          cx={centerX}
          cy={centerY}
          rx={70}
          ry={38}
          fill="var(--bg-soft, #f1f5f9)"
          stroke="var(--text, #0f172a)"
          strokeWidth={1.5}
        />
        <text
          x={centerX}
          y={centerY - 4}
          textAnchor="middle"
          fontFamily="var(--font-display, sans-serif)"
          fontSize={16}
          fontWeight={600}
          fill="var(--text, #0f172a)"
        >
          {t('settings.revenueScheme.mindmap.center')}
        </text>
        <text
          x={centerX}
          y={centerY + 14}
          textAnchor="middle"
          fontFamily="var(--font-mono, monospace)"
          fontSize={11}
          fill="var(--text-soft, #64748b)"
          style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}
        >
          {t('settings.revenueScheme.mindmap.centerLabel')}
        </text>
      </g>

      {/* Фонды + под-статьи */}
      {bucketPositions.map(({ bucket, y }) => {
        const color = bucketColor(bucket);
        const headline = bucketHeadline(bucket);
        const items = [...bucket.items].sort((a, b) => a.order - b.order);

        // Раскладываем items вокруг y ± (n/2 * rowHeight).
        const n = items.length || 1;
        const startY = y - ((n - 1) * rowHeight) / 2;

        return (
          <g key={`bucket-${bucket.id}`}>
            {/* Bucket-node */}
            <rect
              x={bucketX}
              y={y - 20}
              width={230}
              height={40}
              rx={10}
              ry={10}
              fill={color}
              opacity={0.14}
              stroke={color}
              strokeWidth={1.5}
            />
            <text
              x={bucketX + 12}
              y={y + 5}
              fontFamily="var(--font-display, sans-serif)"
              fontSize={13}
              fontWeight={600}
              fill="var(--text, #0f172a)"
            >
              {truncate(headline, 26)}
            </text>

            {/* Items */}
            {items.map((item, idx) => {
              const iy = startY + idx * rowHeight;
              const label = itemLabel(item, bucket.kind, locale);
              return (
                <g key={item.id}>
                  <line
                    x1={bucketX + 230}
                    y1={y}
                    x2={itemX - 4}
                    y2={iy}
                    stroke={color}
                    strokeWidth={1}
                    opacity={0.5}
                  />
                  <circle cx={itemX} cy={iy} r={4} fill={color} />
                  <text
                    x={itemX + 10}
                    y={iy + 4}
                    fontFamily="var(--font-mono, monospace)"
                    fontSize={11}
                    fill="var(--text, #0f172a)"
                  >
                    {truncate(label, 22)}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

// ============================================================================
// Vertical mobile fallback
// ============================================================================

function MindMapMobile({
  buckets,
  t,
  locale,
}: {
  buckets: RevenueBucket[];
  t: Translator;
  locale: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          textAlign: 'center',
          padding: 12,
          border: '1.5px solid var(--text, #0f172a)',
          borderRadius: 12,
          background: 'var(--bg-soft, #f1f5f9)',
          fontFamily: 'var(--font-display, sans-serif)',
          fontWeight: 600,
        }}
      >
        {t('settings.revenueScheme.mindmap.center')}{' '}
        {t('settings.revenueScheme.mindmap.centerLabel')}
      </div>
      {buckets.map((b) => {
        const color = bucketColor(b);
        const items = [...b.items].sort((a, x) => a.order - x.order);
        return (
          <div
            key={b.id}
            style={{
              border: `1.5px solid ${color}`,
              borderRadius: 10,
              padding: '10px 12px',
              background: `${color}12`,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {bucketHeadline(b)}
            </div>
            {items.length > 0 && (
              <ul
                style={{
                  margin: '6px 0 0 12px',
                  padding: 0,
                  listStyle: 'disc',
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 12,
                  color: 'var(--text-soft, #64748b)',
                }}
              >
                {items.map((it) => (
                  <li key={it.id}>{itemLabel(it, b.kind, locale)}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
