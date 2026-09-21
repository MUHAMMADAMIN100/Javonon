import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { kpiDetails, type KpiDetails, type KpiDetailsSale, type KpiRow } from '../api/kpi';
import { useT } from '../lib/i18n';
import {
  useApplicationStatusLabel,
  useCountryLabel,
  useDirectionLabel,
  useRoleLabel,
  useStudentStatusLabel,
} from '../lib/labels';
import { tjFormatDate } from '../lib/tjTime';
import Loading from './Loading';
import Icon from '../Icon';
import { SortSelect, SortTh, sortRows, useTableSort } from './TableSort';

/**
 * Окно «что стоит за числами» по клику на строку рейтинга KPI.
 *
 * Период — тот же, что выбран на экране: окно обязано объяснять ИМЕННО те
 * числа, на которые человек только что смотрел. Сервер собирает списки теми
 * же условиями, что и сами числа (KpiService), поэтому «Студентов: 1» в
 * строке — это ровно один студент во вкладке, а «Продажи 6 000» — платежи,
 * дающие в сумме 6 000.
 *
 * Доступ проверяет сервер (руководство — любого, сотрудник — себя); сюда
 * окно для чужой строки попасть не должно, но 403 всё равно обработан.
 */

type Tab = 'students' | 'sales' | 'applications';

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

export default function KpiDetailsModal({
  row,
  params,
  rangeLabel,
  onClose,
}: {
  row: KpiRow;
  params?: { from?: string; to?: string };
  rangeLabel: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const [tab, setTab] = useState<Tab>('students');

  const query = useQuery<KpiDetails>({
    queryKey: ['kpi', 'details', row.id, params?.from ?? 'all', params?.to ?? 'all'],
    queryFn: () => kpiDetails(row.id, params),
  });
  const d = query.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const errStatus = (query.error as any)?.response?.status;
  const tabs: Array<{ key: Tab; label: string; count: number | null }> = [
    { key: 'students', label: t('kpi.details.tab.students'), count: d ? d.totals.studentsCount : null },
    { key: 'sales', label: t('kpi.details.tab.sales'), count: d ? d.totals.salesCount : null },
    { key: 'applications', label: t('kpi.details.tab.applications'), count: d ? d.totals.applicationsAssigned : null },
  ];

  return (
    <motion.div
      className="dialog-backdrop kpi-details"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // mousedown, а не click: выделил текст в таблице и отпустил мышь за
      // краем окна — это не «клик мимо».
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        className="dialog-card kpi-details-card"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('kpi.details.title')}: ${row.fullName}`}
        initial={{ opacity: 0, scale: 0.97, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 16 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="kpi-details-head">
          <div style={{ minWidth: 0 }}>
            <div className="kpi-details-name">{row.fullName}</div>
            <div className="kpi-details-sub">
              {roleLabel(row.role)} · {rangeLabel}
            </div>
          </div>
          <button
            type="button"
            className="lead-modal-close"
            aria-label={t('common.close')}
            data-testid="kpi-details-close"
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        {query.isLoading && <Loading />}

        {query.isError && (
          <div className="error-banner" data-testid="kpi-details-error">
            {errStatus === 403 ? t('kpi.details.forbidden') : t('toast.error')}
          </div>
        )}

        {d && (
          <>
            <div className="kpi-details-tiles">
              <Tile label={t('kpi.col.applications')} value={String(d.totals.applicationsAssigned)} testId="tile-applications" />
              <Tile
                label={t('kpi.col.enrolled')}
                value={String(d.totals.applicationsEnrolled)}
                sub={`${row.conversionRate}% ${t('kpi.col.conversion').toLowerCase()}`}
                testId="tile-enrolled"
              />
              <Tile label={t('kpi.col.students')} value={String(d.totals.studentsCount)} testId="tile-students" />
              <Tile label={t('kpi.col.sales')} value={fmtMoney(d.totals.salesAmount, d.currency)} accent testId="tile-sales" />
            </div>

            <div className="kpi-details-tabs" role="tablist">
              {tabs.map((x) => (
                <button
                  key={x.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === x.key}
                  data-testid={`kpi-tab-${x.key}`}
                  className={`kpi-details-tab${tab === x.key ? ' is-active' : ''}`}
                  onClick={() => setTab(x.key)}
                >
                  {x.label}
                  {x.count !== null && <span className="kpi-details-tab-count">{x.count}</span>}
                </button>
              ))}
            </div>

            <div className="kpi-details-body">
              {tab === 'students' && <StudentsTab d={d} />}
              {tab === 'sales' && <SalesTab d={d} />}
              {tab === 'applications' && <ApplicationsTab d={d} />}
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function Tile({ label, value, sub, accent, testId }: { label: string; value: string; sub?: string; accent?: boolean; testId: string }) {
  return (
    <div className="kpi-details-tile">
      <div className="kpi-details-tile-label">{label}</div>
      <div className="kpi-details-tile-value" data-testid={testId} style={accent ? { color: 'var(--primary-dark)' } : undefined}>
        {value}
      </div>
      {sub && <div className="kpi-details-tile-sub">{sub}</div>}
    </div>
  );
}

/** Сервер отдаёт не больше listLimit строк — честно говорим, если список обрезан. */
function Truncated({ shown, total }: { shown: number; total: number }) {
  const { t } = useT();
  if (shown >= total) return null;
  return (
    <div className="kpi-details-note">
      {t('kpi.details.truncated').replace('{shown}', String(shown)).replace('{total}', String(total))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty" style={{ padding: '28px 0' }}>
      <div className="empty-icon"><Icon name="inbox" size={40} /></div>
      {text}
    </div>
  );
}

function StudentsTab({ d }: { d: KpiDetails }) {
  const { t } = useT();
  const directionLabel = useDirectionLabel();
  const statusLabel = useStudentStatusLabel();
  // Окно — не страница: сортировку в ссылку не пишем.
  const sort = useTableSort(
    d.students,
    [
      { key: 'fullName', label: t('app.field.fullName'), value: (s) => s.fullName },
      { key: 'direction', label: t('app.field.direction'), value: (s) => directionLabel(s.direction) },
      { key: 'status', label: t('kpi.details.col.status'), value: (s) => statusLabel(s.status) },
      { key: 'paidTotal', label: t('kpi.details.col.paidTotal'), type: 'number', value: (s) => s.paidTotal },
      { key: 'createdAt', label: t('reports.col.date'), type: 'date', value: (s) => s.createdAt },
    ],
    { persist: false },
  );
  if (d.students.length === 0) return <Empty text={t('kpi.details.empty.students')} />;
  return (
    <>
      <SortSelect sort={sort} />
      <table className="table" style={{ width: '100%' }} data-testid="kpi-students">
        <thead>
          <tr>
            <SortTh sort={sort} col="fullName" />
            <SortTh sort={sort} col="direction" />
            <SortTh sort={sort} col="status" />
            <SortTh sort={sort} col="paidTotal" style={{ textAlign: 'right' }} />
            <SortTh sort={sort} col="createdAt" />
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((s) => (
            <tr key={s.id}>
              <td><Link to={`/students/${s.id}`} className="kpi-details-link">{s.fullName}</Link></td>
              <td data-label={t('app.field.direction')}>{directionLabel(s.direction)}</td>
              <td data-label={t('kpi.details.col.status')}><span className="badge badge-gray">{statusLabel(s.status)}</span></td>
              <td data-label={t('kpi.details.col.paidTotal')} style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(s.paidTotal, d.currency)}</td>
              <td data-label={t('reports.col.date')}>{tjFormatDate(s.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Truncated shown={d.students.length} total={d.totals.studentsCount} />
    </>
  );
}

function SalesRows({ rows }: { rows: KpiDetailsSale[] }) {
  const { t } = useT();
  return (
    <>
      {rows.map((x) => (
        <tr key={x.id}>
          <td data-label={t('reports.col.date')}>{tjFormatDate(x.date)}</td>
          <td>
            {x.student ? (
              <Link to={`/students/${x.student.id}`} className="kpi-details-link">{x.student.fullName}</Link>
            ) : (
              x.payerName || <span style={{ color: 'var(--text-light)' }}>—</span>
            )}
          </td>
          <td data-label={t('kpi.details.col.category')}>{t(`finance.cat.${x.category}`)}</td>
          <td data-label={t('kpi.details.col.amount')} style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(x.amount, x.currency)}</td>
        </tr>
      ))}
    </>
  );
}

function SalesTab({ d }: { d: KpiDetails }) {
  const { t } = useT();
  const sort = useTableSort(
    d.sales,
    [
      { key: 'date', label: t('reports.col.date'), type: 'date', value: (x) => x.date },
      { key: 'payer', label: t('kpi.details.col.payer'), value: (x) => x.student?.fullName || x.payerName },
      { key: 'category', label: t('kpi.details.col.category'), value: (x) => t(`finance.cat.${x.category}`) },
      { key: 'amount', label: t('kpi.details.col.amount'), type: 'number', value: (x) => x.amount },
    ],
    { persist: false },
  );
  // Таблица продаж в другой валюте идёт без своих заголовков — порядок
  // берёт у основной.
  const otherSorted = sortRows(d.otherCurrencySales, sort.columns.find((c) => c.key === sort.key), sort.dir);
  if (d.sales.length === 0 && d.otherCurrencySales.length === 0) return <Empty text={t('kpi.details.empty.sales')} />;
  return (
    <>
      {d.sales.length > 0 && (
        <>
          <SortSelect sort={sort} />
          <table className="table" style={{ width: '100%' }} data-testid="kpi-sales">
            <thead>
              <tr>
                <SortTh sort={sort} col="date" />
                <SortTh sort={sort} col="payer" />
                <SortTh sort={sort} col="category" />
                <SortTh sort={sort} col="amount" style={{ textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody><SalesRows rows={sort.sorted} /></tbody>
          </table>
          <div className="kpi-details-sum" data-testid="kpi-sales-sum">
            {t('kpi.details.salesTotal')}: <b>{fmtMoney(d.totals.salesAmount, d.currency)}</b>
          </div>
          <Truncated shown={d.sales.length} total={d.totals.salesCount} />
        </>
      )}
      {d.otherCurrencySales.length > 0 && (
        <>
          <div className="kpi-details-note" style={{ marginTop: 18 }}>{t('kpi.details.otherCurrency')}</div>
          <table className="table" style={{ width: '100%' }}>
            <tbody><SalesRows rows={otherSorted} /></tbody>
          </table>
        </>
      )}
    </>
  );
}

function ApplicationsTab({ d }: { d: KpiDetails }) {
  const { t } = useT();
  const statusLabel = useApplicationStatusLabel();
  const countryLabel = useCountryLabel();
  const sort = useTableSort(
    d.applications,
    [
      { key: 'fullName', label: t('app.field.fullName'), value: (a) => a.fullName },
      { key: 'phone', label: t('app.field.phone'), value: (a) => a.phone },
      { key: 'country', label: t('app.field.country'), value: (a) => (a.country ? countryLabel(a.country) : null) },
      { key: 'status', label: t('kpi.details.col.status'), value: (a) => statusLabel(a.status) },
      { key: 'createdAt', label: t('reports.col.date'), type: 'date', value: (a) => a.createdAt },
    ],
    { persist: false },
  );
  if (d.applications.length === 0) return <Empty text={t('kpi.details.empty.applications')} />;
  return (
    <>
      <div className="kpi-details-chips" data-testid="kpi-app-statuses">
        {d.applicationsByStatus.map((g) => (
          <span key={g.status} className="badge badge-gray">
            {statusLabel(g.status)} · <b>{g.count}</b>
          </span>
        ))}
      </div>
      <SortSelect sort={sort} />
      <table className="table" style={{ width: '100%' }} data-testid="kpi-applications">
        <thead>
          <tr>
            {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((a) => (
            <tr key={a.id}>
              <td><Link to={`/applications/${a.id}`} className="kpi-details-link">{a.fullName}</Link></td>
              <td data-label={t('app.field.phone')}>{a.phone}</td>
              <td data-label={t('app.field.country')}>{a.country ? countryLabel(a.country) : <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
              <td data-label={t('kpi.details.col.status')}>
                <span className={`badge ${a.enrolled ? 'badge-success' : 'badge-gray'}`}>{statusLabel(a.status)}</span>
              </td>
              <td data-label={t('reports.col.date')}>{tjFormatDate(a.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Truncated shown={d.applications.length} total={d.totals.applicationsAssigned} />
    </>
  );
}
