import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Document } from '../api/types';
import { fullTimeline, type TimelineItem } from '../api/interactions';
import type { LeadDeal } from '../api/applications';
import { REQUIRED_DOCUMENTS } from './DocumentsChecklist';
import { useT } from '../lib/i18n';
import { tjFormatDateTime } from '../lib/tjTime';
import { timelineVisuals } from '../lib/timeline';
import { useAuth } from '../store/auth';
import { canOpenDeals } from './navGroups';
import Icon from '../Icon';

/**
 * Макет UI (11.11.2026): карточки лида и студента устроены одинаково — шапка,
 * вкладки «Обзор / История общения / Документы / Анкета», в «Обзоре» —
 * данные клиента и блоки «История общения», «Документы», «Сделки».
 */
export const CLIENT_TABS = ['overview', 'history', 'docs', 'form'] as const;
export type ClientTab = (typeof CLIENT_TABS)[number];

/** Вкладка — в ссылке (?tab=history): «назад» и обновление страницы её помнят. */
export function useClientTab(enabled: boolean): [ClientTab, (next: ClientTab) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab') as ClientTab | null;
  const tab: ClientTab = enabled && raw && (CLIENT_TABS as readonly string[]).includes(raw) ? raw : 'overview';
  const setTab = (next: ClientTab) => {
    const p = new URLSearchParams(searchParams);
    if (next === 'overview') p.delete('tab');
    else p.set('tab', next);
    setSearchParams(p, { replace: true });
  };
  return [tab, setTab];
}

/** Ключ ленты истории — тот же, что у InteractionsLog: один запрос на карточку. */
export const timelineKey = (studentId: string) => ['interactions', 'timeline', studentId] as const;

export function useTimeline(studentId: string | null | undefined, enabled = true) {
  return useQuery<TimelineItem[]>({
    queryKey: timelineKey(studentId ?? ''),
    queryFn: () => fullTimeline(studentId!),
    enabled: !!studentId && enabled,
  });
}

export function docsSummary(documents: Document[] | null | undefined) {
  const typed = (documents ?? []).filter((d) => d.type && d.type !== 'OTHER');
  const missing = REQUIRED_DOCUMENTS.filter((r) => !typed.some((d) => d.type === r.type));
  return { uploaded: REQUIRED_DOCUMENTS.length - missing.length, total: REQUIRED_DOCUMENTS.length, missing };
}

export function ClientTabsBar({
  tab,
  setTab,
  historyCount,
  documents,
}: {
  tab: ClientTab;
  setTab: (t: ClientTab) => void;
  historyCount?: number;
  documents?: Document[] | null;
}) {
  const { t } = useT();
  const docs = docsSummary(documents);
  const items: [ClientTab, string, string | number | null | undefined][] = [
    ['overview', t('client.tab.overview'), null],
    ['history', t('client.tab.history'), historyCount],
    ['docs', t('client.tab.docs'), `${docs.uploaded} / ${docs.total}`],
    ['form', t('client.tab.form'), null],
  ];
  return (
    <div className="client-tabs" role="tablist" aria-label={t('client.tabs.label')} data-testid="client-tabs">
      {items.map(([key, label, badge]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          className={`client-tab${tab === key ? ' active' : ''}`}
          onClick={() => setTab(key)}
          data-testid={`client-tab-${key}`}
        >
          {label}
          {badge !== null && badge !== undefined && <span className="client-tab-badge">{badge}</span>}
        </button>
      ))}
    </div>
  );
}

/** Блоки «Обзора»: последнее в истории, документы n из m, сделки клиента. */
export function ClientOverviewCards({
  studentId,
  documents,
  setTab,
  deals,
  dealsLoading,
  canCreateDeal,
  onCreateDeal,
}: {
  /** Нет студента (новый лид) — только «Сделки». */
  studentId?: string | null;
  documents?: Document[] | null;
  setTab: (t: ClientTab) => void;
  deals: LeadDeal[] | undefined;
  dealsLoading: boolean;
  canCreateDeal: boolean;
  onCreateDeal: () => void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const timeline = useTimeline(studentId);
  const items = [...(timeline.data ?? [])].sort((x, y) => y.occurredAt.localeCompare(x.occurredAt));
  const docs = docsSummary(documents);
  return (
    <div className="client-overview-grid">
      {studentId && (
        <section className="card client-ov-card" data-testid="ov-history">
          <div className="client-ov-head">
            <h3 className="profile-h">{t('client.tab.history')}</h3>
            <button type="button" className="profile-link-btn" onClick={() => setTab('history')} data-testid="ov-history-all">
              {t('client.ov.allHistory').replace('{n}', String(items.length))} →
            </button>
          </div>
          {timeline.isLoading ? (
            <span className="sk-line" style={{ width: '70%' }} />
          ) : items.length === 0 ? (
            <p className="client-muted" style={{ margin: 0 }}>{t('client.ov.noHistory')}</p>
          ) : (
            <ul className="client-ov-list">
              {items.slice(0, 3).map((it) => {
                const vis = timelineVisuals(it, t);
                return (
                  <li key={`${it.source}-${it.id}`}>
                    <Icon name={vis.icon} size={18} />
                    <span className="client-ov-text">
                      <span><b>{vis.label}</b> · {it.summary}</span>
                      <span className="client-ov-when">{tjFormatDateTime(it.occurredAt)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {studentId && (
        <section className="card client-ov-card" data-testid="ov-docs">
          <div className="client-ov-head">
            <h3 className="profile-h">{t('client.tab.docs')}</h3>
            <span className="client-ov-count">{t('client.ov.docsOf').replace('{n}', String(docs.uploaded)).replace('{m}', String(docs.total))}</span>
          </div>
          <div className="client-ov-progress" role="progressbar" aria-valuemin={0} aria-valuemax={docs.total} aria-valuenow={docs.uploaded}>
            <span style={{ width: `${Math.round((docs.uploaded / docs.total) * 100)}%` }} />
          </div>
          {docs.missing.length > 0 && (
            <p className="client-ov-missing">
              {t('client.ov.missing')} {docs.missing.slice(0, 3).map((d) => {
                const k = `docs.type.${d.type}`;
                const tr = t(k);
                return tr === k ? d.label : tr;
              }).join(', ')}
              {docs.missing.length > 3 ? ` ${t('client.ov.more').replace('{n}', String(docs.missing.length - 3))}` : ''}
            </p>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTab('docs')} data-testid="ov-docs-open">{t('client.ov.openDocs')}</button>
        </section>
      )}
      <section className="card client-ov-card" data-testid="ov-deals">
        <div className="client-ov-head">
          <h3 className="profile-h">{t('client.ov.deals')}</h3>
        </div>
        {dealsLoading ? (
          <span className="sk-line" style={{ width: '60%' }} />
        ) : (deals ?? []).length === 0 ? (
          <>
            <p className="client-muted" style={{ margin: canCreateDeal ? '0 0 10px' : 0 }}>{t(canCreateDeal ? 'client.ov.noDeals' : 'client.ov.noDealsShort')}</p>
            {canCreateDeal && (
              <button type="button" className="btn btn-primary btn-sm" onClick={onCreateDeal} data-testid="ov-deals-create">
                <Icon name="handshake" size={16} /> {t('applicationDetail.createDeal')}
              </button>
            )}
          </>
        ) : (
          <ul className="client-ov-list">
            {(deals ?? []).map((d) => {
              const body = (
                <span className="client-ov-text">
                  <span><b>{d.program || '—'}</b> · {t(`deal.status.${d.status}`)}</span>
                  {d.total !== null && (
                    <span className="client-ov-when">
                      {t('client.ov.paidOf').replace('{paid}', (d.paid ?? 0).toLocaleString('ru-RU')).replace('{total}', d.total.toLocaleString('ru-RU')).replace('{cur}', d.currency)}
                    </span>
                  )}
                </span>
              );
              return (
                <li key={d.id} data-testid="ov-deal">
                  <Icon name="handshake" size={18} />
                  {d.canOpen && canOpenDeals(me)
                    ? <a className="client-link" href={`/admin/submissions/${d.id}`} onClick={(e) => { e.preventDefault(); navigate(`/submissions/${d.id}`); }}>{body}</a>
                    : body}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
