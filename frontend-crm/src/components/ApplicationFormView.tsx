import { useEffect, useState } from 'react';
import { FORM_SECTIONS, countProgress, displayValue, type FieldDef } from '../formSchema';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

type Props = {
  form: any;
  canEdit?: boolean;
  onSave?: (form: any) => Promise<void> | void;
};

function EditField({
  def,
  value,
  onChange,
}: {
  def: FieldDef;
  value: any;
  onChange: (v: string) => void;
}) {
  const v = value ?? '';
  if (def.kind === 'radio' && def.options) {
    return (
      <select value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {def.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }
  if ((def as any).options) {
    return (
      <select value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(def as any).options.map((o: any) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }
  if (def.kind === 'textarea') {
    return <textarea value={v} onChange={(e) => onChange(e.target.value)} rows={2} />;
  }
  return (
    <input
      type={def.kind || 'text'}
      value={v}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function ApplicationFormView({ form, canEdit, onSave }: Props) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(form || {});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(form || {});
  }, [form]);

  const progress = countProgress(draft || {});
  const percent = progress.total ? Math.round((progress.filled / progress.total) * 100) : 0;
  const empty = progress.filled === 0;

  const updateField = (sectionKey: string, fieldKey: string, value: string) => {
    setDraft((p: any) => ({
      ...p,
      [sectionKey]: { ...(p?.[sectionKey] || {}), [fieldKey]: value },
    }));
  };

  const updateRowCell = (sectionKey: string, rowIdx: number, fieldKey: string, value: string) => {
    setDraft((p: any) => {
      const rows = [...(p?.[sectionKey] || [])];
      rows[rowIdx] = { ...(rows[rowIdx] || {}), [fieldKey]: value };
      return { ...p, [sectionKey]: rows };
    });
  };

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      // toast handled by caller
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="af-view">
      <div className="af-view-header">
        <div>
          <h3 className="af-view-title">{t('appForm.title')}</h3>
          <div className="af-view-sub">
            {empty
              ? t('common.empty')
              : `${t('docs.uploaded')} ${progress.filled} / ${progress.total} (${percent}%)`}
          </div>
        </div>
        {canEdit && !editing && (
          <button className="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>
            <Icon name="edit" size={14} style={{ marginRight: 4 }} /> {t('common.edit')}
          </button>
        )}
        {editing && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => { setDraft(form || {}); setEditing(false); }}
              disabled={saving}
            >
              {t('common.cancel')}
            </button>
            <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        )}
        {!empty && !editing && (
          <div className="af-view-bar">
            <div className="af-view-bar-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>

      {empty && !editing ? (
        <div className="af-view-empty">
          <Icon name="hourglass_empty" size={40} />
          <div>{t('common.empty')}</div>
        </div>
      ) : (
        <div className="af-view-sections">
          {FORM_SECTIONS.map((s) => (
            <div key={s.key} className="af-view-section">
              <div className="af-view-section-head">
                <div className="af-view-section-icon">
                  <Icon name={s.icon} size={16} />
                </div>
                <div>
                  <div className="af-view-section-title">{s.title}</div>
                  {s.titleEn && <div className="af-view-section-title-en">{s.titleEn}</div>}
                </div>
              </div>
              {s.fields && (
                <div className="af-view-grid">
                  {s.fields.map((f) => (
                    <div key={f.key} className="af-view-field">
                      <div className="af-view-label">{f.label}</div>
                      {editing ? (
                        <EditField
                          def={f}
                          value={draft?.[s.key]?.[f.key]}
                          onChange={(v) => updateField(s.key, f.key, v)}
                        />
                      ) : (
                        <div className="af-view-value">{displayValue(f, form?.[s.key]?.[f.key])}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {s.table && (
                <div className="af-view-table">
                  {((editing ? draft : form)?.[s.key] || []).map((row: any, ri: number) => {
                    // Строка отмечена "не учился" — в read-only показываем только заголовок
                    // с пометкой; в edit-режиме скрываем полностью.
                    if (row?.__notAttended) {
                      if (editing) return null;
                      return (
                        <div key={ri} className="af-view-table-row not-attended">
                          {s.table!.rowLabels && (
                            <div className="af-view-row-label">
                              {s.table!.rowLabels[ri] || `#${ri + 1}`}
                            </div>
                          )}
                          <div className="af-view-value" style={{ color: 'var(--text-soft)', fontStyle: 'italic' }}>
                            не учился
                          </div>
                        </div>
                      );
                    }
                    const hasData = s.table!.columns.some((c) => row?.[c.key]?.toString().trim());
                    if (!hasData && !s.table!.rowLabels && !editing) return null;
                    return (
                      <div key={ri} className="af-view-table-row">
                        {s.table!.rowLabels && (
                          <div className="af-view-row-label">
                            {s.table!.rowLabels[ri] || `#${ri + 1}`}
                          </div>
                        )}
                        <div className="af-view-row-cells">
                          {s.table!.columns.map((c) => (
                            <div key={c.key} className="af-view-field">
                              <div className="af-view-label">{c.label}</div>
                              {editing ? (
                                <EditField
                                  def={c}
                                  value={row?.[c.key]}
                                  onChange={(v) => updateRowCell(s.key, ri, c.key, v)}
                                />
                              ) : (
                                <div className="af-view-value">{displayValue(c, row?.[c.key])}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
