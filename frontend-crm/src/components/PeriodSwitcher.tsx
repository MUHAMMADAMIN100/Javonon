import { useMemo } from 'react';
import CrmDatePicker from './CrmDatePicker';
import { useT } from '../lib/i18n';
import { dateParam, enumParam, useUrlListState } from '../lib/useUrlListState';
import { tjMonthRange, tjQuarterRange, tjYearRange } from '../lib/tjTime';

/**
 * Переключатель периода дашборда.
 *
 * Семантика одна на все карточки: фильтруем по ДАТЕ СОЗДАНИЯ записи.
 * «В воронке» за месяц — это «сколько из созданных в этом месяце заявок
 * сейчас в воронке», а не «сколько заявок за месяц зашло в воронку».
 * Смешивать «создано в периоде» с «сменило статус в периоде» нельзя:
 * тогда «Всего заявок» перестало бы быть суммой своих же срезов, и
 * цифры на одном экране не сходились бы между собой.
 *
 * Состояние живёт в query-string через useUrlListState — тем же хуком,
 * что и фильтры /applications и /students. Отдельный механизм заводить
 * незачем: нужны ровно его свойства — дефолт («этот месяц») в URL не
 * пишется, мусор из руками правленой ссылки откатывается к дефолту,
 * смена периода идёт replace'ом (это уточнение текущего экрана, а не
 * переход), а F5 и пересланная коллеге ссылка показывают тот же период.
 */

export const DASHBOARD_PERIODS = [
  'month',
  'prev',
  'quarter',
  'year',
  'all',
  'custom',
] as const;

export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

/** Границы включительно, YYYY-MM-DD. Пустой объект = за всё время. */
export type DashboardRange = { from?: string; to?: string };

export type PeriodState = {
  period: DashboardPeriod;
  /** Сырые границы «своего периода» (значения пикеров), YYYY-MM-DD. */
  from: string;
  to: string;
  /** Границы для API и queryKey. */
  range: DashboardRange;
  /**
   * «Свой период» задан не целиком: пустая граница или `from` больше `to`.
   *
   * Перевёрнутый диапазон через UI недостижим (пикеры ограничены друг
   * другом min/max), но ссылку правят руками. Пустая граница достижима и
   * мышкой: у пикера есть «Очистить» (CrmDatePicker шлёт onChange('')),
   * плюс живут `?period=custom` без дат и `?from=abc`, который dateParam
   * честно откатывает в ''.
   *
   * Запросы не уходят в обоих случаях. Показывать цифры за «период
   * наоборот» нечестно, а молча поменять границы местами — значит
   * показать не тот период, который человек видит в полях. Пустой же
   * диапазон нельзя пускать в API как есть: `{}` — это ровно запрос «за
   * всё время», и карточки показали бы totals за всю историю под
   * подписью «за выбранный период». Это хуже пустого экрана: числа
   * выглядят не устаревшими, а неверными.
   */
  invalid: boolean;
  /** Почему `invalid` — готовая подпись под контролом ('' когда всё ок). */
  invalidHint: string;
  /** Подпись периода для карточек («за этот месяц»). */
  suffix: string;
  setPeriod: (p: DashboardPeriod) => void;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
};

const LABEL_KEY: Record<DashboardPeriod, string> = {
  month: 'dashboard.period.month',
  prev: 'dashboard.period.prev',
  quarter: 'dashboard.period.quarter',
  year: 'dashboard.period.year',
  all: 'dashboard.period.all',
  custom: 'dashboard.period.custom',
};

/** «за этот месяц» / «за всё время» — подпись к цифре, не кнопка. */
const SUFFIX_KEY: Record<DashboardPeriod, string> = {
  month: 'dashboard.period.of.month',
  prev: 'dashboard.period.of.prev',
  quarter: 'dashboard.period.of.quarter',
  year: 'dashboard.period.of.year',
  all: 'dashboard.period.of.all',
  custom: 'dashboard.period.of.custom',
};

/** Пресет → календарные границы в Asia/Dushanbe (см. lib/tjTime). */
function presetRange(period: DashboardPeriod, from: string, to: string): DashboardRange {
  switch (period) {
    case 'month':
      return tjMonthRange(0);
    case 'prev':
      return tjMonthRange(-1);
    case 'quarter':
      return tjQuarterRange();
    case 'year':
      return tjYearRange();
    case 'all':
      return {};
    case 'custom':
      // Неполный «свой период» сюда доезжает, но наружу не уходит: его
      // ловит `invalid` в useDashboardPeriod и снимает enabled у запросов.
      // Отдавать отсюда `{}` нельзя — это неотличимо от ветки 'all'.
      return { ...(from && { from }), ...(to && { to }) };
  }
}

export function useDashboardPeriod(): PeriodState {
  const { t } = useT();
  const { values, setValues } = useUrlListState({
    period: enumParam(DASHBOARD_PERIODS, 'month' as const),
    from: dateParam(),
    to: dateParam(),
  });
  const { period, from, to } = values;

  const range = useMemo(() => presetRange(period, from, to), [period, from, to]);
  // Пустая граница — не «за всё время», а «период ещё не задан»: ветка
  // 'custom' без дат вернула бы тот же `{}`, что и 'all'.
  const incomplete = period === 'custom' && (!from || !to);
  const reversed = period === 'custom' && !!from && !!to && from > to;
  const invalid = incomplete || reversed;

  const setPeriod = (next: DashboardPeriod) => {
    if (next === 'custom') {
      // Переход в «свой период» с пустыми полями показал бы «за всё
      // время» под подписью «за выбранный период». Подставляем текущий
      // месяц — его же человек только что видел.
      const month = tjMonthRange(0);
      setValues({ period: next, from: from || month.from, to: to || month.to });
      return;
    }
    // Границы чистим: у пресета они свои, а висящие в ссылке ?from/?to
    // от прошлого «своего периода» — мусор, который никак не снять.
    setValues({ period: next, from: '', to: '' });
  };

  return {
    period,
    from,
    to,
    range,
    invalid,
    invalidHint: invalid
      ? t(reversed ? 'dashboard.period.invalid' : 'dashboard.period.incomplete')
      : '',
    suffix: t(SUFFIX_KEY[period]),
    setPeriod,
    setFrom: (v: string) => setValues({ from: v }),
    setTo: (v: string) => setValues({ to: v }),
  };
}

/** Сам контрол. Вёрстка — как у переключателя периода на /finance. */
export default function PeriodSwitcher({
  state,
  busy,
}: {
  state: PeriodState;
  /** Идёт дозагрузка — тот же «...», что и на /finance. */
  busy?: boolean;
}) {
  const { t } = useT();
  const { period, from, to, setPeriod, setFrom, setTo, invalid, invalidHint } = state;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.14em',
            color: 'var(--primary-dark)',
            textTransform: 'uppercase',
          }}
        >
          {t('dashboard.period.title')}
        </div>
        <div className="pagination-controls" style={{ padding: 4 }}>
          {DASHBOARD_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              className={period === p ? 'active' : ''}
              onClick={() => setPeriod(p)}
            >
              {t(LABEL_KEY[p])}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* max/min связывают пикеры друг с другом: перевёрнутый
                диапазон просто нельзя выбрать мышкой. */}
            <CrmDatePicker
              className="crm-input"
              value={from}
              onChange={setFrom}
              max={to || undefined}
              placeholder={t('dashboard.period.from')}
            />
            <span style={{ color: 'var(--text-soft)' }}>—</span>
            <CrmDatePicker
              className="crm-input"
              value={to}
              onChange={setTo}
              min={from || undefined}
              placeholder={t('dashboard.period.to')}
            />
          </div>
        )}
        {busy && !invalid && <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>...</span>}
      </div>
      {invalid && (
        <div
          style={{
            marginTop: 8,
            fontSize: 13,
            color: 'var(--danger)',
          }}
        >
          {invalidHint}
        </div>
      )}
    </div>
  );
}
