import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { applicationStats } from '../api/applications';
import { studentStats } from '../api/students';
import { financeSummary, pendingPayments, type FinanceSummary } from '../api/finance';
import { leaderboard, type KpiRow } from '../api/kpi';
import { DIRECTION_LABEL, STATUS_LABEL } from '../api/types';
import { useAuth } from '../store/auth';
import { keys } from '../lib/queryKeys';
import { isElevated } from '../lib/roles';

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.05, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Dashboard() {
  const me = useAuth((s) => s.user);
  const isAdmin = isElevated(me);
  const isAccountant = me?.role === 'ACCOUNTANT';
  const showFinance = isAdmin || isAccountant;

  const appStatsQuery = useQuery({ queryKey: ['applications', 'stats'], queryFn: () => applicationStats() });
  const appStats = appStatsQuery.data ?? null;

  const stuStatsQuery = useQuery({ queryKey: keys.students.stats(), queryFn: () => studentStats() });
  const stuStats = stuStatsQuery.data ?? null;

  const financeQuery = useQuery<FinanceSummary>({
    queryKey: keys.finance.summary(),
    queryFn: () => financeSummary(),
    enabled: showFinance,
  });
  const finance = financeQuery.data ?? null;

  const pendingQuery = useQuery<any[]>({
    queryKey: keys.finance.pending(),
    queryFn: () => pendingPayments(),
    enabled: showFinance,
  });
  const pending = pendingQuery.data ?? [];

  const leaderQuery = useQuery<KpiRow[]>({
    queryKey: ['kpi', 'leaderboard', 'top3'],
    queryFn: () => leaderboard(),
    enabled: isAdmin,
  });
  const topPerformers = (leaderQuery.data ?? []).slice(0, 3);

  const newCount = appStats?.byStatus?.find((s: any) => s.status === 'NEW')?._count || 0;
  const inProgress =
    (appStats?.byStatus?.find((s: any) => s.status === 'DOCS_REVIEW')?._count || 0) +
    (appStats?.byStatus?.find((s: any) => s.status === 'DOCS_SUBMITTED')?._count || 0) +
    (appStats?.byStatus?.find((s: any) => s.status === 'PRE_ADMISSION')?._count || 0) +
    (appStats?.byStatus?.find((s: any) => s.status === 'AWAITING_PAYMENT')?._count || 0);
  const enrolled = appStats?.byStatus?.find((s: any) => s.status === 'ENROLLED')?._count || 0;

  // ТЗ §4 «Активные клиенты» — берём ACTIVE студентов из stuStats.byStatus
  const activeStudents = stuStats?.byStatus?.find((s: any) => s.status === 'ACTIVE')?._count
    ?? stuStats?.total
    ?? 0;

  // Bento KPI cards
  const kpis: Array<{
    eyebrow: string; label: string; value: any; em?: string;
    accent?: 'feature' | 'accent' | undefined;
    span: string; row?: string;
  }> = [
    { eyebrow: 'TOTAL · 01', label: 'Всего заявок', value: appStats?.total ?? '—', em: 'в работе.', accent: 'feature', span: 'span-4', row: 'row-2' },
    { eyebrow: 'NEW · 02', label: 'Новые', value: newCount, span: 'span-2' },
    { eyebrow: 'PIPELINE · 03', label: 'В воронке', value: inProgress, accent: 'accent', span: 'span-2' },
    { eyebrow: 'ACTIVE · 04', label: 'Активные клиенты', value: activeStudents, em: 'учатся.', span: 'span-3' },
    { eyebrow: 'WIN · 05', label: 'Зачислено всего', value: enrolled, span: 'span-3' },
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

      {/* Financial bento — visible only for ADMIN / ACCOUNTANT */}
      {showFinance && finance && (
        <>
          <div className="crm-section-head" style={{ marginTop: 8 }}>
            <span className="crm-section-eyebrow">FINANCE · MONEY MAP</span>
            <h2 className="crm-section-title">
              Деньги <em>в моменте.</em>
            </h2>
          </div>
          <div className="bento" style={{ marginBottom: 32 }}>
            <motion.div
              className="bento-card feature span-3 row-2"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <span className="bento-num">PROFIT · 06</span>
              <div style={{ marginTop: 'auto' }}>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(56px, 7vw, 96px)',
                  fontWeight: 500,
                  letterSpacing: '-0.04em',
                  lineHeight: 0.9,
                  marginBottom: 12,
                }}>{fmtMoney(finance.netProfit)}</div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.12em',
                  color: 'rgba(255,255,255,0.55)',
                  textTransform: 'uppercase',
                }}>Чистая прибыль <span style={{
                  fontFamily: 'Times New Roman, Georgia, serif',
                  fontStyle: 'italic',
                  fontSize: 18,
                  color: 'var(--primary-light)',
                  textTransform: 'none',
                  marginLeft: 6,
                }}>за всё время.</span></div>
              </div>
            </motion.div>

            <SmallBento
              eyebrow="INCOME · 07"
              label="Доходы"
              value={fmtMoney(finance.totalIncome)}
              accent
            />
            <SmallBento
              eyebrow="EXPENSE · 08"
              label="Расходы"
              value={fmtMoney(finance.totalExpense)}
            />
            <SmallBento
              eyebrow="DEBT · 09"
              label={pending.length === 1 ? '1 студент должен оплатить' : `${pending.length} студентов с задолженностью`}
              value={String(pending.length)}
              span="span-3"
            />
          </div>
        </>
      )}

      {/* Top 3 performers — only ADMIN */}
      {isAdmin && topPerformers.length > 0 && (
        <>
          <div className="crm-section-head" style={{ marginTop: 8 }}>
            <span className="crm-section-eyebrow">TOP TEAM · LEADERBOARD</span>
            <h2 className="crm-section-title">
              Лучшие <em>сотрудники.</em>
            </h2>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 14,
            marginBottom: 32,
          }}>
            {topPerformers.map((p, i) => (
              <motion.div
                key={p.id}
                className="card"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                style={{ padding: 24, position: 'relative' }}
              >
                <div style={{
                  position: 'absolute', top: 16, right: 20,
                  fontFamily: 'var(--font-display)',
                  fontSize: 28,
                  letterSpacing: '-0.02em',
                  color: i === 0 ? 'var(--primary-dark)' : 'var(--text-light)',
                }}>
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}
                </div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  color: 'var(--text-light)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                }}>RANK #{i + 1}</div>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 22,
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                  marginBottom: 16,
                }}>{p.fullName}</div>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 36,
                  fontWeight: 500,
                  letterSpacing: '-0.03em',
                  color: 'var(--primary-dark)',
                  marginBottom: 6,
                }}>{fmtMoney(p.salesAmount)}</div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.10em',
                  color: 'var(--text-soft)',
                  textTransform: 'uppercase',
                }}>{p.applicationsEnrolled} ENROLLED · {p.conversionRate}% CONV</div>
              </motion.div>
            ))}
          </div>
        </>
      )}

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

function SmallBento({ eyebrow, label, value, accent, span = 'span-3' }: {
  eyebrow: string; label: string; value: string; accent?: boolean; span?: string;
}) {
  return (
    <motion.div
      className={`bento-card ${accent ? 'accent' : ''} ${span}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3 }}
    >
      <span className="bento-num">{eyebrow}</span>
      <div style={{ marginTop: 'auto' }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(40px, 5vw, 56px)',
          fontWeight: 500,
          letterSpacing: '-0.04em',
          lineHeight: 0.9,
          marginBottom: 12,
        }}>{value}</div>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: accent ? 'rgba(5,7,6,0.65)' : 'var(--text-soft)',
        }}>{label}</div>
      </div>
    </motion.div>
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
