import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  SalaryRecord,
  SalaryPreview,
  listSalaries,
  previewSalary,
  createSalary,
  paySalary,
  deleteSalary,
} from '../api/salary';
import { listUsers } from '../api/users';
import { ROLE_LABEL, type Role } from '../api/types';
import { displayRoleLabel } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import { tjStartOfMonthStr, tjEndOfMonthStr, tjFormatDate } from '../lib/tjTime';

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}
function fmtMin(min: number) {
  if (min <= 0) return '0ч';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
}
function defaultMonthRange() {
  // Границы месяца — в Asia/Dushanbe, а не в UTC и не в TZ браузера.
  // Иначе у пользователя в РФ месяц мог открываться «с 30-го» из-за
  // toISOString → UTC.
  return { start: tjStartOfMonthStr(), end: tjEndOfMonthStr() };
}

export default function Salary() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const [userId, setUserId] = useState<string>('');
  const [{ start, end }, setRange] = useState(defaultMonthRange());
  const [kpiBonus, setKpiBonus] = useState('0');
  const [comment, setComment] = useState('');

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
  });
  const users = usersQuery.data ?? [];

  // Auto-select первого пользователя при загрузке.
  useEffect(() => {
    if (!userId && users.length) setUserId(users[0].id);
  }, [users, userId]);

  const recordsKey = keys.salary.list();
  const recordsQuery = useQuery({
    queryKey: recordsKey,
    queryFn: () => listSalaries(),
  });
  const records: SalaryRecord[] = recordsQuery.data ?? [];

  // Live-preview через useQuery (кешируется по параметрам, мгновенно при возврате).
  const previewQuery = useQuery<SalaryPreview>({
    queryKey: keys.salary.preview({ userId, start, end, kpiBonus }),
    queryFn: () => previewSalary({ userId, periodStart: start, periodEnd: end, kpiBonus: parseFloat(kpiBonus) || 0 }),
    enabled: !!userId && !!start && !!end,
  });
  const preview = previewQuery.data ?? null;

  const createMut = useInvalidatingMutation({
    mutationFn: createSalary,
    invalidate: [keys.salary.all],
    onSuccess: () => {
      toast('Расчёт сохранён', 'success');
      setComment('');
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  // Pay — оптимистично переключаем status DRAFT → PAID + paidAt.
  const payMut = useOptimisticMutation<SalaryRecord, string, SalaryRecord[]>({
    mutationFn: paySalary,
    queryKey: recordsKey,
    applyOptimistic: (cur, id) => optimistic.updateById(cur, id, {
      status: 'PAID',
      paidAt: new Date().toISOString(),
    } as Partial<SalaryRecord>),
    invalidateAlso: [keys.finance.all],
    onSuccess: () => toast('Зарплата выплачена', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const deleteMut = useOptimisticMutation<unknown, string, SalaryRecord[]>({
    mutationFn: deleteSalary,
    queryKey: recordsKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    onSuccess: () => toast('Удалено', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onCreate = () => {
    if (!userId) return;
    createMut.mutate({
      userId,
      periodStart: start,
      periodEnd: end,
      kpiBonus: parseFloat(kpiBonus) || 0,
      comment: comment.trim() || undefined,
    });
  };

  const onPay = async (r: SalaryRecord) => {
    const ok = await confirm({
      title: t('salary.confirmPay'),
      message: `${r.user?.fullName}: ${fmtMoney(r.netAmount, r.currency)} — будет создана расходная транзакция.`,
      confirmText: t('salary.pay'),
    });
    if (!ok) return;
    payMut.mutate(r.id);
  };

  const onDelete = async (r: SalaryRecord) => {
    const ok = await confirm({
      title: t('common.delete') + '?',
      message: `${r.user?.fullName}: ${fmtMoney(r.netAmount)}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    deleteMut.mutate(r.id);
  };

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">PAYROLL · 09</span>
        <h2 className="crm-section-title">{t('salary.title')}</h2>
      </div>

      {/* Калькулятор */}
      <div className="card" style={{ padding: 28, marginBottom: 24 }}>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.16em',
          color: 'var(--primary-dark)',
          marginBottom: 6,
        }}>CALCULATOR · LIVE PREVIEW</div>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginBottom: 24,
        }}>
          Расчёт <em style={{
            fontFamily: 'Times New Roman, Georgia, serif',
            fontWeight: 400,
            color: 'var(--primary-dark)',
          }}>за период.</em>
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div className="form-group">
            <label>{t('salary.field.employee')}</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName} · {displayRoleLabel(u as any)}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>{t('salary.field.periodFrom')}</label>
            <input type="date" value={start} onChange={(e) => setRange({ start: e.target.value, end })} />
          </div>
          <div className="form-group">
            <label>{t('salary.field.periodTo')}</label>
            <input type="date" value={end} onChange={(e) => setRange({ start, end: e.target.value })} />
          </div>
          <div className="form-group">
            <label>{t('salary.field.kpiBonus')}</label>
            <input type="number" step="0.01" value={kpiBonus} onChange={(e) => setKpiBonus(e.target.value)} placeholder="0" />
          </div>
        </div>

        {preview && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              marginTop: 24,
              padding: 24,
              background: 'var(--bg-soft)',
              borderRadius: 18,
              border: '1px solid var(--border-soft)',
            }}
          >
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 24,
              marginBottom: 24,
            }}>
              <PreviewCell label={t('salary.cell.hours')} value={fmtMin(preview.workedMinutes)} />
              <PreviewCell label={t('salary.cell.late')} value={preview.lateMinutes > 0 ? `${preview.lateMinutes}м` : '—'} />
              <PreviewCell label={t('salary.cell.base')} value={fmtMoney(preview.baseAmount)} />
              <PreviewCell
                label={`${t('salary.cell.bonus')} · ${preview.bonusPercent}%`}
                value={fmtMoney(preview.bonusAmount)}
                sub={
                  preview.bonusTierId
                    ? `Этап${preview.bonusTierComment ? ` «${preview.bonusTierComment}»` : ''} · ${fmtMoney(preview.salesAmount)}`
                    : `Продажи: ${fmtMoney(preview.salesAmount)}`
                }
              />
              <PreviewCell label="KPI" value={fmtMoney(preview.kpiBonus)} />
              <PreviewCell
                label={`${t('salary.cell.overtime')}${preview.overtimeMultiplier ? ` · ×${preview.overtimeMultiplier}` : ''}`}
                value={preview.overtimePay ? `+ ${fmtMoney(preview.overtimePay)}` : '—'}
                sub={preview.overtimeMinutes ? `${preview.overtimeMinutes} мин` : undefined}
              />
              <PreviewCell
                label={t('salary.cell.penalties')}
                value={`− ${fmtMoney(preview.penalties)}`}
                negative={preview.penalties > 0}
                sub={
                  preview.penaltiesPending || preview.penaltiesExcused
                    ? [
                        preview.penaltiesPending
                          ? `${t('salary.pendingReview')}: ${fmtMoney(preview.penaltiesPending)}`
                          : null,
                        preview.penaltiesExcused
                          ? `${t('salary.excused')}: ${fmtMoney(preview.penaltiesExcused)}`
                          : null,
                      ].filter(Boolean).join(' · ')
                    : undefined
                }
              />
            </div>
            <div style={{
              borderTop: '1px solid var(--border)',
              paddingTop: 24,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              gap: 16,
              flexWrap: 'wrap',
            }}>
              <div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.16em',
                  color: 'var(--text-soft)',
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}>{t('salary.cell.net').toUpperCase()}</div>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 56,
                  fontWeight: 500,
                  letterSpacing: '-0.04em',
                  lineHeight: 1,
                  color: 'var(--primary-dark)',
                }}>{fmtMoney(preview.netAmount, preview.currency)}</div>
              </div>
              <div className="salary-confirm-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={t('salary.field.commentPlaceholder')}
                  style={{
                    padding: '12px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    fontSize: 14,
                    flex: '1 1 200px',
                    minWidth: 0,
                  }}
                />
                <button className="btn btn-primary" onClick={onCreate} style={{ flex: '0 1 auto', minWidth: 0 }}>
                  <Icon name="bookmark_add" size={18} /> {t('salary.new')}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* История расчётов */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">HISTORY · ALL RECORDS</span>
        <h2 className="crm-section-title">{t('salary.history')}</h2>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>{t('salary.field.employee')}</th>
              <th>{t('common.period') !== 'common.period' ? t('common.period') : 'Период'}</th>
              <th>{t('salary.cell.hours')}</th>
              <th>{t('finance.summary.income')}</th>
              <th>{t('salary.cell.base')}</th>
              <th>{t('salary.cell.bonus')}</th>
              <th>{t('salary.cell.net')}</th>
              <th>{t('common.status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr><td colSpan={9} className="empty">{t('salary.empty')}</td></tr>
            )}
            {records.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 500 }}>{r.user?.fullName}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {tjFormatDate(r.periodStart)}
                  {' → '}
                  {tjFormatDate(r.periodEnd)}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(r.workedMinutes)}</td>
                <td style={{ color: 'var(--text-soft)' }}>{fmtMoney(r.salesAmount, r.currency)}</td>
                <td>{fmtMoney(r.baseAmount, r.currency)}</td>
                <td style={{ color: 'var(--primary-dark)' }}>+ {fmtMoney(r.bonusAmount + r.kpiBonus, r.currency)}</td>
                <td style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 500,
                  fontSize: 17,
                }}>{fmtMoney(r.netAmount, r.currency)}</td>
                <td>
                  {r.status === 'PAID'
                    ? <span className="badge badge-success">{t('salary.status.PAID')}</span>
                    : <span className="badge badge-warning">{t('salary.status.DRAFT')}</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {r.status === 'DRAFT' && (
                      <button className="btn btn-sm btn-secondary" onClick={() => onPay(r)}>
                        <Icon name="paid" size={14} /> {t('salary.pay')}
                      </button>
                    )}
                    <button className="btn btn-sm btn-danger" onClick={() => onDelete(r)}>
                      <Icon name="delete" size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PreviewCell({ label, value, sub, negative }: { label: string; value: string; sub?: string; negative?: boolean }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--text-soft)',
        marginBottom: 6,
      }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: '-0.02em',
        color: negative ? 'var(--danger)' : 'var(--text)',
      }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-light)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
