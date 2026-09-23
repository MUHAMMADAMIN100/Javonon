import { Fragment, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  SalaryRecord,
  SalaryPreview,
  SalaryRosterRow,
  listSalaries,
  previewSalary,
  previewAllSalaries,
  createSalary,
  paySalary,
  deleteSalary,
} from '../api/salary';
import { ROLE_LABEL, type Role } from '../api/types';
import SearchField from '../components/SearchField';
import Loading from '../components/Loading';
import { displayRoleLabel } from '../lib/roles';
import { tr, useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import { tjStartOfMonthStr, tjEndOfMonthStr, tjFormatDate } from '../lib/tjTime';
import { bandRangeLabel } from '../lib/bonusBands';
import CrmDatePicker from '../components/CrmDatePicker';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';

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
  if (min <= 0) return `0${tr('time.hShort')}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}${tr('time.hShort')} ${m}${tr('time.m')}` : `${h}${tr('time.hShort')}`;
}
/**
 * Колонок в журнале выплат: сотрудник, период, часы, приход, база, бонус,
 * KPI, штрафы, к выплате, статус, действия. Держим константой — colSpan
 * пустой строки и раскрытой расшифровки обязан совпадать с шапкой.
 */
const HISTORY_COLUMNS = 11;
/** Колонок в таблице за период: 9 сортируемых + стрелка раскрытия. */
const ROSTER_COLUMNS = 10;

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
  const qc = useQueryClient();
  // Период — в адресе страницы (?from=&to=): ссылка и обновление его сохраняют.
  const [params, setParams] = useSearchParams();
  const month = defaultMonthRange();
  const start = params.get('from') || month.start;
  const end = params.get('to') || month.end;
  const setRange = (next: { start: string; end: string }) => {
    setParams((cur) => {
      const p2 = new URLSearchParams(cur);
      p2.set('from', next.start);
      p2.set('to', next.end);
      return p2;
    }, { replace: true });
  };
  const [search, setSearch] = useState('');
  /** Раскрытая строка таблицы — подробный расчёт по сотруднику. */
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  /** KPI-бонус и комментарий вводятся по сотруднику, до фиксации. */
  const [kpiByUser, setKpiByUser] = useState<Record<string, string>>({});
  const [commentByUser, setCommentByUser] = useState<Record<string, string>>({});
  /** Раскрытая расшифровка бонуса в журнале — одна за раз. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [accruing, setAccruing] = useState(false);

  // Таблица за период: все работающие сотрудники одним запросом.
  const rosterKey = keys.salary.previewAll({ start, end });
  const rosterQuery = useQuery({
    queryKey: rosterKey,
    queryFn: () => previewAllSalaries({ periodStart: start, periodEnd: end }),
    enabled: !!start && !!end,
  });
  const rows: SalaryRosterRow[] = rosterQuery.data?.rows ?? [];
  /** KPI: у начисленной строки — из записи, иначе то, что вписали в форме. */
  const kpiOf = (r: SalaryRosterRow) =>
    r.record ? r.kpiBonus : Math.max(0, parseFloat(kpiByUser[r.userId] || '') || 0);
  /** К выплате: у начисленной строки — как начислено, иначе расчёт + введённый KPI. */
  const netOf = (r: SalaryRosterRow) => (r.record ? r.netAmount : r.netAmount + kpiOf(r));

  const q = search.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.user.fullName.toLowerCase().includes(q)) : rows;
  const rosterSort = useTableSort(shown, [
    { key: 'employee', label: t('salary.field.employee'), value: (r) => r.user.fullName },
    { key: 'hours', label: t('salary.cell.hours'), type: 'number', value: (r) => r.workedMinutes },
    { key: 'late', label: t('salary.cell.late'), type: 'number', value: (r) => r.lateMinutes },
    { key: 'base', label: t('salary.cell.base'), type: 'number', value: (r) => r.baseAmount },
    { key: 'bonus', label: t('salary.cell.bonus'), type: 'number', value: (r) => r.bonusAmount },
    { key: 'kpi', label: t('salary.cell.kpi'), type: 'number', value: (r) => kpiOf(r) },
    { key: 'penalties', label: t('salary.cell.penalties'), type: 'number', value: (r) => r.penalties },
    { key: 'net', label: t('salary.cell.net'), type: 'number', value: (r) => netOf(r) },
    // По той же подписи, что в ячейке: раньше ключ был «есть запись / нет»
    // (0/1), и «Начислено» с «Выплачено» при сортировке перемешивались.
    {
      key: 'status',
      label: t('common.status'),
      value: (r) => (r.record
        ? (r.record.status === 'PAID' ? t('salary.status.PAID') : t('salary.roster.accrued'))
        : t('salary.roster.notAccrued')),
    },
  ]);
  const totals = shown.reduce(
    (acc, r) => ({
      workedMinutes: acc.workedMinutes + r.workedMinutes,
      lateMinutes: acc.lateMinutes + r.lateMinutes,
      baseAmount: acc.baseAmount + r.baseAmount,
      bonusAmount: acc.bonusAmount + r.bonusAmount,
      kpiBonus: acc.kpiBonus + kpiOf(r),
      penalties: acc.penalties + r.penalties,
      netAmount: acc.netAmount + netOf(r),
    }),
    { workedMinutes: 0, lateMinutes: 0, baseAmount: 0, bonusAmount: 0, kpiBonus: 0, penalties: 0, netAmount: 0 },
  );
  /**
   * Кому за этот период ещё не начисляли — их берёт «Начислить всем».
   * Тех, кому платить нечего (нет ни оклада, ни ставки, и к выплате ноль),
   * массовое начисление пропускает: пустые записи только засоряют журнал.
   * Вручную, из раскрытой строки, такую запись создать по-прежнему можно.
   */
  const pending = shown.filter((r) => !r.record && (r.hasRate || netOf(r) !== 0));

  const recordsKey = keys.salary.list();
  const recordsQuery = useQuery({
    queryKey: recordsKey,
    queryFn: () => listSalaries(),
  });
  const records: SalaryRecord[] = recordsQuery.data ?? [];
  const periodLabel = t('common.period') !== 'common.period' ? t('common.period') : t('common.periodFallback');
  const sort = useTableSort(records, [
    { key: 'employee', label: t('salary.field.employee'), value: (r) => r.user?.fullName },
    { key: 'period', label: periodLabel, type: 'date', value: (r) => r.periodStart },
    { key: 'hours', label: t('salary.cell.hours'), type: 'number', value: (r) => r.workedMinutes },
    { key: 'income', label: t('finance.summary.income'), type: 'number', value: (r) => r.salesAmount },
    { key: 'base', label: t('salary.cell.base'), type: 'number', value: (r) => r.baseAmount },
    { key: 'bonus', label: t('salary.cell.bonus'), type: 'number', value: (r) => r.bonusAmount },
    { key: 'kpi', label: t('salary.cell.kpi'), type: 'number', value: (r) => r.kpiBonus },
    { key: 'penalties', label: t('salary.cell.penalties'), type: 'number', value: (r) => r.penalties },
    { key: 'net', label: t('salary.cell.net'), type: 'number', value: (r) => r.netAmount },
    {
      key: 'status',
      label: t('common.status'),
      value: (r) => (r.status === 'PAID' ? t('salary.status.PAID') : t('salary.status.DRAFT')),
    },
  ]);
  /** Итог журнала — по тем строкам, что показаны сейчас. */
  const historyTotals = records.reduce(
    (acc, r) => ({
      workedMinutes: acc.workedMinutes + r.workedMinutes,
      salesAmount: acc.salesAmount + r.salesAmount,
      baseAmount: acc.baseAmount + r.baseAmount,
      bonusAmount: acc.bonusAmount + r.bonusAmount,
      kpiBonus: acc.kpiBonus + r.kpiBonus,
      penalties: acc.penalties + r.penalties,
      netAmount: acc.netAmount + r.netAmount,
    }),
    { workedMinutes: 0, salesAmount: 0, baseAmount: 0, bonusAmount: 0, kpiBonus: 0, penalties: 0, netAmount: 0 },
  );

  const createMut = useInvalidatingMutation({
    mutationFn: createSalary,
    invalidate: [keys.salary.all],
    onSuccess: (_r, vars: any) => {
      toast(t('salary.toast.saved'), 'success');
      setCommentByUser((c) => ({ ...c, [vars.userId]: '' }));
    },
    onError: (e: any) => {
      const raw = e?.response?.data?.message;
      const key = typeof raw === 'string' ? SALARY_ERROR_KEYS[raw] : undefined;
      toast(key ? t(key) : raw || t('toast.error'), 'error');
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
    invalidateAlso: [keys.finance.all, keys.salary.all],
    onSuccess: () => toast(t('salary.toast.paid'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteMut = useOptimisticMutation<unknown, string, SalaryRecord[]>({
    mutationFn: deleteSalary,
    queryKey: recordsKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.salary.all],
    onSuccess: () => toast(t('toast.deleted'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onCreate = (userId: string) => {
    // Первая линия против двойного начисления — не пускаем второй запрос,
    // пока первый в полёте (двойной клик по «Зафиксировать»). Настоящие
    // гарды на бэкенде: SERIALIZABLE-транзакция + уникальный индекс
    // SalaryRecord(userId, periodStart); здесь — чтобы бухгалтер не ловил
    // 400 там, где достаточно не отправлять запрос.
    if (createMut.isPending || accruing) return;
    const row = rows.find((r) => r.userId === userId);
    createMut.mutate({
      userId,
      periodStart: start,
      periodEnd: end,
      kpiBonus: row ? kpiOf(row) : 0,
      comment: (commentByUser[userId] || '').trim() || undefined,
    });
  };

  /** Начислить всем, кому за этот период ещё не начисляли. */
  const onAccrueAll = async () => {
    if (!pending.length || accruing) return;
    const sum = pending.reduce((s2, r) => s2 + netOf(r), 0);
    const ok = await confirm({
      title: t('salary.accrueAll.title').replace('{n}', String(pending.length)),
      message: t('salary.accrueAll.text')
        .replace('{n}', String(pending.length))
        .replace('{sum}', fmtMoney(sum))
        .replace('{from}', tjFormatDate(start))
        .replace('{to}', tjFormatDate(end)),
      confirmText: t('salary.accrueAll.confirm'),
    });
    if (!ok) return;
    setAccruing(true);
    let done = 0;
    const failed: string[] = [];
    for (const r of pending) {
      try {
        await createSalary({
          userId: r.userId,
          periodStart: start,
          periodEnd: end,
          kpiBonus: kpiOf(r),
          comment: (commentByUser[r.userId] || '').trim() || undefined,
        });
        done++;
      } catch {
        failed.push(r.user.fullName);
      }
    }
    setAccruing(false);
    qc.invalidateQueries({ queryKey: keys.salary.all });
    if (failed.length) {
      toast(t('salary.accrueAll.partial').replace('{n}', String(done)).replace('{who}', failed.slice(0, 3).join(', ')), 'error');
    } else {
      toast(t('salary.accrueAll.done').replace('{n}', String(done)), 'success');
    }
  };

  const onPay = async (r: SalaryRecord) => {
    const ok = await confirm({
      title: t('salary.confirmPay'),
      message: `${r.user?.fullName}: ${fmtMoney(r.netAmount, r.currency)} — ${t('salary.payWillCreate')}`,
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
      {/* Зарплата за период — все сотрудники сразу, со строкой «Итого». */}
      <div className="card" style={{ padding: 0, marginBottom: 24 }}>
        <div className="card-header is-titleless">
          <div>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.16em',
              color: 'var(--primary-dark)',
              marginBottom: 4,
            }}>{t('salary.roster.eyebrow')}</div>
            <h3 style={{
              fontFamily: 'var(--font-display)',
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: '-0.02em',
            }}>{t('salary.calc.title')}</h3>
          </div>
          <button
            className="btn btn-primary"
            data-testid="salary-accrue-all"
            onClick={onAccrueAll}
            disabled={!pending.length || accruing || createMut.isPending}
            title={pending.length ? undefined : t('salary.accrueAll.none')}
          >
            <Icon name="bookmark_add" size={18} />{' '}
            {accruing
              ? t('salary.saving')
              : `${t('salary.accrueAll.button')}${pending.length ? ` · ${pending.length}` : ''}`}
          </button>
        </div>

        <div className="card-body">
          <div className="filters">
            <CrmDatePicker className="crm-input" value={start} onChange={(v) => setRange({ start: v, end })} data-testid="salary-from" />
            <CrmDatePicker className="crm-input" value={end} onChange={(v) => setRange({ start, end: v })} data-testid="salary-to" />
            <SearchField
              value={search}
              onChange={setSearch}
              onClear={() => setSearch('')}
              placeholder={t('salary.roster.search')}
              testId="salary-search"
            />
          </div>

          {rosterQuery.isLoading ? (
            <Loading />
          ) : shown.length === 0 ? (
            <div className="empty" data-testid="salary-roster-empty">{t('salary.roster.empty')}</div>
          ) : (
            <>
              <SortSelect sort={rosterSort} />
              <div className="table-wrap" style={{ overflowX: 'auto' }}>
                <table className="table" data-testid="salary-roster" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      {rosterSort.columns.map((c) => <SortTh key={c.key} sort={rosterSort} col={c.key} />)}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rosterSort.sorted.map((r) => {
                      const open = openUserId === r.userId;
                      const kpi = kpiOf(r);
                      return (
                        <Fragment key={r.userId}>
                          <tr
                            className="salary-roster-row"
                            data-testid="salary-row"
                            data-user={r.userId}
                            onClick={() => setOpenUserId(open ? null : r.userId)}
                          >
                            <td>
                              <div style={{ fontWeight: 500 }}>{r.user.fullName}</div>
                              <div className="salary-roster-role">
                                {displayRoleLabel(r.user as any)}
                                {!r.hasRate && (
                                  <span className="salary-norate" title={t('salary.roster.noRateHint')}>
                                    {' · '}{t('salary.roster.noRate')}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td data-label={t('salary.cell.hours')} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(r.workedMinutes)}</td>
                            <td data-label={t('salary.cell.late')} style={{ color: r.lateMinutes > 0 ? 'var(--danger)' : 'var(--text-soft)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                              {r.lateMinutes > 0 ? `${r.lateMinutes}${tr('time.m')}` : '—'}
                            </td>
                            <td data-label={t('salary.cell.base')}>{fmtMoney(r.baseAmount, r.currency)}</td>
                            <td data-label={t('salary.cell.bonus')} style={{ color: r.bonusAmount > 0 ? 'var(--primary-dark)' : 'var(--text-soft)' }}>
                              {r.bonusAmount > 0 ? `+ ${fmtMoney(r.bonusAmount, r.currency)}` : fmtMoney(0, r.currency)}
                              {r.bonusPercent !== null && r.bonusPercent !== undefined && r.bonusAmount > 0 && (
                                <span className="salary-pct"> · {r.bonusPercent}%</span>
                              )}
                            </td>
                            <td data-label={t('salary.cell.kpi')} style={{ color: kpi > 0 ? 'var(--primary-dark)' : 'var(--text-soft)' }}>
                              {kpi > 0 ? `+ ${fmtMoney(kpi, r.currency)}` : fmtMoney(0, r.currency)}
                            </td>
                            <td data-label={t('salary.cell.penalties')} style={{ color: r.penalties > 0 ? 'var(--danger)' : 'var(--text-soft)' }}>
                              {r.penalties > 0 ? `− ${fmtMoney(r.penalties, r.currency)}` : fmtMoney(0, r.currency)}
                            </td>
                            <td data-label={t('salary.cell.net')} style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 17 }} data-testid="salary-net">
                              {fmtMoney(netOf(r), r.currency)}
                            </td>
                            <td data-label={t('common.status')}>
                              {r.record
                                ? (r.record.status === 'PAID'
                                    ? <span className="badge badge-success" data-testid="salary-row-status">{t('salary.status.PAID')}</span>
                                    : <span className="badge badge-warning" data-testid="salary-row-status">{t('salary.roster.accrued')}</span>)
                                : <span className="salary-roster-role" data-testid="salary-row-status">{t('salary.roster.notAccrued')}</span>}
                            </td>
                            <td>
                              <Icon name={open ? 'expand_less' : 'expand_more'} size={18} />
                            </td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={ROSTER_COLUMNS} style={{ background: 'var(--bg-soft)', padding: 0 }}>
                                <EmployeeSalary
                                  row={r}
                                  record={r.record ? records.find((x) => x.id === r.record!.id) ?? null : null}
                                  start={start}
                                  end={end}
                                  kpi={kpiByUser[r.userId] ?? ''}
                                  onKpi={(v) => setKpiByUser((cur) => ({ ...cur, [r.userId]: v }))}
                                  comment={commentByUser[r.userId] ?? ''}
                                  onComment={(v) => setCommentByUser((cur) => ({ ...cur, [r.userId]: v }))}
                                  onCreate={() => onCreate(r.userId)}
                                  saving={createMut.isPending || accruing}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    <tr className="table-total" data-testid="salary-total">
                      <td>{t('common.totalRow')} · {shown.length}</td>
                      <td data-label={t('salary.cell.hours')} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(totals.workedMinutes)}</td>
                      <td data-label={t('salary.cell.late')} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                        {totals.lateMinutes > 0 ? `${totals.lateMinutes}${tr('time.m')}` : '—'}
                      </td>
                      <td data-label={t('salary.cell.base')}>{fmtMoney(totals.baseAmount)}</td>
                      <td data-label={t('salary.cell.bonus')}>+ {fmtMoney(totals.bonusAmount)}</td>
                      <td data-label={t('salary.cell.kpi')}>{totals.kpiBonus > 0 ? `+ ${fmtMoney(totals.kpiBonus)}` : fmtMoney(0)}</td>
                      <td data-label={t('salary.cell.penalties')} style={{ color: totals.penalties > 0 ? 'var(--danger)' : undefined }}>
                        {totals.penalties > 0 ? `− ${fmtMoney(totals.penalties)}` : fmtMoney(0)}
                      </td>
                      <td data-label={t('salary.cell.net')} style={{ fontFamily: 'var(--font-display)', fontSize: 18 }} data-testid="salary-total-net">
                        {fmtMoney(totals.netAmount)}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
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
      {records.length > 0 && <SortSelect sort={sort} />}
      <div className="card" style={{ padding: 0 }}>
        {/* Колонок стало 11 — на узком экране таблица должна скроллиться
            внутри карточки, а не растягивать страницу. */}
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && (
                <tr><td colSpan={HISTORY_COLUMNS} className="empty">{t('salary.empty')}</td></tr>
              )}
              {sort.sorted.map((r) => {
                const expanded = expandedId === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td style={{ fontWeight: 500 }}>{r.user?.fullName}</td>
                      <td data-label={periodLabel} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                        {tjFormatDate(r.periodStart)}
                        {' → '}
                        {tjFormatDate(r.periodEnd)}
                      </td>
                      <td data-label={t('salary.cell.hours')} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(r.workedMinutes)}</td>
                      <td data-label={t('finance.summary.income')} style={{ color: 'var(--text-soft)' }}>{fmtMoney(r.salesAmount, r.currency)}</td>
                      <td data-label={t('salary.cell.base')}>{fmtMoney(r.baseAmount, r.currency)}</td>
                      {/* Только комиссия с продаж. KPI — отдельная колонка:
                          он назначается вручную и в споре обсуждается
                          отдельно от бонуса по полосе. */}
                      <td data-label={t('salary.cell.bonus')} style={{ color: 'var(--primary-dark)' }}>+ {fmtMoney(r.bonusAmount, r.currency)}</td>
                      <td data-label={t('salary.cell.kpi')} style={{ color: r.kpiBonus > 0 ? 'var(--primary-dark)' : 'var(--text-soft)' }}>
                        {r.kpiBonus > 0 ? `+ ${fmtMoney(r.kpiBonus, r.currency)}` : fmtMoney(0, r.currency)}
                      </td>
                      {/* Штрафы вычитаются из net — без этой колонки строка
                          не сходилась. Значения берём из записи, ничего не
                          пересчитываем. */}
                      <td data-label={t('salary.cell.penalties')} style={{ color: r.penalties > 0 ? 'var(--danger)' : 'var(--text-soft)' }}>
                        {r.penalties > 0 ? `− ${fmtMoney(r.penalties, r.currency)}` : fmtMoney(0, r.currency)}
                      </td>
                      <td data-label={t('salary.cell.net')} style={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 500,
                        fontSize: 17,
                      }}>{fmtMoney(r.netAmount, r.currency)}</td>
                      <td data-label={t('common.status')}>
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
              {records.length > 0 && (
                <tr className="table-total" data-testid="salary-history-total">
                  <td>{t('common.totalRow')} · {records.length}</td>
                  <td></td>
                  <td data-label={t('salary.cell.hours')} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(historyTotals.workedMinutes)}</td>
                  <td data-label={t('finance.summary.income')}>{fmtMoney(historyTotals.salesAmount)}</td>
                  <td data-label={t('salary.cell.base')}>{fmtMoney(historyTotals.baseAmount)}</td>
                  <td data-label={t('salary.cell.bonus')}>+ {fmtMoney(historyTotals.bonusAmount)}</td>
                  <td data-label={t('salary.cell.kpi')}>{historyTotals.kpiBonus > 0 ? `+ ${fmtMoney(historyTotals.kpiBonus)}` : fmtMoney(0)}</td>
                  <td data-label={t('salary.cell.penalties')} style={{ color: historyTotals.penalties > 0 ? 'var(--danger)' : undefined }}>
                    {historyTotals.penalties > 0 ? `− ${fmtMoney(historyTotals.penalties)}` : fmtMoney(0)}
                  </td>
                  <td data-label={t('salary.cell.net')} style={{ fontFamily: 'var(--font-display)', fontSize: 18 }} data-testid="salary-history-total-net">
                    {fmtMoney(historyTotals.netAmount)}
                  </td>
                  <td colSpan={2}></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/**
 * Раскрытая строка таблицы: подробный расчёт по одному сотруднику —
 * то же, что раньше показывал калькулятор. Считается тем же запросом
 * /salary/preview, поэтому числа сходятся со строкой таблицы.
 */
function EmployeeSalary({ row, record, start, end, kpi, onKpi, comment, onComment, onCreate, saving }: {
  row: SalaryRosterRow;
  /** Сохранённая запись, если за период уже начислено. */
  record: SalaryRecord | null;
  start: string;
  end: string;
  kpi: string;
  onKpi: (v: string) => void;
  comment: string;
  onComment: (v: string) => void;
  onCreate: () => void;
  saving: boolean;
}) {
  const { t } = useT();
  const kpiNum = Math.max(0, parseFloat(kpi || '') || 0);
  // Начислено — показываем сохранённый расчёт: он и есть то, что человек
  // получит. Пересчёт сейчас дал бы другие числа (комиссия месяца уже
  // выплачена, штрафы помечены применёнными) и сбивал бы с толку.
  const previewQuery = useQuery<SalaryPreview>({
    queryKey: keys.salary.preview({ userId: row.userId, start, end, kpi: kpiNum }),
    queryFn: () => previewSalary({ userId: row.userId, periodStart: start, periodEnd: end, kpiBonus: kpiNum }),
    enabled: !row.record,
  });
  if (row.record) {
    return (
      <div className="salary-detail" data-testid="salary-detail" onClick={(e) => e.stopPropagation()}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 20,
          marginBottom: 20,
        }}>
          <PreviewCell label={t('salary.cell.hours')} value={fmtMin(row.workedMinutes)} />
          <PreviewCell label={t('salary.cell.late')} value={row.lateMinutes > 0 ? `${row.lateMinutes}${tr('time.m')}` : '—'} />
          <PreviewCell label={t('salary.cell.base')} value={fmtMoney(row.baseAmount, row.currency)} />
          <PreviewCell
            label={
              row.bonusPercent !== null && row.bonusPercent !== undefined
                ? `${t('salary.cell.bonus')} · ${row.bonusPercent}%`
                : t('salary.cell.bonus')
            }
            value={fmtMoney(row.bonusAmount, row.currency)}
            sub={`${t('salary.bonus.volume')}: ${fmtMoney(row.salesAmount, row.currency)}`}
          />
          <PreviewCell label="KPI" value={fmtMoney(row.kpiBonus, row.currency)} />
          <PreviewCell
            label={t('salary.cell.penalties')}
            value={`− ${fmtMoney(row.penalties, row.currency)}`}
            negative={row.penalties > 0}
          />
        </div>
        {record && hasBonusSnapshot(record) && <SavedBonusBreakdown record={record} />}
        <div style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 20,
          marginTop: 20,
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
              fontSize: 'clamp(26px, 7vw, 44px)',
              fontWeight: 500,
              letterSpacing: '-0.04em',
              lineHeight: 1,
              color: 'var(--primary-dark)',
            }} data-testid="salary-detail-net">{fmtMoney(row.netAmount, row.currency)}</div>
            {record?.comment && <div className="salary-roster-role">{record.comment}</div>}
          </div>
          <div className="salary-detail-done" data-testid="salary-detail-done">
            <Icon name="check_circle" size={18} />
            {row.record.status === 'PAID'
              ? t('salary.roster.alreadyPaid').replace('{sum}', fmtMoney(row.record.netAmount, row.currency))
              : t('salary.roster.alreadyAccrued').replace('{sum}', fmtMoney(row.record.netAmount, row.currency))}
          </div>
        </div>
      </div>
    );
  }
  const preview = previewQuery.data ?? null;
  if (!preview) return <div className="empty" style={{ padding: 20 }}>{t('common.loading')}</div>;
  return (
    <div className="salary-detail" data-testid="salary-detail" onClick={(e) => e.stopPropagation()}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 20,
        marginBottom: 20,
      }}>
        <PreviewCell label={t('salary.cell.hours')} value={fmtMin(preview.workedMinutes)} />
        <PreviewCell label={t('salary.cell.late')} value={preview.lateMinutes > 0 ? `${preview.lateMinutes}${tr('time.m')}` : '—'} />
        <PreviewCell label={t('salary.cell.base')} value={fmtMoney(preview.baseAmount)} />
        <PreviewCell
          label={
            preview.bonusPercent !== null && preview.bonusPercent !== undefined
              ? `${t('salary.cell.bonus')} · ${preview.bonusPercent}%`
              : t('salary.cell.bonus')
          }
          value={fmtMoney(preview.bonusAmount)}
          sub={`${
            (preview.bonusMonths?.length ?? 1) > 1
              ? t('salary.bonus.volumePeriod')
              : t('salary.bonus.volume')
          }: ${fmtMoney(preview.salesAmount)}`}
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
        paddingTop: 20,
        marginTop: 20,
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
            fontSize: 'clamp(26px, 7vw, 44px)',
            fontWeight: 500,
            letterSpacing: '-0.04em',
            lineHeight: 1,
            color: 'var(--primary-dark)',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
          }} data-testid="salary-detail-net">{fmtMoney(preview.netAmount, preview.currency)}</div>
        </div>
        <div className="salary-confirm-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label>{t('salary.field.kpiBonus')}</label>
              <input
                className="crm-input"
                type="number"
                step="0.01"
                min="0"
                value={kpi}
                onChange={(e) => onKpi(e.target.value)}
                placeholder="0"
                data-testid="salary-kpi"
                style={{ width: 130 }}
              />
            </div>
            <input
              className="crm-input"
              type="text"
              value={comment}
              onChange={(e) => onComment(e.target.value)}
              placeholder={t('salary.field.commentPlaceholder')}
              data-testid="salary-comment"
              style={{ flex: '1 1 200px', minWidth: 0 }}
            />
          <button
            className="btn btn-primary"
            onClick={onCreate}
            disabled={saving}
            data-testid="salary-fix"
            style={{ flex: '0 1 auto', minWidth: 0 }}
          >
            <Icon name="bookmark_add" size={18} /> {saving ? t('salary.saving') : t('salary.new')}
          </button>
        </div>
      </div>
    </div>
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
  const months = preview.bonusMonths ?? [];
  const bands = preview.bonusBands ?? [];
  const volume = preview.bonusVolume ?? preview.salesAmount;
  const personal = preview.bonusSource === 'PERSONAL';
  const nonTjs = preview.nonTjsSales && Object.keys(preview.nonTjsSales).length > 0
    ? preview.nonTjsSales
    : null;
  // Период длиннее месяца: у каждого месяца своя полоса, одной строки
  // «объём → полоса → ставка» для него не существует.
  const multi = months.length > 1;
  // Маленькая расшифровка, а не список: в ссылку не пишем. Карточками на
  // телефоне она не становится (класса .table нет), заголовки видны всегда.
  const monthsSort = useTableSort(
    months,
    [
      { key: 'month', label: t('salary.bonus.month'), type: 'date', value: (m) => m.periodStart },
      { key: 'volume', label: t('salary.bonus.volume'), type: 'number', value: (m) => m.volume },
      { key: 'band', label: t('salary.bonus.band'), type: 'number', value: (m) => m.band.minAmount },
      { key: 'percent', label: '%', type: 'number', value: (m) => m.percent },
      { key: 'due', label: t('salary.bonus.due'), type: 'number', value: (m) => m.due },
    ],
    { persist: false },
  );

  // Старый бэк (или ошибка) — не рисуем пустую рамку.
  if (!band && !multi) return null;

  const monthLabel = preview.bonusPeriodStart
    ? `${tjFormatDate(preview.bonusPeriodStart)} — ${tjFormatDate(preview.bonusPeriodEnd || preview.bonusPeriodStart)}`
    : null;

  return (
    <div style={{
      marginTop: 4,
      marginBottom: 24,
      padding: 18,
      borderRadius: 14,
      // Третья рамка подряд (карточка → плашка → этот блок) — заливки хватает.
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

      {/* Период длиннее месяца — строка на каждый месяц: свой объём, своя
          полоса, своя ставка. Складывать объёмы и брать одну полосу нельзя,
          иначе ставка зависела бы от выбранного на экране диапазона. */}
      {multi && (
        <div style={{ marginBottom: 12, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--text-soft)', textAlign: 'left' }}>
                <SortTh sort={monthsSort} col="month" style={{ padding: '4px 10px 4px 0', fontWeight: 400 }} />
                <SortTh sort={monthsSort} col="volume" style={{ padding: '4px 10px', fontWeight: 400 }} />
                <SortTh sort={monthsSort} col="band" style={{ padding: '4px 10px', fontWeight: 400 }} />
                <SortTh sort={monthsSort} col="percent" style={{ padding: '4px 10px', fontWeight: 400, textAlign: 'right' }} />
                <SortTh sort={monthsSort} col="due" style={{ padding: '4px 0 4px 10px', fontWeight: 400, textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {monthsSort.sorted.map((m) => (
                <tr key={m.periodStart} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '5px 10px 5px 0' }}>{tjFormatDate(m.periodStart)}</td>
                  <td style={{ padding: '5px 10px' }}>{fmtMoney(m.volume)}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text-soft)' }}>
                    {bandRangeLabel(m.band.minAmount, m.band.maxAmount)}
                  </td>
                  <td style={{ padding: '5px 10px', textAlign: 'right' }}>{m.percent}%</td>
                  <td style={{ padding: '5px 0 5px 10px', textAlign: 'right', fontWeight: 600 }}>
                    {fmtMoney(m.due)}
                    {m.alreadyPaid > 0 && (
                      <span style={{ color: 'var(--text-light)', fontWeight: 400 }}>
                        {' '}({t('salary.bonus.alreadyPaid')} {fmtMoney(m.alreadyPaid)})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!multi && <div style={{
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
        <b>{band ? bandRangeLabel(band.minAmount, band.maxAmount) : '—'}</b>
        <span style={{ color: 'var(--text-light)' }}>→</span>
        <b>{preview.bonusPercent}%</b>
        <span style={{ color: 'var(--text-light)' }}>→</span>
        <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--primary-dark)' }}>
          {fmtMoney(preview.bonusMonthTotal ?? preview.bonusAmount)}
        </b>
      </div>}

      {/* Уже начисленное за месяц: без этой строки «объём 200 000 → 6% →
          12 000», а к выплате 0, выглядит как ошибка расчёта. При периоде
          в несколько месяцев то же самое показано построчно в таблице. */}
      {!multi && !!preview.bonusAlreadyPaid && (
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

      {multi && (
        <div style={{
          display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 13, marginBottom: 10,
        }}>
          <span style={{ color: 'var(--text-soft)' }}>
            {t('salary.bonus.totalForMonths').replace('{n}', String(months.length))}
          </span>
          <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--primary-dark)' }}>
            {fmtMoney(preview.bonusAmount)}
          </b>
        </div>
      )}

      {/* Пустой месяц. Экран по умолчанию открывает ТЕКУЩИЙ месяц, и 1-го
          числа объём законно равен нулю — без этой строки «0 → 4% → 0»
          читается как «система не считает», а не как «месяц ещё пустой». */}
      {!multi && volume === 0 && (
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
          // При периоде в несколько месяцев подсвечивать нечего: полос
          // столько же, сколько месяцев, и они перечислены в таблице выше.
          const current = !personal && !multi && b.key === band?.key;
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
  // Запись за период длиннее месяца: полос было несколько, и в снимок ни
  // одна не пишется — иначе она выдавала бы себя за полосу всего периода.
  // Показываем объём и сумму без цепочки «полоса → ставка».
  const multiSaved = !record.bonusBandKey;

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
        {multiSaved ? (
          <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.multiMonth')}</span>
        ) : (
          <>
            <span style={{ color: 'var(--text-soft)' }}>{t('salary.bonus.band')}</span>
            <b>{bandRangeLabel(record.bonusBandMin ?? 0, record.bonusBandMax ?? null)}</b>
            <span style={{ color: 'var(--text-light)' }}>→</span>
            <b>{percent}%</b>
            <span style={{ color: 'var(--text-light)' }}>→</span>
          </>
        )}
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
