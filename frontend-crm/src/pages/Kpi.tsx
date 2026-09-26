import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { KpiRow, leaderboard } from '../api/kpi';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useRoleLabel } from '../lib/labels';
import { tjLastDaysRange } from '../lib/tjTime';
import KpiDetailsModal from '../components/KpiDetailsModal';
import FitNumber from '../components/FitNumber';
import BonusProgress from '../components/BonusProgress';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

/**
 * «USD 5 000 · EUR 900» — приходы в прочих валютах за период. Бэк считает
 * KPI только в отчётной валюте (TJS), потому что FX-конвертации в системе
 * нет; эти суммы в рейтинг не входят, но и не исчезают из виду. Возвращает
 * null, когда период был чисто в сомони, — тогда ничего не рисуем.
 */
function nonTjsLine(row: KpiRow): string | null {
  const entries = Object.entries(row.nonTjsSales || {}).filter(([, v]) => !!v);
  if (entries.length === 0) return null;
  return entries.map(([cur, sum]) => fmtMoney(sum, cur)).join(' · ');
}

const RANGE_KEYS: Array<{ key: string; days: number | null }> = [
  { key: 'kpi.range.all', days: null },
  { key: 'kpi.range.7', days: 7 },
  { key: 'kpi.range.30', days: 30 },
  { key: 'kpi.range.90', days: 90 },
];

export default function Kpi() {
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const me = useAuth((s) => s.user);
  const [rangeIdx, setRangeIdx] = useState(2); // 30 days по умолчанию
  /** Строка, по которой открыто окно подробностей (id, а не объект: после
   *  перезапроса рейтинга объект строки уже другой). */
  const [detailsId, setDetailsId] = useState<string | null>(null);
  // Подробности: руководство открывает любого, сотрудник — только себя.
  // Это UX-слой; настоящая проверка — на сервере (KpiService.details).
  const canOpenAll = isElevated(me);

  const range = RANGE_KEYS[rangeIdx];
  // Границы — календарные дни Asia/Dushanbe (YYYY-MM-DD), как их ждёт
  // общий parseDate на бэке: он поднимет `to` до 23:59:59.999 TJT.
  // «Все время» — params undefined, запрос уходит без from/to, и KPI
  // считается ровно как раньше, за всё время.
  const params = range.days ? tjLastDaysRange(range.days) : undefined;
  const kpiQuery = useQuery<KpiRow[]>({
    // Ключ по самим границам, а не по индексу кнопки: в полночь по
    // Душанбе окно «30 дней» съезжает, и кэш обязан это заметить.
    queryKey: ['kpi', 'leaderboard', params?.from ?? 'all', params?.to ?? 'all'],
    queryFn: () => leaderboard(params),
  });
  const rows = kpiQuery.data ?? [];
  // Место в рейтинге — порядок, в котором строки пришли с сервера. При
  // сортировке по другой колонке медали остаются у своих людей.
  const rankOf = new Map(rows.map((r, i) => [r.id, i]));
  const sort = useTableSort(rows, [
    { key: 'rank', label: t('kpi.col.rank'), type: 'number', value: (r) => rankOf.get(r.id) },
    { key: 'employee', label: t('kpi.col.employee'), value: (r) => r.fullName },
    { key: 'applications', label: t('kpi.col.applications'), type: 'number', value: (r) => r.applicationsAssigned },
    { key: 'enrolled', label: t('kpi.col.enrolled'), type: 'number', value: (r) => r.applicationsEnrolled },
    { key: 'conversion', label: t('kpi.col.conversion'), type: 'number', value: (r) => r.conversionRate },
    { key: 'students', label: t('kpi.col.students'), type: 'number', value: (r) => r.studentsCount },
    { key: 'sales', label: t('kpi.col.sales'), type: 'number', value: (r) => r.salesAmount },
    // Бонус ТЕКУЩЕГО месяца (ставка месячная и от периода на экране не зависит).
    { key: 'bonus', label: t('kpi.col.bonusMonth'), type: 'number', value: (r) => r.bonusProgress?.volume ?? 0 },
    { key: 'tasks', label: t('kpi.col.tasks'), type: 'number', value: (r) => r.tasksDone },
  ]);

  const top = rows[0];
  const myRow = rows.find((r) => r.id === me?.id);
  const myRank = myRow ? rows.findIndex((r) => r.id === me?.id) + 1 : 0;

  return (
    <>
      <div className="filters" style={{ alignItems: 'center' }}>
        {/* Тот же вид, что у периода дашборда: на телефоне — сетка 2 × 2. */}
        <div className="pagination-controls period-switcher-options" data-testid="period-options">
          {RANGE_KEYS.map((rg, i) => (
            <button
              key={rg.key}
              type="button"
              className={i === rangeIdx ? 'active' : ''}
              aria-pressed={i === rangeIdx}
              onClick={() => setRangeIdx(i)}
              data-testid={`kpi-range-${i}`}
            >{t(rg.key)}</button>
          ))}
        </div>
        {/* Показатели за период читаются одинаково на всех экранах:
            «из записей, СОЗДАННЫХ за период». Без этой подписи цифры
            выглядят как «закрыто/зачислено за период», а это другое
            число — см. шапку KpiService.leaderboard. */}
        <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t('kpi.range.hint')}</span>
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
            <span className="bento-num">{t('kpi.label.thisRank')} · #{myRank}</span>
            <div style={{ marginTop: 'auto' }}>
              <FitNumber testId="kpi-my-sales" style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(64px, 8vw, 104px)',
                fontWeight: 500,
                letterSpacing: '-0.04em',
                lineHeight: 0.9,
                marginBottom: 16,
              }}>{fmtMoney(myRow.salesAmount, myRow.currency)}</FitNumber>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                color: 'rgba(255,255,255,0.55)',
                textTransform: 'uppercase',
              }}>{t('kpi.label.youSales')}</div>
              {/* Валютный остаток периода. Без этой строки «твои продажи»
                  молча теряют валютную сделку и выглядят заниженными —
                  см. блок «ВАЛЮТА» в KpiService.leaderboard. */}
              {nonTjsLine(myRow) && (
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.06em',
                  color: 'rgba(255,255,255,0.45)',
                  marginTop: 8,
                }}>{t('kpi.label.nonTjs')}: {nonTjsLine(myRow)}</div>
              )}
            </div>
          </div>
          <KpiBento eyebrow={t('kpi.col.conversion').toUpperCase()} label={t('kpi.col.conversion')} value={`${myRow.conversionRate}%`} accent />
          <KpiBento eyebrow={t('kpi.col.enrolled').toUpperCase()} label={t('kpi.col.enrolled')} value={String(myRow.applicationsEnrolled)} />
          <KpiBento eyebrow={t('kpi.col.students').toUpperCase()} label={t('kpi.col.students')} value={String(myRow.studentsCount)} span="span-3" />
        </motion.div>
      )}

      {/* Бонус за месяц: сколько набрано и сколько осталось до следующей ставки. */}
      {!isElevated(me) && myRow?.bonusProgress && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-body">
            <BonusProgress p={myRow.bonusProgress} testId="kpi-my-bonus" />
          </div>
        </div>
      )}

      {/* Top performer banner for ADMIN */}
      {isElevated(me) && top && (
        <motion.div
          className="card kpi-top-card"
          data-testid="kpi-top"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            background: 'linear-gradient(135deg, var(--text), var(--primary-darker))',
            color: 'white',
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
          }}>{t('kpi.label.topPerformer')}</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 32, flexWrap: 'wrap' }}>
            <div>
              <div className="kpi-top-name" data-testid="kpi-top-name">{top.fullName}</div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'rgba(255,255,255,0.55)',
                letterSpacing: '0.08em',
              }}>{roleLabel(top.role)}</div>
            </div>
            <div className="kpi-top-sum">
              <FitNumber testId="kpi-top-sales" style={{
                fontFamily: 'var(--font-display)',
                fontSize: 64,
                fontWeight: 500,
                letterSpacing: '-0.04em',
                lineHeight: 1,
                color: 'var(--primary-light)',
              }}>{fmtMoney(top.salesAmount, top.currency)}</FitNumber>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'rgba(255,255,255,0.55)',
                letterSpacing: '0.10em',
                marginTop: 6,
              }}>{t('kpi.col.enrolled').toUpperCase()} {top.applicationsEnrolled} · {t('kpi.col.conversion').toUpperCase()} {top.conversionRate}%</div>
              {nonTjsLine(top) && (
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'rgba(255,255,255,0.45)',
                  letterSpacing: '0.06em',
                  marginTop: 4,
                }}>{t('kpi.label.nonTjs')}: {nonTjsLine(top)}</div>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {rows.length > 0 && <SortSelect sort={sort} />}
      <div className="card" style={{ padding: 0 }}>
        {/* На телефоне строка — компактная карточка: место, имя, конверсия и
            продажи (kpi-table в index.css); остальные цифры — в окне подробностей. */}
        <table className="table kpi-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} className="empty">{t('kpi.empty')}</td></tr>
            )}
            {sort.sorted.map((r, i) => {
              const isMe = r.id === me?.id;
              const rank = rankOf.get(r.id) ?? i;
              return (
                <tr
                  key={r.id}
                  data-testid={`kpi-row-${i}`}
                  className={`kpi-row ${canOpenAll || isMe ? 'kpi-row-clickable' : 'kpi-row-static'}`}
                  style={isMe ? { background: 'var(--primary-soft)' } : undefined}
                  {...(canOpenAll || isMe
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        title: t('kpi.details.open'),
                        onClick: () => setDetailsId(r.id),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setDetailsId(r.id);
                          }
                        },
                      }
                    : {})}
                >
                  <td className={`kpi-c-rank${rank < 3 ? ' is-medal' : ''}`} style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 500,
                    fontSize: 18,
                    letterSpacing: '-0.02em',
                    color: rank < 3 ? 'var(--primary-dark)' : 'var(--text-light)',
                  }}>
                    {rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : `#${rank + 1}`}
                  </td>
                  <td className="kpi-c-who">
                    <div className="kpi-name" style={{ fontWeight: 500 }}>{r.fullName} {isMe && <span className="kpi-you" style={{ fontFamily: 'Times New Roman, Georgia, serif', fontStyle: 'italic', color: 'var(--primary-dark)' }}>{t('kpi.label.itsYou')}</span>}</div>
                    <div className="kpi-role" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-light)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      {roleLabel(r.role)}
                    </div>
                  </td>
                  <td className="kpi-c-leads">{r.applicationsAssigned}</td>
                  <td className="kpi-c-enrolled" style={{ color: 'var(--primary-dark)' }}>{r.applicationsEnrolled}</td>
                  <td className="kpi-c-conv">
                    <span
                      className={`badge ${r.conversionRate >= 50 ? 'badge-success' : r.conversionRate >= 25 ? 'badge-warning' : 'badge-gray'}`}
                      title={t('kpi.col.conversion')}
                      data-testid="kpi-conv"
                    >
                      {r.conversionRate}%
                    </span>
                  </td>
                  <td className="kpi-c-students">{r.studentsCount}</td>
                  <td className="kpi-c-sales" style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 500,
                    letterSpacing: '-0.01em',
                    color: 'var(--primary-dark)',
                  }}>
                    {/* Размер — переменной: на телефоне сумма крупнее (index.css). */}
                    <FitNumber testId="kpi-sales" style={{ fontSize: 'var(--kpi-sales-fs, 16px)' }}>{fmtMoney(r.salesAmount, r.currency)}</FitNumber>
                    {(r.otherIncome ?? 0) > 0 && (
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-soft)' }} data-testid="kpi-other-income">
                        {t('sales.otherIncome')}: {fmtMoney(r.otherIncome!, r.currency)}
                      </div>
                    )}
                    {nonTjsLine(r) && (
                      <div style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        fontWeight: 400,
                        letterSpacing: '0.04em',
                        color: 'var(--text-light)',
                      }}>+ {nonTjsLine(r)}</div>
                    )}
                  </td>
                  <td className="kpi-c-bonus" data-label={t('kpi.col.bonusMonth')}>
                    {r.bonusProgress ? <BonusProgress p={r.bonusProgress} variant="compact" testId="kpi-bonus" /> : '—'}
                  </td>
                  <td className="kpi-c-tasks" style={{ fontSize: 13, color: 'var(--text-soft)' }}>
                    <span style={{ color: 'var(--text)' }}>{r.tasksDone}</span> / {r.tasksDone + r.tasksOpen}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <AnimatePresence>
        {detailsId && rows.find((r) => r.id === detailsId) && (
          <KpiDetailsModal
            key={detailsId}
            row={rows.find((r) => r.id === detailsId)!}
            params={params}
            rangeLabel={t(range.key)}
            onClose={() => setDetailsId(null)}
          />
        )}
      </AnimatePresence>
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
        <FitNumber style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(40px, 5vw, 64px)',
          fontWeight: 500,
          letterSpacing: '-0.04em',
          lineHeight: 0.9,
          marginBottom: 12,
        }}>{value}</FitNumber>
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
