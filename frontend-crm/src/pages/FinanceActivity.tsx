import { Fragment, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import FinanceSubnav from '../components/finance/FinanceSubnav';
import CrmSelect from '../components/CrmSelect';
import { channelLabel } from '../components/finance/financeShared';
import { getFinanceActivity, TRANSACTION_CATEGORY_LABEL, type FinanceActivityRow } from '../api/finance';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { useMediaQuery } from '../lib/useMediaQuery';
import { fmtDateText } from '../lib/tjTime';

/**
 * «Финансы → Активность» (часть 3, 11.11.2026): журнал изменений в финансах —
 * кто, когда, что сделал; у правок — «было → стало» по полям.
 */

const GROUPS = ['all', 'ops', 'income', 'expense', 'salary', 'accounts'] as const;
type Group = (typeof GROUPS)[number];

function tone(action: string) {
  if (/\.(delete|reverse)$/.test(action)) return 'is-bad';
  if (/\.(update|set)$/.test(action) || action === 'payroll.reopen') return '';
  return 'is-ok';
}

export default function FinanceActivity() {
  const { t } = useT();
  const narrow = useMediaQuery('(max-width: 720px)');
  const [group, setGroup] = useState<Group>('all');
  const [actorId, setActorId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: keys.finance.expense('activity', `${group}|${actorId}`),
    queryFn: ({ pageParam }) => getFinanceActivity({ take: 50, before: pageParam || undefined, group: group === 'all' ? undefined : group, actorId: actorId || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => (last.rows.length === 50 ? last.rows[last.rows.length - 1].at : undefined),
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  const first = q.data?.pages[0];

  const when = (iso: string, full = false) =>
    fmtDateText(iso, full
      ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Dushanbe' }
      : { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dushanbe' });

  const val = (field: string, v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
    if (field === 'category') return (TRANSACTION_CATEGORY_LABEL as any)[String(v)] ?? String(v);
    if (field === 'type') return t(v === 'INCOME' ? 'finance.income' : 'finance.expense');
    if (field === 'paymentChannel') return channelLabel(String(v), t);
    if (field === 'product') return t(`finance.productEnum.${v}`);
    if (typeof v === 'number') return v.toLocaleString('ru-RU');
    return String(v);
  };
  const fieldName = (f: string) => {
    const k = `finance.act.f.${f}`;
    const s = t(k);
    return s === k ? f : s;
  };
  const changesLine = (r: FinanceActivityRow) =>
    (r.changes ?? []).slice(0, 2).map((c) => `${fieldName(c.field)}: ${val(c.field, c.before)} → ${val(c.field, c.after)}`).join(' · ');

  const details = (r: FinanceActivityRow) => (
    <div className="act-details" data-testid="act-details">
      <div><span className="fin-muted-line">{t('finance.act.object')}:</span> {t(`finance.act.entity.${r.entity}`)} · {r.summary}</div>
      <div><span className="fin-muted-line">{t('finance.act.who')}:</span> {r.actorName ?? '—'}</div>
      <div><span className="fin-muted-line">{t('finance.act.when')}:</span> {when(r.at, true)}</div>
      {r.changes?.length ? (
        <>
          <div className="act-changes-title">{t('finance.act.changed').replace('{n}', String(r.changes.length))}</div>
          <dl className="act-changes" data-testid="act-changes">
            {r.changes.map((c) => (
              <Fragment key={c.field}>
                <dt>{fieldName(c.field)}</dt>
                <dd><s>{val(c.field, c.before)}</s> → <b>{val(c.field, c.after)}</b></dd>
              </Fragment>
            ))}
          </dl>
        </>
      ) : null}
    </div>
  );

  return (
    <>
      <FinanceSubnav />
      <div className="fin-toolbar">
        <p className="fin-muted-line inc-lead">{t('finance.act.lead')}</p>
        <CrmSelect className="crm-select act-actor" value={actorId} onChange={(e) => setActorId(e.target.value)} data-testid="act-actor" aria-label={t('finance.act.who')}>
          <option value="">{t('finance.act.everyone')}</option>
          {(first?.actors ?? []).map((a) => <option key={a.id} value={a.id}>{a.name ?? '—'}</option>)}
        </CrmSelect>
      </div>
      <div className="act-groups fin-block" role="radiogroup" aria-label={t('finance.act.filter')}>
        {GROUPS.map((g) => (
          <button key={g} type="button" role="radio" aria-checked={group === g} className={`fin-subnav-chip act-chip${group === g ? ' is-active' : ''}`} onClick={() => { setGroup(g); setOpen(null); }} data-testid={`act-group-${g}`}>
            {t(`finance.act.g.${g}`)}
          </button>
        ))}
      </div>
      <section className="fin-card fin-block" data-testid="act-list">
        {q.isLoading ? <p className="fin-empty-line">{t('common.loading')}</p> : rows.length === 0 ? (
          <p className="fin-empty-line" data-testid="act-empty">{t('finance.act.empty')}</p>
        ) : narrow ? (
          <div className="inc-cards">
            {rows.map((r) => (
              <article key={r.id} className="inc-card" data-testid={`act-row-${r.id}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
                <div className="inc-card-top"><b className={`act-action ${tone(r.action)}`}>{t(`finance.act.a.${r.action}`)}</b><span className="fin-muted-line">{when(r.at)}</span></div>
                <div>{r.summary}</div>
                {r.changes?.length ? <div className="fin-muted-line">{changesLine(r)}</div> : null}
                <div className="fin-muted-line">{r.actorName ?? '—'}</div>
                {open === r.id && details(r)}
              </article>
            ))}
          </div>
        ) : (
          <div className="fin-table-wrap">
            <table className="table act-table" data-testid="act-table">
              <thead><tr><th>{t('finance.act.when')}</th><th>{t('finance.act.who')}</th><th>{t('finance.act.action')}</th><th>{t('finance.act.short')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className={`act-row${open === r.id ? ' is-open' : ''}`} tabIndex={0} aria-expanded={open === r.id}
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === r.id ? null : r.id); } }}
                      data-testid={`act-row-${r.id}`}>
                      <td style={{ whiteSpace: 'nowrap' }}>{when(r.at)}</td>
                      <td>{r.actorName ?? '—'}</td>
                      <td><span className={`act-action ${tone(r.action)}`}>{t(`finance.act.a.${r.action}`)}</span></td>
                      <td>{r.changes?.length ? changesLine(r) : r.summary}</td>
                    </tr>
                    {open === r.id && <tr className="pay-details-row"><td colSpan={4}>{details(r)}</td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {first && rows.length > 0 && (
          <div className="act-foot">
            <span className="fin-muted-line" data-testid="act-total">{t('finance.act.total').replace('{n}', String(first.total))}</span>
            {q.hasNextPage && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage} data-testid="act-more">
                {t('finance.act.more')}
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
