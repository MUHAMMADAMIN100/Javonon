import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';

/**
 * График итогов недель (0–100) — линии по ученикам, как в журнале с образца:
 * по оси X недели и в конце «Среднее», при наведении — подсказка со всеми
 * значениями этой недели, легенда включает и выключает линии.
 *
 * Свой SVG без библиотек: графиков в CRM больше нет, тянуть ради одного
 * пакет в 100+ КБ незачем. Ширину берём у контейнера (ResizeObserver),
 * поэтому подписи не растягиваются, как было бы с viewBox на всю ширину.
 */

export interface ChartSeries {
  id: string;
  name: string;
  /** x — номер недели, y — итог 0–100. */
  points: Array<{ x: number; y: number }>;
  /** Значение в колонке «Среднее»; null — не рисовать. */
  avg?: number | null;
}

export const CHART_PALETTE = [
  '#f97316', '#22c55e', '#3b82f6', '#a855f7', '#64748b', '#06b6d4',
  '#ef4444', '#eab308', '#ec4899', '#14b8a6', '#8b5cf6', '#84cc16',
];

const PAD = { top: 16, right: 40, bottom: 34, left: 38 };
const Y_TICKS = [0, 25, 50, 75, 100];

/** Монотонная кубическая кривая (Фрич–Карлсон): плавно и без «перелётов» за 0 и 100. */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    m.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x || 1));
  }
  const tg: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) tg.push(0);
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tg.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]));
    }
  }
  tg.push(m[n - 2]);
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i].x + h},${pts[i].y + tg[i] * h} ${pts[i + 1].x - h},${pts[i + 1].y - tg[i + 1] * h} ${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
}

export default function ScoreChart({
  series,
  weeks,
  height = 260,
  showAverage = true,
  testId,
}: {
  series: ChartSeries[];
  /** Недели по порядку: номер и подпись под осью. */
  weeks: Array<{ x: number; label: string }>;
  height?: number;
  showAverage?: boolean;
  testId?: string;
}) {
  const { t } = useT();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(260, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(260, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    series.forEach((s, i) => map.set(s.id, CHART_PALETTE[i % CHART_PALETTE.length]));
    return map;
  }, [series]);

  // Колонки X: недели + «Среднее». Индекс колонки → координата.
  const cols = useMemo(() => {
    const list = weeks.map((w) => ({ key: `w${w.x}`, x: w.x, label: w.label, isAvg: false }));
    if (showAverage) list.push({ key: 'avg', x: Number.NaN, label: t('academy.chart.average'), isAvg: true });
    return list;
  }, [weeks, showAverage, t]);

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const colX = (i: number) => PAD.left + (cols.length <= 1 ? innerW / 2 : (innerW * i) / (cols.length - 1));
  const yOf = (v: number) => PAD.top + innerH - (Math.max(0, Math.min(100, v)) / 100) * innerH;
  const colIndexOfWeek = new Map(cols.map((c, i) => [c.x, i]));

  // Подписи оси X не должны налезать: показываем каждую k-ю.
  const labelEvery = Math.max(1, Math.ceil((cols.length * 64) / Math.max(innerW, 1)));

  const visible = series.filter((s) => !hidden.has(s.id));
  const hasData = series.some((s) => s.points.length > 0 || (s.avg !== null && s.avg !== undefined));

  const onMove = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || cols.length === 0) return;
    const x = clientX - box.left;
    let best = 0;
    let bestD = Infinity;
    cols.forEach((_, i) => {
      const d = Math.abs(colX(i) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  const tooltipRows =
    hover === null
      ? []
      : visible
          .map((s) => {
            const col = cols[hover];
            const v = col.isAvg ? s.avg ?? null : s.points.find((p) => p.x === col.x)?.y ?? null;
            return { s, v };
          })
          .filter((r) => r.v !== null)
          .sort((a, b) => (b.v as number) - (a.v as number));

  return (
    <div className="acad-chart" data-testid={testId}>
      <div
        ref={boxRef}
        className="acad-chart-box"
        style={{ height }}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => onMove(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
      >
        {!hasData ? (
          <div className="acad-chart-empty">{t('academy.chart.empty')}</div>
        ) : (
          <svg width={width} height={height} role="img" aria-label={t('academy.chart.title')}>
            {Y_TICKS.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={yOf(v)} y2={yOf(v)} className="acad-chart-grid" />
                <text x={PAD.left - 8} y={yOf(v) + 4} textAnchor="end" className="acad-chart-tick">
                  {v}
                </text>
              </g>
            ))}
            {cols.map((c, i) => (
              <g key={c.key}>
                <line x1={colX(i)} x2={colX(i)} y1={PAD.top} y2={PAD.top + innerH} className="acad-chart-vgrid" />
                {(i % labelEvery === 0 || c.isAvg) && (
                  <text x={colX(i)} y={height - 10} textAnchor="middle" className={`acad-chart-tick${c.isAvg ? ' is-avg' : ''}`}>
                    {c.label}
                  </text>
                )}
              </g>
            ))}
            {hover !== null && (
              <line x1={colX(hover)} x2={colX(hover)} y1={PAD.top} y2={PAD.top + innerH} className="acad-chart-cursor" />
            )}
            {visible.map((s) => {
              const color = colorOf.get(s.id)!;
              const pts = s.points
                .filter((p) => colIndexOfWeek.has(p.x))
                .map((p) => ({ x: colX(colIndexOfWeek.get(p.x)!), y: yOf(p.y) }));
              if (showAverage && s.avg !== null && s.avg !== undefined) {
                pts.push({ x: colX(cols.length - 1), y: yOf(s.avg) });
              }
              return (
                <g key={s.id}>
                  <path d={smoothPath(pts)} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
                  {pts.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={4} fill="#fff" stroke={color} strokeWidth={2} />
                  ))}
                </g>
              );
            })}
          </svg>
        )}
        {hover !== null && tooltipRows.length > 0 && (
          <div
            className="acad-chart-tip"
            style={{
              left: Math.min(Math.max(colX(hover) + 12, 8), width - 200),
              top: PAD.top + 8,
            }}
          >
            <div className="acad-chart-tip-title">{cols[hover].label}</div>
            {tooltipRows.map(({ s, v }) => (
              <div key={s.id} style={{ color: colorOf.get(s.id) }}>
                {s.name} — {v}
              </div>
            ))}
          </div>
        )}
      </div>
      {series.length > 0 && (
        <div className="acad-chart-legend">
          {series.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`acad-chart-legend-item${hidden.has(s.id) ? ' is-off' : ''}`}
              style={{ color: colorOf.get(s.id) }}
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(s.id)) next.delete(s.id);
                  else next.add(s.id);
                  return next;
                })
              }
            >
              <span className="acad-chart-dot" style={{ background: colorOf.get(s.id) }} />
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
