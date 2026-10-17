import { useEffect, useRef, useState } from 'react';

/**
 * График итогов недель (0–100) в кабинете: своя линия и средняя по группе.
 * Тот же рисунок, что у графика журнала в CRM (ScoreChart): монотонная
 * кривая, подписи недель снизу, подсказка при наведении/касании.
 */
export interface ProgressSeries {
  id: string;
  name: string;
  color: string;
  dashed?: boolean;
  points: Array<{ x: number; y: number }>;
}

const PAD = { top: 14, right: 36, bottom: 30, left: 34 };
const Y_TICKS = [0, 25, 50, 75, 100];

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

export default function ProgressChart({
  series,
  weeks,
  height = 230,
}: {
  series: ProgressSeries[];
  weeks: Array<{ x: number; label: string }>;
  height?: number;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(240, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const colX = (i: number) => PAD.left + (weeks.length <= 1 ? innerW / 2 : (innerW * i) / (weeks.length - 1));
  const yOf = (v: number) => PAD.top + innerH - (Math.max(0, Math.min(100, v)) / 100) * innerH;
  const idxOf = new Map(weeks.map((w, i) => [w.x, i]));
  const labelEvery = Math.max(1, Math.ceil((weeks.length * 56) / Math.max(innerW, 1)));

  const onMove = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || !weeks.length) return;
    const x = clientX - box.left;
    let best = 0;
    let bestD = Infinity;
    weeks.forEach((_, i) => {
      const d = Math.abs(colX(i) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  const tip =
    hover === null
      ? []
      : series
          .map((s) => ({ s, v: s.points.find((p) => p.x === weeks[hover].x)?.y ?? null }))
          .filter((r) => r.v !== null);

  return (
    <div className="acad-chart">
      <div
        ref={boxRef}
        className="acad-chart-box"
        style={{ height }}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => onMove(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
      >
        <svg width={width} height={height} role="img" aria-label="Натиҷаҳои ҳафтаҳо">
          {Y_TICKS.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={width - PAD.right} y1={yOf(v)} y2={yOf(v)} className="acad-chart-grid" />
              <text x={PAD.left - 8} y={yOf(v) + 4} textAnchor="end" className="acad-chart-tick">{v}</text>
            </g>
          ))}
          {weeks.map((w, i) => (
            <g key={w.x}>
              {(i % labelEvery === 0 || i === weeks.length - 1) && (
                <text x={colX(i)} y={height - 8} textAnchor="middle" className="acad-chart-tick">{w.label}</text>
              )}
            </g>
          ))}
          {hover !== null && (
            <line x1={colX(hover)} x2={colX(hover)} y1={PAD.top} y2={PAD.top + innerH} className="acad-chart-cursor" />
          )}
          {series.map((s) => {
            const pts = s.points.filter((p) => idxOf.has(p.x)).map((p) => ({ x: colX(idxOf.get(p.x)!), y: yOf(p.y) }));
            return (
              <g key={s.id}>
                <path
                  d={smoothPath(pts)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.dashed ? 2 : 3}
                  strokeDasharray={s.dashed ? '6 5' : undefined}
                  strokeLinecap="round"
                />
                {pts.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={s.dashed ? 3 : 4.5} fill="#fff" stroke={s.color} strokeWidth={2} />
                ))}
              </g>
            );
          })}
        </svg>
        {hover !== null && tip.length > 0 && (
          <div className="acad-chart-tip" style={{ left: Math.min(Math.max(colX(hover) + 12, 8), width - 180), top: PAD.top + 6 }}>
            <div className="acad-chart-tip-title">{weeks[hover].label}</div>
            {tip.map(({ s, v }) => (
              <div key={s.id} style={{ color: s.color }}>{s.name} — {v}</div>
            ))}
          </div>
        )}
      </div>
      <div className="acad-chart-legend">
        {series.map((s) => (
          <span key={s.id} className="acad-chart-legend-item" style={{ color: s.color }}>
            <span className={`acad-chart-dot${s.dashed ? ' is-dashed' : ''}`} style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
