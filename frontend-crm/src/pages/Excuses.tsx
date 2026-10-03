import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useUI } from '../ui/Dialogs';
import { useRealtimeEvent } from '../realtime';
import Icon from '../Icon';
import CrmSelect from '../components/CrmSelect';
import CrmDatePicker from '../components/CrmDatePicker';
import Pagination from '../components/Pagination';
import DismissedMark, { withDismissed } from '../components/DismissedMark';
import {
  listPendingExcuses,
  listLateness,
  approveExcuse,
  rejectExcuse,
  approveLunchExcuse,
  rejectLunchExcuse,
  type ExcuseEntry,
  type ExcuseKind,
  type LatenessStatus,
  type LatenessStatusFilter,
  type LatenessTotals,
} from '../api/excuses';
import { listUsers } from '../api/users';
import { tjFormatDateTime, tjFormatFull } from '../lib/tjTime';
import { localized, useT } from '../lib/i18n';
// Файлы лежат на backend (Railway), а не на фронте (Vercel) — нужен
// абсолютный URL. Audit fix #11: /uploads защищён JWT, токен подставляется
// в query внутри absFileUrl().
import { absFileUrl as absUrl, useFileToken } from '../lib/fileUrl';

const STATUS_LABEL: Record<LatenessStatus, string> = localized('excuses.status', {
  PENDING: 'Ожидает',
  APPROVED: 'Одобрено',
  REJECTED: 'Отклонено',
  NONE: 'Без причины',
  MINOR: 'До 10 мин — без штрафа',
});

const STATUS_COLOR: Record<LatenessStatus, string> = {
  PENDING: '#fbbf24',
  APPROVED: '#10b981',
  REJECTED: '#ef4444',
  NONE: '#ea580c',
  MINOR: '#64748b',
};

/** Опозданий на странице «Истории». */
const HISTORY_PAGE_SIZE = 10;

function fmtTjs(n: number) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)} TJS`;
}

export default function Excuses() {
  const me = useAuth((s) => s.user);
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  useFileToken(); // ссылки на файлы — с файловым токеном, перерисовка когда он придёт
  if (!isFounder(me)) {
    return <div className="card" style={{ padding: 28 }}>{t('common.founderOnly')}</div>;
  }

  // Вкладка — в адресе (?sub=history): обновление страницы и ссылка
  // открывают «Историю» сразу с её фильтрами.
  const tab: 'pending' | 'history' = params.get('sub') === 'history' ? 'history' : 'pending';
  const setTab = (next: 'pending' | 'history') =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'history') p.set('sub', 'history');
        else p.delete('sub');
        return p;
      },
      { replace: true },
    );
  const tabs = <SubTabs tab={tab} onChange={setTab} />;

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.hr')} · {t('workday.tab.excuses')}</span>
        <h2 className="crm-section-title">{t('excuses.title')}</h2>
      </div>

      {tab === 'pending' ? <PendingTab tabs={tabs} /> : <HistoryTab tabs={tabs} />}
    </>
  );
}

/**
 * «Ожидают» / «История» — в правом краю полосы фильтров, высотой с поля
 * (filter-height-btn, как «Сбросить»). Над кнопками — невидимая подпись той
 * же высоты, что «Сотрудник» / «С» / «По»: кнопки стоят на одной линии с
 * полями, и на «Ожидают» (там фильтров нет) — ровно на том же месте.
 * На планшете (index.css, .exc-bar-row) — отдельной первой строкой справа,
 * на телефоне — первой строкой, пополам.
 */
function SubTabs({ tab, onChange }: { tab: 'pending' | 'history'; onChange: (next: 'pending' | 'history') => void }) {
  const { t } = useT();
  return (
    <div className="form-group exc-tabs-group">
      <label aria-hidden="true">&nbsp;</label>
      <div className="exc-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pending'}
          className={`btn ${tab === 'pending' ? 'btn-primary' : 'btn-secondary'} filter-height-btn`}
          data-testid="excuses-tab-pending"
          onClick={() => onChange('pending')}
        >
          {t('excuses.tab.pending')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={`btn ${tab === 'history' ? 'btn-primary' : 'btn-secondary'} filter-height-btn`}
          data-testid="excuses-tab-history"
          onClick={() => onChange('history')}
        >
          {t('excuses.tab.history')}
        </button>
      </div>
    </div>
  );
}

/**
 * Полоса над списком: слева фильтры (только у «Истории»), справа вкладки.
 * Не помещаются в строку — переносятся поля, а вкладки остаются в первой
 * строке у правого края: не прыгают ни при «Сбросить», ни при смене вкладки.
 * Без анимации появления — иначе кнопки при каждом переключении «въезжают».
 */
function FilterBar({ tabs, children }: { tabs: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="card exc-bar" data-testid="excuses-bar" style={{ padding: 18, marginBottom: 14 }}>
      <div className="exc-bar-row">
        {children && (
          // Та же сетка на телефоне, что у «Посещаемости» (index.css, .att-filters):
          // сотрудник и статус во всю ширину, даты пополам, «Сбросить» ниже.
          <div className="att-filters exc-filters" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {children}
          </div>
        )}
        {tabs}
      </div>
    </div>
  );
}

/** То, что рисует карточка: причина из очереди «Ожидают» или опоздание из «Истории». */
interface CardView {
  key: string;
  user: { fullName: string; email: string; isActive?: boolean };
  kind: ExcuseKind;
  clockIn: string;
  minutes: number;
  status: LatenessStatus;
  reason: string | null;
  url: string | null;
  reviewedAt: string | null;
  /** Штраф за день — только в «Истории»; undefined — строки нет. */
  penalty?: number;
}

function fromPending(entry: ExcuseEntry): CardView {
  const isLunch = entry.kind === 'lunch';
  return {
    key: `${entry.id}-${entry.kind}`,
    user: entry.user,
    kind: entry.kind,
    clockIn: entry.clockIn,
    minutes: isLunch ? (entry.lateLunchMinutes ?? 0) : entry.lateMinutes,
    status: (isLunch ? entry.lunchLateExcuseStatus : entry.lateExcuseStatus) || 'PENDING',
    reason: (isLunch ? entry.lunchLateExcuseReason : entry.lateExcuseReason) ?? null,
    url: (isLunch ? entry.lunchLateExcuseUrl : entry.lateExcuseUrl) ?? null,
    reviewedAt: (isLunch ? entry.lunchLateExcuseReviewedAt : entry.lateExcuseReviewedAt) ?? null,
  };
}

function PendingTab({ tabs }: { tabs: React.ReactNode }) {
  const { toast } = useUI();
  const { t } = useT();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['excuses', 'pending'], queryFn: listPendingExcuses });

  // По ТЗ — когда сотрудник присылает причину, у основателя список
  // обновляется мгновенно. Тот же event тригерится после approve/reject
  // (другой сессии основателя — например на мобильнике).
  useRealtimeEvent('excuse:new', () => qc.invalidateQueries({ queryKey: ['excuses'] }));
  useRealtimeEvent('excuse:reviewed', () => qc.invalidateQueries({ queryKey: ['excuses'] }));

  const approveMut = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'arrival' | 'lunch' }) =>
      kind === 'lunch' ? approveLunchExcuse(id) : approveExcuse(id),
    onSuccess: (data) => {
      toast(
        data.penaltiesRemoved > 0
          ? t('excuses.toast.approvedRemoved').replace('{n}', String(data.penaltiesRemoved))
          : t('excuses.toast.approvedNone'),
        'success',
      );
      qc.invalidateQueries({ queryKey: ['excuses'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'arrival' | 'lunch' }) =>
      kind === 'lunch' ? rejectLunchExcuse(id) : rejectExcuse(id),
    onSuccess: () => {
      toast(t('excuses.toast.rejected'), 'success');
      qc.invalidateQueries({ queryKey: ['excuses'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const items = query.data || [];
  return (
    <>
      <FilterBar tabs={tabs} />
      {query.isLoading ? (
        <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
          {t('excuses.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((e) => (
            <ExcuseCard
              key={`${e.id}-${e.kind}`}
              view={fromPending(e)}
              onApprove={() => approveMut.mutate({ id: e.id, kind: e.kind })}
              onReject={() => rejectMut.mutate({ id: e.id, kind: e.kind })}
              busy={approveMut.isPending || rejectMut.isPending}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * «История» — все опоздания (утро и обед, с причиной и без) с фильтрами:
 * сотрудник, даты «с — по», статус. Итог над списком — по всем найденным:
 * сколько опозданий и минут (утром / с обеда, по статусам) и штрафов.
 * Фильтры и страница живут в адресе (?hEmp=&hFrom=&hTo=&hSt=&hPage=).
 */
function HistoryTab({ tabs }: { tabs: React.ReactNode }) {
  const { t } = useT();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const userId = params.get('hEmp') || '';
  const from = params.get('hFrom') || '';
  const to = params.get('hTo') || '';
  const rawStatus = params.get('hSt') || '';
  const status: LatenessStatusFilter =
    rawStatus === 'approved' || rawStatus === 'not_approved' || rawStatus === 'pending' ? rawStatus : '';
  const page = Math.max(1, Number(params.get('hPage')) || 1);
  const badRange = !!from && !!to && from > to;

  /** Меняем фильтры — страница снова первая. */
  const update = (patch: Record<string, string>, keepPage = false) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        if (!keepPage) p.delete('hPage');
        return p;
      },
      { replace: true },
    );
  const reset = () => update({ hEmp: '', hFrom: '', hTo: '', hSt: '' });

  // Сотрудники вместе с уволенными: их опоздания тоже в истории.
  const usersQuery = useQuery({ queryKey: ['users', 'withDismissed'], queryFn: () => listUsers(undefined, true) });
  const users = [...(usersQuery.data || [])].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));

  const query = useQuery({
    queryKey: ['excuses', 'history', userId, from, to, status, page],
    queryFn: () =>
      listLateness({
        userId: userId || undefined,
        from: from || undefined,
        to: to || undefined,
        status: status || undefined,
        page,
        pageSize: HISTORY_PAGE_SIZE,
      }),
    enabled: !badRange,
    placeholderData: keepPreviousData,
  });
  useRealtimeEvent('excuse:new', () => qc.invalidateQueries({ queryKey: ['excuses'] }));
  useRealtimeEvent('excuse:reviewed', () => qc.invalidateQueries({ queryKey: ['excuses'] }));
  useRealtimeEvent('attendance:updated', () => qc.invalidateQueries({ queryKey: ['excuses', 'history'] }));

  const data = query.data;
  const anyFilter = !!(userId || from || to || status);

  return (
    <>
      <FilterBar tabs={tabs}>
        <div className="form-group att-f-employee" style={{ minWidth: 220, margin: 0 }}>
          <label>{t('attendance.col.employee')}</label>
          <CrmSelect
            className="crm-select"
            data-testid="lateness-employee"
            value={userId}
            onChange={(e) => update({ hEmp: e.target.value })}
          >
            <option value="">{t('excuses.filter.allEmployees')}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{withDismissed(u.fullName, u, t('users.dismissed'))}</option>
            ))}
          </CrmSelect>
        </div>
        <div className="form-group att-f-date" style={{ margin: 0 }} data-testid="lateness-from">
          <label>{t('common.from')}</label>
          <CrmDatePicker className="crm-input" value={from} onChange={(v) => update({ hFrom: v })} />
        </div>
        <div className="form-group att-f-date" style={{ margin: 0 }} data-testid="lateness-to">
          <label>{t('common.to')}</label>
          <CrmDatePicker className="crm-input" value={to} onChange={(v) => update({ hTo: v })} />
        </div>
        <div className="form-group att-f-employee" style={{ minWidth: 200, margin: 0 }}>
          <label>{t('excuses.filter.status')}</label>
          <CrmSelect
            className="crm-select"
            data-testid="lateness-status"
            value={status}
            onChange={(e) => update({ hSt: e.target.value })}
          >
            <option value="">{t('excuses.filter.allStatuses')}</option>
            <option value="approved">{t('excuses.filter.approved')}</option>
            <option value="not_approved">{t('excuses.filter.notApproved')}</option>
            <option value="pending">{t('excuses.filter.pending')}</option>
          </CrmSelect>
        </div>
        {anyFilter && (
          <button className="btn btn-secondary filter-height-btn att-f-btn" data-testid="lateness-reset" onClick={reset}>
            {t('filter.reset')}
          </button>
        )}
      </FilterBar>

      {badRange ? (
        <div className="card" style={{ padding: 24, color: 'var(--danger)' }} data-testid="lateness-bad-range">
          {t('excuses.filter.badRange')}
        </div>
      ) : !data ? (
        <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>
      ) : (
        <>
          <LatenessTotalsCard totals={data.totals} />
          {data.items.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }} data-testid="lateness-empty">
              {t('excuses.history.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="lateness-list">
              {data.items.map((it) => (
                <ExcuseCard
                  key={`${it.id}-${it.kind}`}
                  view={{
                    key: `${it.id}-${it.kind}`,
                    user: it.user,
                    kind: it.kind,
                    clockIn: it.clockIn,
                    minutes: it.minutes,
                    status: it.status,
                    reason: it.reason,
                    url: it.url,
                    reviewedAt: it.reviewedAt,
                    penalty: it.penalty,
                  }}
                />
              ))}
            </div>
          )}
          <Pagination
            page={page}
            total={data.total}
            pageSize={HISTORY_PAGE_SIZE}
            onChange={(p) => update({ hPage: p > 1 ? String(p) : '' }, true)}
          />
        </>
      )}
    </>
  );
}

/** Итог «Истории» по всем найденным опозданиям. */
function LatenessTotalsCard({ totals }: { totals: LatenessTotals }) {
  const { t } = useT();
  const min = (n: number) => `${new Intl.NumberFormat('ru-RU').format(n)} ${t('common.minutes')}`;
  const tiles: Array<{ id: string; label: string; value: string; hint?: string; tone?: string }> = [
    { id: 'count', label: t('excuses.totals.count'), value: String(totals.count) },
    {
      id: 'minutes',
      label: t('excuses.totals.minutes'),
      value: min(totals.minutes),
      hint: t('excuses.totals.split')
        .replace('{a}', String(totals.arrivalMinutes))
        .replace('{b}', String(totals.lunchMinutes)),
    },
    { id: 'approved', label: t('excuses.totals.approved'), value: min(totals.approvedMinutes), tone: STATUS_COLOR.APPROVED },
    { id: 'not-approved', label: t('excuses.totals.notApproved'), value: min(totals.notApprovedMinutes), tone: STATUS_COLOR.REJECTED },
    { id: 'pending', label: t('excuses.totals.pending'), value: min(totals.pendingMinutes) },
    { id: 'penalties', label: t('excuses.totals.penalties'), value: fmtTjs(totals.penalties), tone: totals.penalties > 0 ? STATUS_COLOR.REJECTED : undefined },
  ];
  return (
    <div className="card lateness-totals-card" data-testid="lateness-totals">
      <div className="lateness-totals">
        {tiles.map((tile) => (
          <div key={tile.id} className="lateness-total" data-testid={`lateness-total-${tile.id}`}>
            <div className="lateness-total-label">{tile.label}</div>
            <div className="lateness-total-value" style={tile.tone ? { color: tile.tone } : undefined}>{tile.value}</div>
            {tile.hint && <div className="lateness-total-hint">{tile.hint}</div>}
          </div>
        ))}
      </div>
      {totals.minorMinutes > 0 && (
        <div className="lateness-totals-note" data-testid="lateness-total-minor">
          {t('excuses.totals.minorNote').replace('{n}', min(totals.minorMinutes))}
        </div>
      )}
    </div>
  );
}

function ExcuseCard({
  view,
  onApprove,
  onReject,
  busy,
}: {
  view: CardView;
  onApprove?: () => void;
  onReject?: () => void;
  busy?: boolean;
}) {
  const { t } = useT();
  const isLunch = view.kind === 'lunch';
  const status = view.status;
  const kindLabel = isLunch ? t('excuses.kind.lunch') : t('excuses.kind.arrival');
  const isPending = status === 'PENDING';
  const statusText =
    t(`excuses.status.${status}`) !== `excuses.status.${status}` ? t(`excuses.status.${status}`) : STATUS_LABEL[status];
  return (
    <motion.div
      className="card"
      data-testid="lateness-card"
      data-status={status}
      data-kind={view.kind}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: 22 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{view.user.fullName}</div>
            <DismissedMark person={view.user} />
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                background: isLunch ? '#f59e0b22' : '#0ea5e922',
                color: isLunch ? '#b45309' : '#0369a1',
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${isLunch ? '#f59e0b' : '#0ea5e9'}`,
              }}
            >
              {kindLabel}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{view.user.email}</div>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
            {tjFormatDateTime(view.clockIn)}
            {' · '}
            <span style={{ color: 'var(--primary-dark)', fontWeight: 600 }} data-testid="lateness-minutes">
              {t('excuses.late')}: {view.minutes} {t('common.minutes')}
            </span>
          </div>
          {view.penalty !== undefined && view.penalty > 0 && (
            <div style={{ fontSize: 12, marginTop: 4, color: 'var(--danger)', fontWeight: 600 }} data-testid="lateness-penalty">
              {t('excuses.penalty')}: {fmtTjs(view.penalty)}
              {isPending && <span style={{ color: 'var(--text-soft)', fontWeight: 400 }}> · {t('excuses.penaltyOnHold')}</span>}
            </div>
          )}
        </div>
        <span
          data-testid="lateness-status-badge"
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: STATUS_COLOR[status] + '22',
            color: STATUS_COLOR[status],
            fontSize: 12,
            fontWeight: 600,
            border: `1.5px solid ${STATUS_COLOR[status]}`,
          }}
        >
          {statusText}
        </span>
      </div>

      {view.reason && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            {t('excuses.reason')}
          </div>
          <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{view.reason}</div>
        </div>
      )}

      {view.url && (
        <div style={{ marginBottom: 12 }}>
          <a href={absUrl(view.url)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
            <Icon name="image" size={14} /> {t('common.open')}
          </a>
        </div>
      )}

      {isPending && onApprove && onReject && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
          <button className="btn btn-sm btn-danger" onClick={onReject} disabled={busy}>
            <Icon name="close" size={14} /> {t('excuses.reject')}
          </button>
          <button className="btn btn-sm btn-primary" onClick={onApprove} disabled={busy}>
            <Icon name="check" size={14} /> {t('excuses.approve')}
          </button>
        </div>
      )}

      {!isPending && view.reviewedAt && (
        <div style={{ fontSize: 11, color: 'var(--text-soft)', borderTop: '1px solid var(--border-soft)', paddingTop: 10, marginTop: 6 }}>
          {tjFormatFull(view.reviewedAt)}
        </div>
      )}
    </motion.div>
  );
}
