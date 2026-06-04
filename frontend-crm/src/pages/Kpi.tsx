import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { KpiRow, leaderboard } from '../api/kpi';
import { ROLE_LABEL } from '../api/types';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

const RANGES: Array<{ label: string; days: number | null }> = [
  { label: 'Все время', days: null },
  { label: '7 дней', days: 7 },
  { label: '30 дней', days: 30 },
  { label: '90 дней', days: 90 },
];

export default function Kpi() {
  const me = useAuth((s) => s.user);
  const [rangeIdx, setRangeIdx] = useState(2); // 30 days по умолчанию

  const r = RANGES[rangeIdx];
  const params = r.days
    ? { from: new Date(Date.now() - r.days * 24 * 60 * 60 * 1000).toISOString() }
    : undefined;
  const kpiQuery = useQuery<KpiRow[]>({
    queryKey: ['kpi', 'leaderboard', rangeIdx],
    queryFn: () => leaderboard(params),
  });
  const rows = kpiQuery.data ?? [];

  const top = rows[0];
  const myRow = rows.find((r) => r.id === me?.id);
  const myRank = myRow ? rows.findIndex((r) => r.id === me?.id) + 1 : 0;

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">KPI · 10</span>
        <h2 className="crm-section-title">
          Эффективность <em>команды.</em>
        </h2>
      </div>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="pagination-controls" style={{ padding: 4 }}>
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              className={i === rangeIdx ? 'active' : ''}
              onClick={() => setRangeIdx(i)}
            >{r.label}</button>
          ))}
        </div>
      </div>

      {/* My row highlight if employee */}
      {!isElevated(me) && myRow && (
        <motion.div
          className="bento"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          style={{ marginBottom: 32 }}
        >
          <div className="bento-card feature span-3 row-2">
            <span className="bento-num">YOUR RANK · #{myRank}</span>
            <div style={{ marginTop: 'auto' }}>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(64px, 8vw, 104px)',
                fontWeight: 500,
                letterSpacing: '-0.04em',
                lineHeight: 0.9,
                marginBottom: 16,
              }}>{fmtMoney(myRow.salesAmount)}</div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                color: 'rgba(255,255,255,0.55)',
                textTransform: 'uppercase',
              }}>Твои продажи <span style={{
                fontFamily: 'Times New Roman, Georgia, serif',
                fontStyle: 'italic',
                fontSize: 18,
                color: 'var(--primary-light)',
                textTransform: 'none',
                marginLeft: 6,
              }}>в периоде.</span></div>
            </div>
          </div>
          <KpiBento eyebrow="CONVERSION" label="Конверсия" value={`${myRow.conversionRate}%`} accent />
          <KpiBento eyebrow="ENROLLED" label="Зачислено" value={String(myRow.applicationsEnrolled)} />
          <KpiBento eyebrow="STUDENTS" label="Активных студентов" value={String(myRow.studentsCount)} span="span-3" />
        </motion.div>
      )}

      {/* Top performer banner for ADMIN */}
      {isElevated(me) && top && (
        <motion.div
          className="card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            background: 'linear-gradient(135deg, var(--text), var(--primary-darker))',
            color: 'white',
            padding: 32,
            marginBottom: 24,
            borderColor: 'transparent',
          }}
        >
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            color: 'var(--primary-light)',
            marginBottom: 12,
          }}>🏆 TOP PERFORMER · LEADERBOARD #1</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 32, flexWrap: 'wrap' }}>
            <div>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: 42,
                fontWeight: 500,
                letterSpacing: '-0.02em',
                lineHeight: 1,
                marginBottom: 8,
              }}>{top.fullName}</div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'rgba(255,255,255,0.55)',
                letterSpacing: '0.08em',
              }}>{ROLE_LABEL[top.role]}</div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: 64,
                fontWeight: 500,
                letterSpacing: '-0.04em',
                lineHeight: 1,
                color: 'var(--primary-light)',
              }}>{fmtMoney(top.salesAmount)}</div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'rgba(255,255,255,0.55)',
                letterSpacing: '0.10em',
                marginTop: 6,
              }}>{top.applicationsEnrolled} ENROLLED · {top.conversionRate}% CONVERSION</div>
            </div>
          </div>
        </motion.div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Сотрудник</th>
              <th>Заявок</th>
              <th>Зачислено</th>
              <th>Конверсия</th>
              <th>Студентов</th>
              <th>Продажи</th>
              <th>Задачи</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="empty">Нет данных</td></tr>
            )}
            {rows.map((r, i) => {
              const isMe = r.id === me?.id;
              return (
                <tr key={r.id} style={isMe ? { background: 'var(--primary-soft)' } : undefined}>
                  <td style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 500,
                    fontSize: 18,
                    letterSpacing: '-0.02em',
                    color: i < 3 ? 'var(--primary-dark)' : 'var(--text-light)',
                  }}>
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                  </td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.fullName} {isMe && <span style={{ fontFamily: 'Times New Roman, Georgia, serif', fontStyle: 'italic', color: 'var(--primary-dark)' }}>— это вы</span>}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-light)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      {ROLE_LABEL[r.role]}
                    </div>
                  </td>
                  <td>{r.applicationsAssigned}</td>
                  <td style={{ color: 'var(--primary-dark)' }}>{r.applicationsEnrolled}</td>
                  <td>
                    <span className={`badge ${r.conversionRate >= 50 ? 'badge-success' : r.conversionRate >= 25 ? 'badge-warning' : 'badge-gray'}`}>
                      {r.conversionRate}%
                    </span>
                  </td>
                  <td>{r.studentsCount}</td>
                  <td style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 500,
                    fontSize: 16,
                    letterSpacing: '-0.01em',
                    color: 'var(--primary-dark)',
                  }}>{fmtMoney(r.salesAmount)}</td>
                  <td style={{ fontSize: 13, color: 'var(--text-soft)' }}>
                    <span style={{ color: 'var(--text)' }}>{r.tasksDone}</span> / {r.tasksDone + r.tasksOpen}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function KpiBento({ eyebrow, label, value, accent, span = 'span-3' }: {
  eyebrow: string; label: string; value: string; accent?: boolean; span?: string;
}) {
  return (
    <motion.div
      className={`bento-card ${accent ? 'accent' : ''} ${span}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <span className="bento-num">{eyebrow}</span>
      <div style={{ marginTop: 'auto' }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(40px, 5vw, 64px)',
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
