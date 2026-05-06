import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { applicationStats } from '../api/applications';
import { studentStats } from '../api/students';
import { DIRECTION_LABEL, STATUS_LABEL } from '../api/types';

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.05, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Dashboard() {
  const [appStats, setAppStats] = useState<any>(null);
  const [stuStats, setStuStats] = useState<any>(null);

  useEffect(() => {
    applicationStats().then(setAppStats).catch(() => {});
    studentStats().then(setStuStats).catch(() => {});
  }, []);

  const newCount = appStats?.byStatus?.find((s: any) => s.status === 'NEW')?._count || 0;
  const inProgress =
    (appStats?.byStatus?.find((s: any) => s.status === 'DOCS_REVIEW')?._count || 0) +
    (appStats?.byStatus?.find((s: any) => s.status === 'DOCS_SUBMITTED')?._count || 0) +
    (appStats?.byStatus?.find((s: any) => s.status === 'PRE_ADMISSION')?._count || 0) +
    (appStats?.byStatus?.find((s: any) => s.status === 'AWAITING_PAYMENT')?._count || 0);
  const enrolled = appStats?.byStatus?.find((s: any) => s.status === 'ENROLLED')?._count || 0;

  // Bento KPI cards
  const kpis: Array<{
    eyebrow: string; label: string; value: any; em?: string;
    accent?: 'feature' | 'accent' | undefined;
    span: string; row?: string;
  }> = [
    { eyebrow: 'TOTAL · 01', label: 'Всего заявок', value: appStats?.total ?? '—', em: 'в работе.', accent: 'feature', span: 'span-4', row: 'row-2' },
    { eyebrow: 'NEW · 02', label: 'Новые', value: newCount, span: 'span-2' },
    { eyebrow: 'PIPELINE · 03', label: 'В воронке', value: inProgress, accent: 'accent', span: 'span-2' },
    { eyebrow: 'WIN · 04', label: 'Зачислено', value: enrolled, span: 'span-3' },
    { eyebrow: 'SCHOLARS · 05', label: 'Студентов всего', value: stuStats?.total ?? '—', span: 'span-3' },
  ];

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">КЛЮЧЕВЫЕ МЕТРИКИ</span>
        <h2 className="crm-section-title">
          Итоги <em>в моменте.</em>
        </h2>
      </div>

      <div className="bento" style={{ marginBottom: 32 }}>
        {kpis.map((k, i) => (
          <motion.div
            key={k.label}
            className={`bento-card${k.accent ? ' ' + k.accent : ''} ${k.span}${k.row ? ' ' + k.row : ''}`}
            variants={fadeUp}
            custom={i}
            initial="hidden"
            animate="show"
            whileHover={{ y: -3 }}
          >
            <span className="bento-num">{k.eyebrow}</span>
            <div style={{ marginTop: 'auto' }}>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: k.accent === 'feature' ? 'clamp(80px, 9vw, 128px)' : 'clamp(48px, 6vw, 80px)',
                  fontWeight: 500,
                  letterSpacing: '-0.04em',
                  lineHeight: 0.9,
                  marginBottom: 12,
                }}
              >
                {k.value}
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: k.accent === 'feature' ? 'rgba(255,255,255,0.55)'
                  : k.accent === 'accent' ? 'rgba(5,7,6,0.65)'
                  : 'var(--text-soft)',
              }}>
                {k.label}
                {k.em && (
                  <span style={{
                    fontFamily: 'Times New Roman, Georgia, serif',
                    fontStyle: 'italic',
                    fontSize: 18,
                    letterSpacing: '-0.01em',
                    textTransform: 'none',
                    marginLeft: 8,
                    color: k.accent === 'feature' ? 'var(--primary-light)' : 'var(--primary-dark)',
                  }}>{k.em}</span>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="crm-section-head">
        <span className="crm-section-eyebrow">ДЕТАЛИЗАЦИЯ</span>
        <h2 className="crm-section-title">
          Распределение <em>по срезам.</em>
        </h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <BreakdownCard
          eyebrow="01 · DIRECTIONS"
          title="Заявки по направлениям"
          rows={(appStats?.byDirection || []).map((d: any) => ({
            label: DIRECTION_LABEL[d.direction as keyof typeof DIRECTION_LABEL] || d.direction,
            value: d._count,
          }))}
        />
        <BreakdownCard
          eyebrow="02 · CABINETS"
          title="Студенты по кабинетам"
          rows={(stuStats?.byCabinet || []).map((c: any) => ({
            label: `Кабинет ${c.cabinet}`,
            value: c._count,
          }))}
        />
        <BreakdownCard
          eyebrow="03 · FUNNEL"
          title="Воронка статусов"
          rows={(appStats?.byStatus || []).map((s: any) => ({
            label: STATUS_LABEL[s.status as keyof typeof STATUS_LABEL] || s.status,
            value: s._count,
          }))}
        />
      </div>
    </>
  );
}

function BreakdownCard({
  eyebrow,
  title,
  rows,
}: {
  eyebrow: string;
  title: string;
  rows: Array<{ label: string; value: any }>;
}) {
  const total = rows.reduce((s, r) => s + (Number(r.value) || 0), 0) || 1;

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      style={{ padding: 24 }}
    >
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.16em',
        color: 'var(--text-light)',
        marginBottom: 6,
      }}>
        {eyebrow}
      </div>
      <h3 style={{
        fontFamily: 'var(--font-display)',
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: '-0.02em',
        marginBottom: 20,
      }}>
        {title}
      </h3>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--text-light)', fontSize: 14, padding: '12px 0' }}>Нет данных</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {rows.map((r) => {
            const pct = Math.round(((Number(r.value) || 0) / total) * 100);
            return (
              <div key={r.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 14 }}>{r.label}</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 500,
                  }}>
                    {r.value}
                    <span style={{ color: 'var(--text-light)', marginLeft: 6 }}>· {pct}%</span>
                  </span>
                </div>
                <div style={{
                  height: 4,
                  background: 'var(--bg-mute)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}>
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                    style={{
                      height: '100%',
                      background: 'var(--primary)',
                      borderRadius: 2,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
