import { AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { getMonthDetails, type MonthApplication, type MonthDetails } from '../api/userProfile';
import { TRANSACTION_CATEGORY_LABEL } from '../api/finance';
import { useT } from '../lib/i18n';
import { tjFormatDate, tjFormatTime } from '../lib/tjTime';
import { useApplicationStatusLabel, useCountryLabel } from '../lib/labels';
import DetailsModal, { groupBy, type DetailsColumn } from './DetailsModal';

/**
 * Окна «подробнее» у плиток «Текущий месяц» в профиле сотрудника (и в «Моём
 * профиле»). Записи берутся с /me/month-details — там те же условия
 * выборки, что у самих плиток (users.service: monthDetails ↔ fullProfile),
 * поэтому число в окне сходится с плиткой.
 */
export type MonthTile = 'hours' | 'late' | 'sales' | 'leads' | 'enrolled' | 'kpi' | 'penalties';

type Kpi = { totalLeadsMonth: number; enrolledMonth: number; requiredClosed: number; achievedPct: number; targetPct: number };

function fmtMinutes(min: number) {
  if (!min || min <= 0) return '0м';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}
/** Подписи плиток хранятся капсом («ПРОДАЖИ») — заголовку окна нужен обычный регистр. */
function titleCase(s: string) {
  if (s !== s.toUpperCase()) return s;
  const low = s.toLowerCase().replace(/\bkpi\b/g, 'KPI');
  return low.charAt(0).toUpperCase() + low.slice(1);
}
function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

export default function ProfileMonthDetails({
  tile,
  userId,
  userName,
  kpi,
  onClose,
}: {
  tile: MonthTile | null;
  userId: string;
  userName: string;
  kpi: Kpi;
  onClose: () => void;
}) {
  const { t } = useT();
  const statusLabel = useApplicationStatusLabel();
  const countryLabel = useCountryLabel();
  const query = useQuery<MonthDetails>({
    queryKey: ['profile', userId, 'month-details'],
    queryFn: () => getMonthDetails(userId),
    enabled: !!tile,
  });
  const d = query.data;
  const subtitle = `${userName} · ${t('details.thisMonth')}`;
  const common = {
    subtitle,
    loading: query.isLoading,
    error: query.isError,
    emptyText: t('common.empty'),
    onClose,
  };

  const timeCols: DetailsColumn<MonthDetails['time'][number]>[] = [
    { key: 'date', label: t('workday.col.date'), type: 'date', value: (e) => e.clockIn, render: (e) => tjFormatDate(e.clockIn) },
    { key: 'in', label: t('workday.col.arrival'), type: 'date', value: (e) => e.clockIn, render: (e) => tjFormatTime(e.clockIn) },
    { key: 'lunch', label: t('workday.col.lunch'), type: 'number', value: (e) => e.totalLunchMinutes, render: (e) => fmtMinutes(e.totalLunchMinutes) },
    { key: 'out', label: t('workday.col.leave'), type: 'date', value: (e) => e.clockOut, render: (e) => (e.clockOut ? tjFormatTime(e.clockOut) : null) },
    { key: 'worked', label: t('workday.col.worked'), type: 'number', value: (e) => e.totalMinutes, render: (e) => fmtMinutes(e.totalMinutes) },
    { key: 'late', label: t('workday.col.late'), type: 'number', value: (e) => e.lateMinutes, render: (e) => (e.lateMinutes > 0 ? `+${e.lateMinutes}м` : '—') },
  ];
  const appCols = (dateOf: (a: MonthApplication) => string): DetailsColumn<MonthApplication>[] => [
    { key: 'fullName', label: t('app.field.fullName'), value: (a) => a.fullName, render: (a) => <strong>{a.fullName}</strong> },
    { key: 'phone', label: t('app.field.phone'), value: (a) => a.phone },
    { key: 'country', label: t('app.field.country'), value: (a) => (a.country ? countryLabel(a.country as any) : null) },
    { key: 'status', label: t('common.status'), value: (a) => statusLabel(a.status as any) },
    { key: 'date', label: t('reports.col.date'), type: 'date', value: dateOf, render: (a) => tjFormatDate(dateOf(a)) },
  ];
  const appProps = {
    rowKey: (a: MonthApplication) => a.id,
    rowHref: (a: MonthApplication) => `/applications/${a.id}`,
    searchOf: (a: MonthApplication) => [a.fullName],
    phonesOf: (a: MonthApplication) => [a.phone],
  };

  const body = (() => {
    switch (tile) {
      case 'hours': {
        const rows = d?.time;
        return (
          <DetailsModal
            {...common}
            testId="month-hours"
            title={titleCase(t('profile.month.hours'))}
            rows={rows}
            columns={timeCols}
            rowKey={(e) => e.id}
          />
        );
      }
      case 'late': {
        const rows = d?.time.filter((e) => e.lateMinutes > 0);
        return (
          <DetailsModal
            {...common}
            testId="month-late"
            title={titleCase(t('profile.month.late'))}
            summary={d ? [{ label: t('details.lateDays'), value: String(rows?.length ?? 0) }] : undefined}
            rows={rows}
            columns={[
              ...timeCols.filter((c) => c.key === 'date' || c.key === 'in' || c.key === 'late'),
              {
                key: 'reason',
                label: t('details.lateReason'),
                value: (e) => e.lateExcuseReason,
                render: (e) => (e.lateExcuseReason ? `${e.lateExcuseReason}${e.lateExcuseStatus ? ` · ${t(`excuses.status.${e.lateExcuseStatus}`)}` : ''}` : null),
              },
            ]}
            rowKey={(e) => e.id}
          />
        );
      }
      case 'sales': {
        const rows = d?.sales;
        const catLabel = (c: string) => {
          const k = `finance.cat.${c}`;
          return t(k) !== k ? t(k) : (TRANSACTION_CATEGORY_LABEL as any)[c] ?? c;
        };
        return (
          <DetailsModal
            {...common}
            testId="month-sales"
            title={titleCase(t('profile.month.sales'))}
            groups={rows ? [{ title: t('details.byCategory'), items: groupBy(rows.filter((x) => x.currency === 'TJS'), (x) => (x.kind === 'DEAL' ? t('sales.kind.DEAL') : catLabel(x.category)), { sum: (x) => Number(x.amount), format: (n) => fmtMoney(n) }) }] : undefined}
            rows={rows}
            summary={rows ? [
              { label: t('profile.month.sales'), value: fmtMoney(rows.filter((x) => x.kind === 'DEAL' && x.currency === 'TJS').reduce((sum, x) => sum + Number(x.amount), 0)) },
              ...(rows.some((x) => x.kind === 'OTHER') ? [{ label: t('sales.otherIncome'), value: fmtMoney(rows.filter((x) => x.kind === 'OTHER' && x.currency === 'TJS').reduce((sum, x) => sum + Number(x.amount), 0)) }] : []),
            ] : undefined}
            columns={[
              { key: 'date', label: t('finance.col.date'), type: 'date', value: (x) => x.date, render: (x) => tjFormatDate(x.date) },
              { key: 'kind', label: t('sales.kind'), value: (x) => t(`sales.kind.${x.kind}`) },
              { key: 'amount', label: t('finance.col.amount'), type: 'number', align: 'right', value: (x) => Number(x.amount), render: (x) => fmtMoney(Number(x.amount), x.currency) },
              { key: 'category', label: t('finance.col.category'), value: (x) => catLabel(x.category) },
              { key: 'who', label: t('finance.col.student'), value: (x) => x.student?.fullName || x.payerName },
              { key: 'comment', label: t('finance.col.comment'), value: (x) => x.comment },
            ]}
            rowKey={(x) => x.id}
            rowHref={(x) => (x.student ? `/students/${x.student.id}` : null)}
            searchOf={(x) => [x.student?.fullName, x.payerName, x.comment]}
          />
        );
      }
      case 'leads': {
        const rows = d?.ownApplications;
        return (
          <DetailsModal
            {...common}
            {...appProps}
            testId="month-leads"
            title={titleCase(t('profile.month.leadsTotal'))}
            groups={rows ? [{ title: t('details.byStatus'), items: groupBy(rows, (a) => statusLabel(a.status as any)) }] : undefined}
            note={t('details.leadsNote')}
            rows={rows}
            columns={appCols((a) => a.createdAt)}
          />
        );
      }
      case 'enrolled':
      case 'kpi': {
        const rows = d?.enrolled;
        const formula = t('details.kpiFormula')
          .replace('{e}', String(kpi.enrolledMonth))
          .replace('{t}', String(kpi.totalLeadsMonth))
          .replace('{p}', String(kpi.achievedPct))
          .replace('{g}', String(kpi.targetPct))
          .replace('{r}', String(kpi.requiredClosed));
        return (
          <DetailsModal
            {...common}
            {...appProps}
            testId={`month-${tile}`}
            title={titleCase(tile === 'kpi' ? t('profile.month.kpiPct') : t('profile.month.enrolled'))}
            note={tile === 'kpi' ? formula : t('details.enrolledNote')}
            rows={rows}
            columns={appCols((a) => a.updatedAt)}
          />
        );
      }
      case 'penalties': {
        const rows = d?.pendingPenalties;
        const reasonLabel = (r: string) => {
          const k = `penalty.reason.${r}`;
          return t(k) !== k ? t(k) : r;
        };
        return (
          <DetailsModal
            {...common}
            testId="month-penalties"
            title={titleCase(t('profile.month.penalties'))}
            groups={rows ? [{ title: t('details.byReason'), items: groupBy(rows, (p) => reasonLabel(p.reason)) }] : undefined}
            note={t('details.penaltiesNote')}
            rows={rows}
            columns={[
              { key: 'date', label: t('profile.penaltyCol.date'), type: 'date', value: (p) => p.date, render: (p) => tjFormatDate(p.date) },
              { key: 'reason', label: t('profile.penaltyCol.reason'), value: (p) => reasonLabel(p.reason) },
              { key: 'amount', label: t('profile.penaltyCol.amount'), type: 'number', align: 'right', value: (p) => Number(p.amount), render: (p) => fmtMoney(Number(p.amount)) },
              { key: 'details', label: t('app.field.comment'), value: (p) => p.details },
            ]}
            rowKey={(p) => p.id}
          />
        );
      }
      default:
        return null;
    }
  })();

  return <AnimatePresence>{body}</AnimatePresence>;
}
