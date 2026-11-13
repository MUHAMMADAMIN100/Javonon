import { useMemo, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import FormModal from './FormModal';
import CrmSelect from './CrmSelect';
import BusyLabel from './BusyLabel';
import { TableSkeleton } from './Skeleton';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { LEAD_FIELDS_KEY, fieldLabel } from './CustomFields';
import {
  LEAD_FIELD_TYPES,
  createLeadField,
  deleteLeadField,
  fetchLeadFieldUsage,
  fetchLeadFields,
  reorderLeadFields,
  updateLeadField,
  type LeadField,
  type LeadFieldType,
} from '../api/leadFields';

const USAGE_KEY = ['lead-fields', 'usage'] as const;

/**
 * Вкладка «Поля анкеты» в «Лиды → Настройки» (13.11.2026): основатель сам
 * добавляет вопросы к лиду — текст, число, дата, список, несколько вариантов,
 * «да/нет»; обязательные, порядок, переименование, удаление.
 */
export default function LeadFieldsTab() {
  const { t, lang } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: LEAD_FIELDS_KEY, queryFn: fetchLeadFields });
  const usageQ = useQuery({ queryKey: USAGE_KEY, queryFn: fetchLeadFieldUsage });
  const fields = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.order - b.order), [q.data]);
  const usage = usageQ.data ?? {};
  const [editing, setEditing] = useState<LeadField | 'new' | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: LEAD_FIELDS_KEY });
    qc.invalidateQueries({ queryKey: USAGE_KEY });
  };
  const fail = (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error');

  const saveOrder = async (ids: string[]) => {
    const prev = qc.getQueryData<LeadField[]>(LEAD_FIELDS_KEY);
    qc.setQueryData<LeadField[]>(LEAD_FIELDS_KEY, (old) => (old ?? []).map((f) => ({ ...f, order: ids.indexOf(f.id) })));
    try {
      await reorderLeadFields(ids);
      toast(t('lk.toast.order'), 'success');
    } catch (e) {
      qc.setQueryData(LEAD_FIELDS_KEY, prev);
      fail(e);
    } finally {
      qc.invalidateQueries({ queryKey: LEAD_FIELDS_KEY });
    }
  };
  const move = (id: string, delta: number) => {
    const ids = fields.map((f) => f.id);
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
    const ids = fields.map((f) => f.id);
    ids.splice(ids.indexOf(targetId), 0, ids.splice(ids.indexOf(src), 1)[0]);
    void saveOrder(ids);
  };

  const remove = async (f: LeadField) => {
    const n = usage[f.key] ?? 0;
    const ok = await confirm({
      title: t('lf.delete.title').replace('{x}', fieldLabel(f, lang)),
      message: n ? t('lf.delete.used').replace('{n}', String(n)) : t('lf.delete.unused'),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLeadField(f.id);
      toast(t('toast.deleted'), 'success');
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const typeLabel = (type: LeadFieldType) => t(`lf.type.${type}`);

  return (
    <>
      <div className="lk-head">
        <p className="lk-hint">{t('lf.hint')}</p>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')} data-testid="lf-add">
          <Icon name="add" size={18} />
          {t('common.add')}
        </button>
      </div>
      {q.isLoading ? (
        <TableSkeleton rows={4} cols={2} avatar={false} testId="lf-skeleton" />
      ) : fields.length === 0 ? (
        <p className="lk-empty" data-testid="lf-empty">{t('lf.empty')}</p>
      ) : (
        <ol className="lk-list" data-testid="lf-list">
          {fields.map((f, idx) => (
            <li
              key={f.id}
              className={`lk-row lf-row${dragId === f.id ? ' is-dragging' : ''}${overId === f.id && dragId !== f.id ? ' is-over' : ''}`}
              draggable
              onDragStart={(e) => { setDragId(f.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { e.preventDefault(); if (overId !== f.id) setOverId(f.id); }}
              onDragLeave={() => setOverId((cur) => (cur === f.id ? null : cur))}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDrop={(e) => onDrop(e, f.id)}
              data-testid={`lf-row-${f.key}`}
              data-key={f.key}
            >
              <span className="lk-grip" title={t('lk.drag')} aria-hidden="true"><Icon name="drag_indicator" size={18} /></span>
              <span className="lf-type-icon" aria-hidden="true"><Icon name={TYPE_ICON[f.type]} size={16} /></span>
              <div className="lk-names">
                <div className="lk-name">
                  <b className="lf-name" data-testid="lf-name">{fieldLabel(f, lang)}</b>
                  <span className="lk-tag">{typeLabel(f.type)}</span>
                  {f.required && <span className="lk-tag is-required" data-testid="lf-required">{t('lf.required')}</span>}
                </div>
                <div className="lk-sub">
                  {(lang === 'tg' ? f.labelRu : f.labelTg) !== fieldLabel(f, lang) && <span>{lang === 'tg' ? f.labelRu : f.labelTg}</span>}
                  {f.options && f.options.length > 0 && (
                    <span className="lf-opts">{f.options.map((o) => (lang === 'tg' ? o.labelTg : o.labelRu) || o.labelRu).join(' · ')}</span>
                  )}
                  <span data-testid="lf-usage">{usageQ.isLoading ? '' : usage[f.key] ? t('lf.usage').replace('{n}', String(usage[f.key])) : t('lf.usage.none')}</span>
                </div>
              </div>
              <div className="lk-actions">
                <button type="button" className="icon-btn" onClick={() => move(f.id, -1)} disabled={idx === 0} title={t('lk.up')} aria-label={t('lk.up')} data-testid="lf-up">
                  <Icon name="arrow_upward" size={18} />
                </button>
                <button type="button" className="icon-btn" onClick={() => move(f.id, 1)} disabled={idx === fields.length - 1} title={t('lk.down')} aria-label={t('lk.down')} data-testid="lf-down">
                  <Icon name="arrow_downward" size={18} />
                </button>
                <button type="button" className="icon-btn" onClick={() => setEditing(f)} title={t('common.edit')} aria-label={t('common.edit')} data-testid="lf-edit">
                  <Icon name="edit" size={18} />
                </button>
                <button type="button" className="icon-btn danger" onClick={() => remove(f)} title={t('common.delete')} aria-label={t('common.delete')} data-testid="lf-delete">
                  <Icon name="delete" size={18} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <LeadFieldForm
          field={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </>
  );
}

const TYPE_ICON: Record<LeadFieldType, string> = {
  TEXT: 'short_text',
  NUMBER: 'tag',
  DATE: 'event',
  SELECT: 'radio_button_checked',
  MULTI: 'check_box',
  BOOL: 'toggle_on',
};

function LeadFieldForm({ field, onClose, onSaved }: { field: LeadField | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const [labelRu, setLabelRu] = useState(field?.labelRu ?? '');
  const [labelTg, setLabelTg] = useState(field?.labelTg ?? '');
  const [type, setType] = useState<LeadFieldType | ''>(field?.type ?? '');
  const [required, setRequired] = useState(field?.required ?? false);
  const [options, setOptions] = useState<Array<{ key?: string; labelRu: string; labelTg: string }>>(
    field?.options?.map((o) => ({ key: o.key, labelRu: o.labelRu, labelTg: o.labelTg === o.labelRu ? '' : o.labelTg })) ?? [
      { labelRu: '', labelTg: '' },
      { labelRu: '', labelTg: '' },
    ],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const withOptions = type === 'SELECT' || type === 'MULTI';
  const ruError = touched && !labelRu.trim() ? t('lk.form.ruRequired') : null;
  const typeError = touched && !type ? t('lf.form.typeRequired') : null;
  const filledOptions = options.filter((o) => o.labelRu.trim());
  const optError = touched && withOptions && filledOptions.length < 2 ? t('lf.form.optionsMin') : null;

  const setOpt = (i: number, patch: Partial<{ labelRu: string; labelTg: string }>) =>
    setOptions((cur) => cur.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    if (!labelRu.trim() || !type || (withOptions && filledOptions.length < 2)) return;
    setBusy(true);
    setErr(null);
    try {
      const body = {
        labelRu,
        labelTg: labelTg.trim() || null,
        required,
        ...(withOptions ? { options: filledOptions.map((o) => ({ key: o.key, labelRu: o.labelRu, labelTg: o.labelTg.trim() || null })) } : {}),
      };
      if (field) await updateLeadField(field.id, body);
      else await createLeadField({ ...body, type: type as LeadFieldType });
      toast(t('toast.saved'), 'success');
      onSaved();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal open title={field ? t('lk.edit.title').replace('{x}', field.labelRu) : t('lf.new')} onClose={onClose} busy={busy} width={560} testId="lf-form">
      <form onSubmit={submit} noValidate>
        <div className="form-group">
          <label htmlFor="lf-ru">{t('lf.form.ru')} *</label>
          <input id="lf-ru" className={`crm-input${ruError ? ' input-error' : ''}`} value={labelRu} maxLength={60} autoFocus
            onChange={(e) => setLabelRu(e.target.value)} data-testid="lf-form-ru" />
          {ruError && <div className="form-error-text" role="alert">{ruError}</div>}
        </div>
        <div className="form-group">
          <label htmlFor="lf-tg">{t('lf.form.tg')}</label>
          <input id="lf-tg" className="crm-input" value={labelTg} maxLength={60} placeholder={labelRu || t('lk.form.tgPlaceholder')}
            onChange={(e) => setLabelTg(e.target.value)} data-testid="lf-form-tg" />
        </div>
        <div className="form-group">
          <label>{t('lf.form.type')} *</label>
          <CrmSelect className={`crm-select${typeError ? ' input-error' : ''}`} value={type} disabled={!!field}
            onChange={(e) => setType(e.target.value as LeadFieldType)} data-testid="lf-form-type">
            <option value="">{t('lk.move.pickPlaceholder')}</option>
            {LEAD_FIELD_TYPES.map((x) => <option key={x} value={x}>{t(`lf.type.${x}`)}</option>)}
          </CrmSelect>
          {field && <div className="form-hint-text">{t('lf.form.typeLocked')}</div>}
          {typeError && <div className="form-error-text" role="alert">{typeError}</div>}
        </div>
        {withOptions && (
          <div className="form-group">
            <label>{t('lf.form.options')} *</label>
            <div className="lf-options" data-testid="lf-options">
              {options.map((o, i) => (
                <div key={i} className="lf-option">
                  <input className="crm-input" value={o.labelRu} maxLength={60} placeholder={t('lf.form.optionRu').replace('{n}', String(i + 1))}
                    onChange={(e) => setOpt(i, { labelRu: e.target.value })} data-testid={`lf-opt-${i}`} />
                  <input className="crm-input" value={o.labelTg} maxLength={60} placeholder={t('lf.form.optionTg')}
                    onChange={(e) => setOpt(i, { labelTg: e.target.value })} data-testid={`lf-opt-tg-${i}`} />
                  <button type="button" className="icon-btn danger" onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}
                    disabled={options.length <= 2} title={t('common.delete')} aria-label={t('common.delete')} data-testid={`lf-opt-del-${i}`}>
                    <Icon name="close" size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-secondary btn-sm lf-opt-add" onClick={() => setOptions((cur) => [...cur, { labelRu: '', labelTg: '' }])}
              disabled={options.length >= 30} data-testid="lf-opt-add">
              <Icon name="add" size={16} /> {t('lf.form.optionAdd')}
            </button>
            {field && <div className="form-hint-text">{t('lf.form.optionsHint')}</div>}
            {optError && <div className="form-error-text" role="alert">{optError}</div>}
          </div>
        )}
        <label className="crm-checkbox-label">
          <input type="checkbox" className="crm-checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} data-testid="lf-form-required" />
          {t('lf.form.required')}
        </label>
        <div className="form-hint-text lk-check-hint">{t('lf.form.requiredHint')}</div>
        {err && <div className="form-error-text lk-form-err" role="alert" data-testid="lf-form-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="lf-form-save">
            <BusyLabel busy={busy}>{t('common.save')}</BusyLabel>
          </button>
        </div>
      </form>
    </FormModal>
  );
}
