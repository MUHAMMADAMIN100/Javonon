import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import BackButton from '../components/BackButton';
import CrmSelect from '../components/CrmSelect';
import BusyLabel from '../components/BusyLabel';
import QueryErrorState from '../components/QueryErrorState';
import { TableSkeleton } from '../components/Skeleton';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { hasActiveRole, hasPermission } from '../lib/permissions';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { LOOKUPS_KEY, badgeStyle, useLookupItems } from '../lib/lookups';
import {
  FLOW_STATUSES,
  MACHINE_SOURCES,
  createLookup,
  deleteLookup,
  fetchLookupUsage,
  reorderLookups,
  updateLookup,
  type LookupInput,
  type LookupItem,
  type LookupKind,
} from '../api/lookups';
import LeadFieldsTab from '../components/LeadFieldsTab';
import { LEAD_FIELDS_KEY } from '../components/CustomFields';
import { fetchLeadFields } from '../api/leadFields';

/**
 * «Лиды → Настройки» (13.11.2026). Основатель (и роль с «Настройки лидов»)
 * сам добавляет, переименовывает, перекрашивает, переставляет и удаляет
 * статусы, направления, страны и источники — без программиста.
 *
 * Системные значения (на них держится логика: новый лид, успешный лид,
 * заявка с сайта…) можно переименовать и перекрасить, но не удалить.
 * Значение, на котором есть записи, удаляется только с переносом записей
 * в другое значение того же списка.
 */
type Tab = LookupKind | 'FIELDS';

const TABS: Array<{ key: Tab; labelKey: string; hintKey: string; newKey: string }> = [
  { key: 'LEAD_STATUS', labelKey: 'lk.tab.statuses', hintKey: 'lk.hint.statuses', newKey: 'lk.new.status' },
  { key: 'DIRECTION', labelKey: 'lk.tab.directions', hintKey: 'lk.hint.directions', newKey: 'lk.new.direction' },
  { key: 'COUNTRY', labelKey: 'lk.tab.countries', hintKey: 'lk.hint.countries', newKey: 'lk.new.country' },
  { key: 'LEAD_SOURCE', labelKey: 'lk.tab.sources', hintKey: 'lk.hint.sources', newKey: 'lk.new.source' },
  { key: 'FIELDS', labelKey: 'lk.tab.fields', hintKey: 'lf.hint', newKey: 'lf.new' },
];

/** Цвета на выбор — спокойные, читаются на белом и в плашке. */
const PALETTE = [
  '#1E5BB8', '#2563EB', '#0E7490', '#15803D', '#65A30D', '#B45309',
  '#C2410C', '#DC2626', '#BE185D', '#7C3AED', '#64748B', '#111827',
];

const USAGE_KEY = ['lookups', 'usage'] as const;

export function canManageLookups(user: unknown): boolean {
  return isFounder(user as any) || (hasActiveRole(user as any) && hasPermission(user as any, 'settings:lookups'));
}

export default function LeadSettings() {
  const { t, lang } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const allowed = canManageLookups(me);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = TABS.some((x) => x.key === tabParam) ? (tabParam as Tab) : 'LEAD_STATUS';
  const setTab = (k: Tab) => setParams((p) => { p.set('tab', k); return p; }, { replace: true });

  const all = useLookupItems();
  const usageQ = useQuery({ queryKey: USAGE_KEY, queryFn: fetchLookupUsage, enabled: allowed && tab !== 'FIELDS' });
  const fieldsQ = useQuery({ queryKey: LEAD_FIELDS_KEY, queryFn: fetchLeadFields, enabled: allowed });
  const fields = fieldsQ.data;
  const [editing, setEditing] = useState<LookupItem | 'new' | null>(null);
  const [moving, setMoving] = useState<LookupItem | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const items = useMemo(
    () => (all ?? []).filter((i) => i.kind === tab).sort((a, b) => a.order - b.order),
    [all, tab],
  );
  const usage = tab === 'FIELDS' ? {} : usageQ.data?.[tab] ?? {};
  const meta = TABS.find((x) => x.key === tab)!;

  if (!allowed) return <QueryErrorState kind="denied" />;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: LOOKUPS_KEY });
    qc.invalidateQueries({ queryKey: USAGE_KEY });
  };
  const fail = (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error');

  const primary = (i: LookupItem) => (lang === 'tg' ? i.labelTg || i.labelRu : i.labelRu);
  const secondary = (i: LookupItem) => (lang === 'tg' ? i.labelRu : i.labelTg);

  /** Новый порядок — сразу на экране, потом на сервер; ошибка — откат. */
  const saveOrder = async (ids: string[]) => {
    const prev = qc.getQueryData<LookupItem[]>(LOOKUPS_KEY);
    qc.setQueryData<LookupItem[]>(LOOKUPS_KEY, (old) =>
      (old ?? []).map((i) => (i.kind === tab ? { ...i, order: ids.indexOf(i.id) } : i)),
    );
    try {
      await reorderLookups(tab as LookupKind, ids);
      toast(t('lk.toast.order'), 'success');
    } catch (e) {
      qc.setQueryData(LOOKUPS_KEY, prev);
      fail(e);
    } finally {
      qc.invalidateQueries({ queryKey: LOOKUPS_KEY });
    }
  };
  const move = (id: string, delta: number) => {
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void saveOrder(ids);
  };
  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    const src = dragId;
    setDragId(null);
    setOverId(null);
    if (!src || src === targetId) return;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(src);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void saveOrder(ids);
  };

  const remove = async (item: LookupItem) => {
    const used = usage[item.key] ?? 0;
    if (used > 0) {
      setMoving(item);
      return;
    }
    const ok = await confirm({
      title: t('lk.delete.title').replace('{x}', primary(item)),
      message: t('lk.delete.message'),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLookup(item.id);
      toast(t('toast.deleted'), 'success');
      refresh();
    } catch (e: any) {
      // Пока окно было открыто, на значении появились записи — предлагаем перенос.
      if (e?.response?.status === 409) {
        qc.invalidateQueries({ queryKey: USAGE_KEY });
        setMoving(item);
        return;
      }
      fail(e);
    }
  };

  const usageText = (i: LookupItem) => {
    const n = usage[i.key];
    if (usageQ.isLoading) return '';
    return n ? t('lk.usage').replace('{n}', String(n)) : t('lk.usage.none');
  };

  return (
    <div className="lk-page" data-testid="lead-settings">
      <BackButton fallback="/leads" label={t('leads.title')} />
      <div className="card">
        <div className="client-tabs lk-tabs" role="tablist" data-testid="lk-tabs">
          {TABS.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={tab === x.key}
              className={`client-tab${tab === x.key ? ' active' : ''}`}
              onClick={() => setTab(x.key)}
              data-testid={`lk-tab-${x.key}`}
            >
              {t(x.labelKey)}
              {x.key === 'FIELDS'
                ? fields && <span className="client-tab-badge">{fields.length}</span>
                : all && <span className="client-tab-badge">{all.filter((i) => i.kind === x.key).length}</span>}
            </button>
          ))}
        </div>

        {tab === 'FIELDS' ? <LeadFieldsTab /> : (<>
        <div className="lk-head">
          <p className="lk-hint">{t(meta.hintKey)}</p>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')} data-testid="lk-add">
            <Icon name="add" size={18} />
            {t('common.add')}
          </button>
        </div>

        {!all ? (
          <TableSkeleton rows={6} cols={2} avatar={false} testId="lk-skeleton" />
        ) : items.length === 0 ? (
          <p className="lk-empty" data-testid="lk-empty">{t('lk.empty')}</p>
        ) : (
          <ol className="lk-list" data-testid="lk-list">
            {items.map((i, idx) => {
              const machine = i.kind === 'LEAD_SOURCE' && MACHINE_SOURCES.includes(i.key);
              return (
                <li
                  key={i.id}
                  className={`lk-row${dragId === i.id ? ' is-dragging' : ''}${overId === i.id && dragId !== i.id ? ' is-over' : ''}`}
                  draggable
                  onDragStart={(e) => { setDragId(i.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { e.preventDefault(); if (overId !== i.id) setOverId(i.id); }}
                  onDragLeave={() => setOverId((cur) => (cur === i.id ? null : cur))}
                  onDragEnd={() => { setDragId(null); setOverId(null); }}
                  onDrop={(e) => onDrop(e, i.id)}
                  data-testid={`lk-row-${i.key}`}
                  data-key={i.key}
                >
                  <span className="lk-grip" title={t('lk.drag')} aria-hidden="true"><Icon name="drag_indicator" size={18} /></span>
                  <span className="lk-dot" style={{ background: i.color || 'var(--border)' }} aria-hidden="true" />
                  <div className="lk-names">
                    <div className="lk-name">
                      <span className="badge" style={badgeStyle(i.color) ?? undefined} data-testid="lk-name">{primary(i)}</span>
                      {i.isSystem && <span className="lk-tag" title={t('lk.system.hint')} data-testid="lk-system"><Icon name="lock" size={13} />{t('lk.system')}</span>}
                      {i.kind === 'LEAD_STATUS' && i.isClosed && <span className="lk-tag is-closed" data-testid="lk-closed">{t('lk.closed')}</span>}
                      {machine && <span className="lk-tag">{t('lk.machine')}</span>}
                    </div>
                    <div className="lk-sub">
                      {secondary(i) && secondary(i) !== primary(i) && <span>{secondary(i)}</span>}
                      {i.kind === 'LEAD_STATUS' && (
                        <span>{i.clientLabel ? t('lk.client').replace('{x}', i.clientLabel) : t('lk.client.none')}</span>
                      )}
                      {(i.kind === 'DIRECTION' || i.kind === 'COUNTRY') && (
                        <span className={i.showOnSite ? '' : 'lk-off'} data-testid="lk-site">{i.showOnSite ? t('lk.site.on') : t('lk.site.off')}</span>
                      )}
                      <span data-testid="lk-usage">{usageText(i)}</span>
                    </div>
                  </div>
                  <div className="lk-actions">
                    <button type="button" className="icon-btn" onClick={() => move(i.id, -1)} disabled={idx === 0} title={t('lk.up')} aria-label={t('lk.up')} data-testid="lk-up">
                      <Icon name="arrow_upward" size={18} />
                    </button>
                    <button type="button" className="icon-btn" onClick={() => move(i.id, 1)} disabled={idx === items.length - 1} title={t('lk.down')} aria-label={t('lk.down')} data-testid="lk-down">
                      <Icon name="arrow_downward" size={18} />
                    </button>
                    <button type="button" className="icon-btn" onClick={() => setEditing(i)} title={t('common.edit')} aria-label={t('common.edit')} data-testid="lk-edit">
                      <Icon name="edit" size={18} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => remove(i)}
                      disabled={i.isSystem}
                      title={i.isSystem ? t('lk.system.hint') : t('common.delete')}
                      aria-label={t('common.delete')}
                      data-testid="lk-delete"
                    >
                      <Icon name="delete" size={18} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        </>)}
      </div>

      {editing && tab !== 'FIELDS' && (
        <LookupForm
          kind={tab}
          item={editing === 'new' ? null : editing}
          titleNew={t(meta.newKey)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
      {moving && tab !== 'FIELDS' && (
        <MoveModal
          item={moving}
          others={items.filter((x) => x.id !== moving.id)}
          used={usage[moving.key] ?? 0}
          label={primary}
          onClose={() => setMoving(null)}
          onDone={() => { setMoving(null); refresh(); }}
        />
      )}
    </div>
  );
}

/** Окно «Добавить / Изменить» значения справочника. */
function LookupForm({
  kind,
  item,
  titleNew,
  onClose,
  onSaved,
}: {
  kind: LookupKind;
  item: LookupItem | null;
  titleNew: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [labelRu, setLabelRu] = useState(item?.labelRu ?? '');
  const [labelTg, setLabelTg] = useState(item?.labelTg ?? '');
  const [color, setColor] = useState<string | null>(item ? item.color : kind === 'LEAD_STATUS' || kind === 'LEAD_SOURCE' ? PALETTE[0] : null);
  const [clientLabel, setClientLabel] = useState(item?.clientLabel ?? '');
  const [isClosed, setIsClosed] = useState(item?.isClosed ?? false);
  const [showOnSite, setShowOnSite] = useState(item?.showOnSite ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const flow = !!item && kind === 'LEAD_STATUS' && FLOW_STATUSES.includes(item.key);
  const ruError = touched && !labelRu.trim() ? t('lk.form.ruRequired') : null;

  useEffect(() => { setErr(null); }, [labelRu, labelTg, color, clientLabel, isClosed, showOnSite]);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    if (!labelRu.trim()) return;
    const input: LookupInput = { labelRu, labelTg: labelTg.trim() || null, color };
    if (kind === 'LEAD_STATUS') {
      input.clientLabel = clientLabel.trim() || null;
      if (!flow) input.isClosed = isClosed;
    }
    if (kind === 'DIRECTION' || kind === 'COUNTRY') input.showOnSite = showOnSite;
    setBusy(true);
    try {
      if (item) await updateLookup(item.id, input);
      else await createLookup({ ...input, kind });
      toast(t('toast.saved'), 'success');
      onSaved();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal
      open
      title={item ? t('lk.edit.title').replace('{x}', item.labelRu) : titleNew}
      onClose={onClose}
      busy={busy}
      width={520}
      testId="lk-form"
    >
      <form onSubmit={submit} noValidate>
        <div className="form-group">
          <label htmlFor="lk-ru">{t('lk.form.ru')} *</label>
          <input
            id="lk-ru"
            className={`crm-input${ruError ? ' input-error' : ''}`}
            value={labelRu}
            maxLength={60}
            autoFocus
            onChange={(e) => setLabelRu(e.target.value)}
            onBlur={() => setTouched(true)}
            data-testid="lk-form-ru"
          />
          {ruError && <div className="form-error-text" role="alert">{ruError}</div>}
        </div>
        <div className="form-group">
          <label htmlFor="lk-tg">{t('lk.form.tg')}</label>
          <input
            id="lk-tg"
            className="crm-input"
            value={labelTg}
            maxLength={60}
            placeholder={labelRu || t('lk.form.tgPlaceholder')}
            onChange={(e) => setLabelTg(e.target.value)}
            data-testid="lk-form-tg"
          />
        </div>
        <div className="form-group">
          <label>{t('lk.form.color')}</label>
          <div className="lk-palette" role="radiogroup" aria-label={t('lk.form.color')} data-testid="lk-form-color">
            {kind !== 'LEAD_STATUS' && kind !== 'LEAD_SOURCE' && (
              <button
                type="button"
                role="radio"
                aria-checked={!color}
                className={`lk-swatch is-none${!color ? ' active' : ''}`}
                onClick={() => setColor(null)}
                title={t('lk.form.noColor')}
              >
                <Icon name="block" size={16} />
              </button>
            )}
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                className={`lk-swatch${color === c ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
                data-testid={`lk-swatch-${c.slice(1)}`}
              />
            ))}
            <span className={`lk-swatch is-custom${color && !PALETTE.includes(color) ? ' active' : ''}`} title={t('lk.form.customColor')} style={color && !PALETTE.includes(color) ? { background: color, color: '#fff' } : undefined}>
              <Icon name="palette" size={16} />
              <input type="color" value={color ?? '#1E5BB8'} onChange={(e) => setColor(e.target.value.toUpperCase())} aria-label={t('lk.form.customColor')} data-testid="lk-custom-color" />
            </span>
          </div>
          <div className="lk-preview">
            <span className="badge" style={badgeStyle(color) ?? undefined}>{labelRu.trim() || t('lk.form.preview')}</span>
          </div>
        </div>
        {kind === 'LEAD_STATUS' && (
          <>
            <div className="form-group">
              <label htmlFor="lk-client">{t('lk.form.client')}</label>
              <input
                id="lk-client"
                className="crm-input"
                value={clientLabel}
                maxLength={60}
                onChange={(e) => setClientLabel(e.target.value)}
                data-testid="lk-form-client"
              />
              <div className="form-hint-text">{t('lk.form.clientHint')}</div>
            </div>
            <label className="crm-checkbox-label">
              <input
                type="checkbox"
                className="crm-checkbox"
                checked={isClosed}
                disabled={flow}
                onChange={(e) => setIsClosed(e.target.checked)}
                data-testid="lk-form-closed"
              />
              {t('lk.form.closed')}
            </label>
            <div className="form-hint-text lk-check-hint">{flow ? t('lk.form.closedFlow') : t('lk.form.closedHint')}</div>
          </>
        )}
        {(kind === 'DIRECTION' || kind === 'COUNTRY') && (
          <>
            <label className="crm-checkbox-label">
              <input
                type="checkbox"
                className="crm-checkbox"
                checked={showOnSite}
                onChange={(e) => setShowOnSite(e.target.checked)}
                data-testid="lk-form-site"
              />
              {t('lk.form.site')}
            </label>
            <div className="form-hint-text lk-check-hint">{t('lk.form.siteHint')}</div>
          </>
        )}
        {err && <div className="form-error-text lk-form-err" role="alert" data-testid="lk-form-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="lk-form-save">
            <BusyLabel busy={busy}>{t('common.save')}</BusyLabel>
          </button>
        </div>
      </form>
    </FormModal>
  );
}

/** Удаление значения, на котором есть записи: сначала — куда их перенести. */
function MoveModal({
  item,
  others,
  used,
  label,
  onClose,
  onDone,
}: {
  item: LookupItem;
  others: LookupItem[];
  used: number;
  label: (i: LookupItem) => string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!target) {
      setErr(t('lk.move.pick'));
      return;
    }
    setBusy(true);
    try {
      const r = await deleteLookup(item.id, target);
      toast(t('lk.move.done').replace('{n}', String(r.moved)), 'success');
      onDone();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal open title={t('lk.move.title').replace('{x}', label(item))} onClose={onClose} busy={busy} width={480} testId="lk-move">
      <form onSubmit={submit} noValidate>
        <p className="lk-move-text">{t('lk.move.text').replace('{n}', String(used))}</p>
        <div className="form-group">
          <label>{t('lk.move.to')}</label>
          <CrmSelect className="crm-select" value={target} onChange={(e) => { setTarget(e.target.value); setErr(null); }} data-testid="lk-move-target">
            <option value="">{t('lk.move.pickPlaceholder')}</option>
            {others.map((o) => <option key={o.key} value={o.key}>{label(o)}</option>)}
          </CrmSelect>
        </div>
        {err && <div className="form-error-text" role="alert" data-testid="lk-move-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-danger" disabled={busy} data-testid="lk-move-save">
            <BusyLabel busy={busy}>{t('lk.move.save')}</BusyLabel>
          </button>
        </div>
      </form>
    </FormModal>
  );
}
