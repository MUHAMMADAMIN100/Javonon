import { Fragment, useEffect, useState } from 'react';
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
import { bandRangeLabel } from '../lib/bonusBands';
import CrmDatePicker from '../components/CrmDatePicker';

// Отказы бэкенда при фиксации расчёта приходят как 400 с русским текстом
// (Nest не отдаёт машиночитаемых кодов ошибок в этом модуле). Сопоставляем
// известные тексты со своими ключами, чтобы таджикский интерфейс не
// показывал русскую строку. Незнакомое сообщение показываем как есть —
// оно всё равно информативнее общего «Ошибка».
const SALARY_ERROR_KEYS: Record<string, string> = {
  'Зарплата за этот период уже начислена': 'salary.error.duplicatePeriod',
  'Расчёт не сохранён из-за одновременного запроса. Повторите попытку': 'salary.error.concurrent',
};

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}
function fmtMin(min: number) {
  if (min <= 0) return '0ч';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
}
/**
 * Колонок в журнале выплат: сотрудник, период, часы, приход, база, бонус,
 * KPI, штрафы, к выплате, статус, действия. Держим константой — colSpan
 * пустой строки и раскрытой расшифровки обязан совпадать с шапкой.
 */
const HISTORY_COLUMNS = 11;

/**
 * Есть ли у записи сохранённый снимок расшифровки комиссии.
 *
 * Признак — bonusBandKey. Проверять bonusBandMax нельзя: у верхней полосы
 * потолка нет, там null — легальное значение, а не «снимка нет».
 * У записей, созданных до появления снимка, полей нет вовсе; их НЕ
 * пересчитывают, поэтому расшифровку для них просто не показываем.
 */
function hasBonusSnapshot(r: SalaryRecord): boolean {
  return typeof r.bonusBandKey === 'string' && r.bonusBandKey.length > 0;
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
  // Раскрытая расшифровка бонуса в журнале — одна за раз.
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
    onError: (e: any) => {
      const raw = e?.response?.data?.message;
      const key = typeof raw === 'string' ? SALARY_ERROR_KEYS[raw] : undefined;
      toast(key ? t(key) : raw || 'Ошибка', 'error');
    },
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
    // Первая линия против двойного начисления — не пускаем второй запрос,
    // пока первый в полёте (двойной клик по «Зафиксировать»). Настоящие
    // гарды на бэкенде: SERIALIZABLE-транзакция + уникальный индекс
    // SalaryRecord(userId, periodStart); здесь — чтобы бухгалтер не ловил
    // 400 там, где достаточно не отправлять запрос.
    if (createMut.isPending) return;
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
        <span className="crm-section-eyebrow">{t('eyebrow.payroll09')}</span>
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
        }}>{t('eyebrow.calculatorPreview')}</div>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginBottom: 24,
        }}>
          {t('salary.calc.title')}
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div className="form-group">
            <label>{t('salary.field.employee')}</label>
            <select className="crm-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName} · {displayRoleLabel(u as any)}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>{t('salary.field.periodFrom')}</label>
            <CrmDatePicker className="crm-input" value={start} onChange={(v) => setRange({ start: v, end })} />
          </div>
          <div className="form-group">
            <label>{t('salary.field.periodTo')}</label>
            <CrmDatePicker className="crm-input" value={end} onChange={(v) => setRange({ start, end: v })} />
          </div>
          <div className="form-group">
            <label>{t('salary.field.kpiBonus')}</label>
            <input className="crm-input" type="number" step="0.01" value={kpiBonus} onChange={(e) => setKpiBonus(e.target.value)} placeholder="0" />
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
                sub={`${t('salary.bonus.volume')}: ${fmtMoney(preview.salesAmount)}`}
              />
              <PreviewCell label="KPI" value={fmtMoney(preview.kpiBonus)} />
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
            <BonusBreakdown preview={preview} />

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
                  fontSize: 'clamp(28px, 10vw, 56px)',
                  fontWeight: 500,
                  letterSpacing: '-0.04em',
                  lineHeight: 1,
                  color: 'var(--primary-dark)',
                  wordBreak: 'break-word',
                  overflowWrap: 'anywhere',
                }}>{fmtMoney(preview.netAmount, preview.currency)}</div>
              </div>
              <div className="salary-confirm-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  className="crm-input"
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={t('salary.field.commentPlaceholder')}
                  style={{
                    flex: '1 1 200px',
                    minWidth: 0,
                  }}
                />
                <button
                  className="btn btn-primary"
                  onClick={onCreate}
                  disabled={createMut.isPending}
                  style={{ flex: '0 1 auto', minWidth: 0 }}
                >
                  <Icon name="bookmark_add" size={18} />{' '}
                  {createMut.isPending ? t('salary.saving') : t('salary.new')}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* История расчётов */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">{t('eyebrow.historyAllRecords')}</span>
        <h2 className="crm-section-title">{t('salary.history')}</h2>
      </div>

      {/* Строка журнала обязана СХОДИТЬСЯ: база + бонус + KPI − штрафы =
          к выплате. Раньше KPI молча складывался с бонусом в колонке
          «Бонус», а колонки штрафов не было вовсе — сохранённая строка
          читалась как «База 3 000 · Бонус 12 500 · К выплате 14 500» и
          выглядела арифметически неверной ровно в тот момент, когда её
          показывают учредителю в споре. Колонки разведены, штрафы
          добавлены, а расшифровка бонуса раскрывается из снимка,
          сохранённого при создании записи (SalaryRecord.bonus* в
          api/salary.ts) — то есть переживает выплату, в отличие от
          live-превью сверху. */}
      <div className="card" style={{ padding: 0 }}>
        {/* Колонок стало 11 — на узком экране таблица должна скроллиться
            внутри карточки, а не растягивать страницу. */}
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('salary.field.employee')}</th>
                <th>{t('common.period') !== 'common.period' ? t('common.period') : 'Период'}</th>
                <th>{t('salary.cell.hours')}</th>
                <th>{t('finance.summary.income')}</th>
                <th>{t('salary.cell.base')}</th>
                <th>{t('salary.cell.bonus')}</th>
                <th>{t('salary.cell.kpi')}</th>
                <th>{t('salary.cell.penalties')}</th>
                <th>{t('salary.cell.net')}</th>
                <th>{t('common.status')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && (
                <tr><td colSpan={HISTORY_COLUMNS} className="empty">{t('salary.empty')}</td></tr>
              )}
              {records.map((r) => {
                const expanded = expandedId === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td style={{ fontWeight: 500 }}>{r.user?.fullName}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                        {tjFormatDate(r.periodStart)}
                        {' → '}
                        {tjFormatDate(r.periodEnd)}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(r.workedMinutes)}</td>
                      <td style={{ color: 'var(--text-soft)' }}>{fmtMoney(r.salesAmount, r.currency)}</td>
                      <td>{fmtMoney(r.baseAmount, r.currency)}</td>
                      {/* Только комиссия с продаж. KPI — отдельная колонка:
                          он назначается вручную и в споре обсуждается
                          отдельно от бонуса по полосе. */}
                      <td style={{ color: 'var(--primary-dark)' }}>+ {fmtMoney(r.bonusAmount, r.currency)}</td>
                      <td style={{ color: r.kpiBonus > 0 ? 'var(--primary-dark)' : 'var(--text-soft)' }}>
                        {r.kpiBonus > 0 ? `+ ${fmtMoney(r.kpiBonus, r.currency)}` : fmtMoney(0, r.currency)}
                      </td>
                      {/* Штрафы вычитаются из net — без этой колонки строка
                          не сходилась. Значения берём из записи, ничего не
                          пересчитываем. */}
                      <td style={{ color: r.penalties > 0 ? 'var(--danger)' : 'var(--text-soft)' }}>
                        {r.penalties > 0 ? `− ${fmtMoney(r.penalties, r.currency)}` : fmtMoney(0, r.currency)}
                      </td>
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
                          {hasBonusSnapshot(r) && (
                            <button
                              className="btn btn-sm btn-secondary"
                              aria-expanded={expanded}
                              title={t('salary.bonus.title')}
                              aria-label={t('salary.bonus.title')}
                              onClick={() => setExpandedId(expanded ? null : r.id)}
                            >
                              <Icon name={expanded ? 'expand_less' : 'expand_more'} size={14} />
                            </button>
                          )}
                          {r.status === 'DRAFT' && (
                            <button className="btn btn-sm btn-secondary" onClick={() => onPay(r)}>
                              <Icon name="paid" size={14} /> {t('salary.pay')}
                            </button>
                          )}
                          {/* Удалять можно только черновик. Удаление PAID-записи
                              вернуло бы месячную комиссию в «к начислению»
                              (bonusAlreadyPaid) и оставило бы расходную транзакцию
                              сиротой — бэк такой DELETE тоже отклоняет. */}
                          {r.status === 'DRAFT' && (
                            <button className="btn btn-sm btn-danger" onClick={() => onDelete(r)}>
                              <Icon name="delete" size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={HISTORY_COLUMNS} style={{ background: 'var(--bg-soft)', padding: 0 }}>
                          <SavedBonusBreakdown record={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/**
 * Расшифровка комиссии: объём → полоса → ставка → сумма.
 *
 * Правило новое и непривычное (полоса, а не проценты «с каждой продажи»),
 * поэтому менеджер должен уметь проверить свою цифру не спрашивая
 * бухгалтерию. Сетку берём из ответа бэка (preview.bonusBands), а не из
 * константы на фронте — один источник правды.
 *
 * Объём считается за КАЛЕНДАРНЫЙ МЕСЯЦ, а фильтр периода сверху может быть
 * любым — про это пишем прямо, иначе «продажи 200 000» при выбранной
 * половине месяца выглядят как ошибка.
 */
function BonusBreakdown({ preview }: { preview: SalaryPreview }) {
  const { t } = useT();
  const band = preview.bonusBand;
  const bands = preview.bonusBands ?? [];
  const volume = preview.bonusVolume ?? preview.salesAmount;
  const personal = preview.bonusSource === 'PERSONAL';
  const nonTjs = preview.nonTjsSales && Object.keys(preview.nonTjsSales).length > 0
    ? preview.nonTjsSales
    : null;

  // Старый бэк (или ошибка) — не рисуем пустую рамку.
  if (!band) return null;

  const monthLabel = preview.bonusPeriodStart
    ? `${tjFormatDate(preview.bonusPeriodStart)} — ${tjFormatDate(preview.bonusPeriodEnd || preview.bonusPeriodStart)}`
    : null;

  return (
    <div style={{
      marginTop: 4,
      marginBottom: 24,
      padding: 18,
      borderRadius: 14,
      border: '1px solid var(--border-soft)',
      background: 'var(--bg)',
    }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--text-soft)',
        marginBottom: 14,
      }}>
        {t('salary.bonus.title')}
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        marginBottom: 10,
      }}>
        <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.volume')}</span>
        <b>{fmtMoney(volume)}</b>
        <span style={{ color: 'var(--text-light)' }}>→</span>
        <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.band')}</span>
        <b>{bandRangeLabel(band.minAmount, band.maxAmount)}</b>
        <span style={{ color: 'var(--text-light)' }}>→</span>
        <b>{preview.bonusPercent}%</b>
        <span style={{ color: 'var(--text-light)' }}>→</span>
        <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--primary-dark)' }}>
          {fmtMoney(preview.bonusMonthTotal ?? preview.bonusAmount)}
        </b>
      </div>

      {/* Уже начисленное за месяц: без этой строки «объём 200 000 → 6% →
          12 000», а к выплате 0, выглядит как ошибка расчёта. */}
      {!!preview.bonusAlreadyPaid && (
        <div style={{
          display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 10,
        }}>
          <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.alreadyPaid')}</span>
          <b>− {fmtMoney(preview.bonusAlreadyPaid)}</b>
          <span style={{ color: 'var(--text-light)' }}>→</span>
          <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.due')}</span>
          <b>{fmtMoney(preview.bonusAmount)}</b>
        </div>
      )}

      {/* Пустой месяц. Экран по умолчанию открывает ТЕКУЩИЙ месяц, и 1-го
          числа объём законно равен нулю — без этой строки «0 → 4% → 0»
          читается как «система не считает», а не как «месяц ещё пустой». */}
      {volume === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-soft)', marginBottom: 10 }}>
          {t('salary.bonus.emptyMonth')}
        </div>
      )}

      {monthLabel && (
        <div style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 10 }}>
          {t('salary.bonus.periodNote')} · {monthLabel}
        </div>
      )}

      {personal && (
        <div style={{ fontSize: 11, color: 'var(--warning, #b45309)', marginBottom: 10 }}>
          {t('salary.bonus.personal')}
        </div>
      )}

      {/* Сетка целиком: менеджеру важно видеть, сколько осталось до
          следующей полосы — весь объём тогда пойдёт по большей ставке. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: nonTjs || preview.manualSalesAmount ? 10 : 0 }}>
        {bands.map((b) => {
          const current = !personal && b.key === band.key;
          return (
            <div
              key={b.key}
              style={{
                padding: '5px 10px',
                borderRadius: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                border: `1px solid ${current ? 'var(--primary-dark)' : 'var(--border-soft)'}`,
                background: current ? 'var(--primary-soft, var(--bg-soft))' : 'transparent',
                color: current ? 'var(--primary-dark)' : 'var(--text-soft)',
                fontWeight: current ? 600 : 400,
              }}
            >
              {bandRangeLabel(b.minAmount, b.maxAmount)} · {b.percent}%
            </div>
          );
        })}
      </div>

      {!!preview.manualSalesAmount && (
        <div style={{ fontSize: 11, color: 'var(--text-light)' }}>
          {t('salary.bonus.manualExcluded')}: {fmtMoney(preview.manualSalesAmount)}
        </div>
      )}
      {nonTjs && (
        <div style={{ fontSize: 11, color: 'var(--text-light)' }}>
          {t('salary.bonus.nonTjs')}: {Object.entries(nonTjs)
            .map(([cur, sum]) => fmtMoney(sum, cur))
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

/**
 * Расшифровка комиссии СОХРАНЁННОЙ записи: объём → полоса → ставка →
 * комиссия за месяц → минус уже начисленное → к начислению.
 *
 * Отличается от BonusBreakdown выше принципиально: та рисует live-превью
 * (пересчёт по текущим данным), эта — СНИМОК, записанный в SalaryRecord в
 * момент фиксации расчёта. Именно снимок и нужен в споре: сетка полос
 * живёт в коде и может смениться, платежи могли быть отменены — пересчёт
 * через полгода дал бы другое число, а объяснять надо то, что выплачено.
 * Поэтому здесь НЕТ ни одного обращения к preview и ни одного вычисления
 * поверх записи: печатаем ровно то, что лежит в строке.
 *
 * Сетку полос целиком (как в превью) намеренно не показываем: на экране
 * она была бы сегодняшней, а запись — прошлогодней. Показываем только ту
 * полосу, по которой реально посчитали, с её тогдашними границами.
 */
function SavedBonusBreakdown({ record }: { record: SalaryRecord }) {
  const { t } = useT();
  const cur = record.currency;
  const volume = record.bonusVolume ?? 0;
  const percent = record.bonusPercent ?? 0;
  const monthTotal = record.bonusMonthTotal ?? record.bonusAmount;
  const alreadyPaid = record.bonusAlreadyPaid ?? 0;
  const personal = record.bonusSource === 'PERSONAL';

  return (
    <div style={{ padding: '16px 18px' }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--text-soft)',
        marginBottom: 12,
      }}>
        {t('salary.bonus.title')}
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        marginBottom: 10,
      }}>
        <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.volume')}</span>
        <b>{fmtMoney(volume, cur)}</b>
        <span style={{ color: 'var(--text-light)' }}>→</span>
        <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.band')}</span>
        <b>{bandRangeLabel(record.bonusBandMin ?? 0, record.bonusBandMax ?? null)}</b>
        <span style={{ color: 'var(--text-light)' }}>→</span>
        <b>{percent}%</b>
        <span style={{ color: 'var(--text-light)' }}>→</span>
        <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--primary-dark)' }}>
          {fmtMoney(monthTotal, cur)}
        </b>
      </div>

      {/* Без этой строки «объём 200 000 → 6% → 12 000», а в колонке бонуса
          0, выглядит как ошибка расчёта: месячная комиссия не платится
          дважды, вторая запись месяца доплачивает только разницу. */}
      {alreadyPaid > 0 && (
        <div style={{
          display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 10,
        }}>
          <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.alreadyPaid')}</span>
          <b>− {fmtMoney(alreadyPaid, cur)}</b>
          <span style={{ color: 'var(--text-light)' }}>→</span>
          <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.due')}</span>
          <b>{fmtMoney(record.bonusAmount, cur)}</b>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-light)' }}>
        {t('salary.bonus.periodNote')}
      </div>
      {personal && (
        <div style={{ fontSize: 11, color: 'var(--warning, #b45309)', marginTop: 6 }}>
          {t('salary.bonus.personal')}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 6 }}>
        {t('salary.bonus.snapshotNote')}
      </div>
    </div>
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
