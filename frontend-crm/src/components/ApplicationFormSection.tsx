import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FORM_SECTIONS,
  countProgress,
  emptyForm,
  PRESENT_LABEL,
  PRESENT_VALUE,
  validateField,
  type FieldDef,
  type SectionDef,
} from '../formSchema';
import { updateStudentForm } from '../api/students';
import Icon from '../Icon';
import PhoneInput from './PhoneInput';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';


const CURRENT_YEAR = new Date().getFullYear();

function Field({
  def,
  value,
  onChange,
  readOnly,
  rowContext,
}: {
  def: FieldDef;
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  rowContext?: any;
}) {
  const [touched, setTouched] = useState(false);
  const error = touched ? validateField(def, value, rowContext) : undefined;
  const sanitizeText = (raw: string): string => {
    if (def.kind === 'tel') return raw;
    if (def.lettersOnly) {
      // Буквы (любой алфавит — латиница И кириллица) + пробел + дефис + апостроф.
      return raw.replace(/[^A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ\s'\-]/g, '');
    }
    if (def.latinDigits) {
      // Буквы (любой алфавит) + цифры (без пробелов и символов).
      return raw.replace(/[^A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9]/g, '');
    }
    if (def.digitsOnly) {
      let digits = raw.replace(/[^\d]/g, '');
      if (digits.length > 1) digits = digits.replace(/^0+/, '') || '0';
      return digits;
    }
    if (def.kind === 'number') {
      // Разрешаем десятичные дроби (например, IELTS 7.5). Допустима одна точка.
      let v = raw.replace(/,/g, '.').replace(/[^\d.]/g, '');
      const firstDot = v.indexOf('.');
      if (firstDot !== -1) {
        v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
      }
      return v;
    }
    if (def.kind === 'email') {
      // Email по RFC обязан быть в латинице — здесь кириллицу не пропускаем.
      return raw.replace(/[^A-Za-z0-9._%+\-@]/g, '');
    }
    if (def.latin) {
      return raw.replace(/[^A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9 .,'\-/()&+#@№]/g, '');
    }
    return raw.replace(/[<>{}[\]\\]/g, '');
  };

  const common: any = {
    value: value ?? '',
    disabled: readOnly,
    onChange: (e: any) => onChange(sanitizeText(e.target.value)),
    onBlur: () => setTouched(true),
    onKeyDown: (e: any) => {
      // Пропускаем служебные клавиши (Backspace, стрелки, Tab, Enter, Ctrl+...)
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (def.lettersOnly && !/[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ\s'\-]/.test(e.key)) {
        e.preventDefault();
      } else if (def.latinDigits && !/[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ0-9]/.test(e.key)) {
        e.preventDefault();
      } else if (def.digitsOnly) {
        if (!/\d/.test(e.key)) e.preventDefault();
      } else if (def.kind === 'number') {
        if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
      } else if (def.kind === 'email' && !/[A-Za-z0-9._%+\-@]/.test(e.key)) {
        e.preventDefault();
      }
    },
    onPaste: (e: any) => {
      // На любой paste — пропускаем через sanitizeText, чтобы запрещённые
      // символы не попали в значение даже через буфер обмена.
      const pasted = e.clipboardData.getData('text');
      const cleaned = sanitizeText(pasted);
      if (cleaned !== pasted) {
        e.preventDefault();
        if (cleaned) onChange((value || '') + cleaned);
      }
    },
    placeholder: def.placeholder,
  };

  if (def.kind === 'radio' && def.options) {
    return (
      <div className="af-field">
        <label className="af-label">
          {def.label} <span className="af-label-en">{def.labelEn}</span>
          {!def.optional && <span className="af-required">*</span>}
        </label>
        <div className="af-radio-group">
          {def.options.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={readOnly}
              className={`af-chip${value === o.value ? ' active' : ''}`}
              onClick={() => { setTouched(true); !readOnly && onChange(value === o.value ? '' : o.value); }}
            >
              {value === o.value && <Icon name="check" size={14} />}
              {o.label}
            </button>
          ))}
        </div>
        {error && <div className="af-field-error">{error}</div>}
      </div>
    );
  }

  if (def.kind === 'textarea') {
    return (
      <div className="af-field af-field-wide">
        <label className="af-label">
          {def.label} <span className="af-label-en">{def.labelEn}</span>
          {def.optional && <span className="af-optional">— необязательно</span>}
        </label>
        <textarea {...common} rows={3} className={error ? 'af-input-error' : ''} />
        {error && <div className="af-field-error">{error}</div>}
      </div>
    );
  }

  if (def.kind === 'year') {
    return (
      <div className="af-field">
        <label className="af-label">
          {def.label} <span className="af-label-en">{def.labelEn}</span>
          {!def.optional && <span className="af-required">*</span>}
        </label>
        <select {...common} className={error ? 'af-input-error' : ''}>
          <option value="">—</option>
          {def.allowPresent && <option value={PRESENT_VALUE}>{PRESENT_LABEL}</option>}
          {Array.from({ length: 60 }, (_, i) => CURRENT_YEAR + 5 - i).map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        {error && <div className="af-field-error">{error}</div>}
      </div>
    );
  }

  if (def.kind === 'tel') {
    return (
      <div className="af-field">
        <label className="af-label">
          {def.label} <span className="af-label-en">{def.labelEn}</span>
          {def.optional && <span className="af-optional">— необязательно</span>}
        </label>
        <PhoneInput value={value || ''} onChange={(v) => { setTouched(true); onChange(v); }} disabled={readOnly} error={!!error} />
        {error && <div className="af-field-error">{error}</div>}
      </div>
    );
  }

  if (def.kind === 'select' && def.options) {
    return (
      <div className="af-field">
        <label className="af-label">
          {def.label} <span className="af-label-en">{def.labelEn}</span>
          {def.optional && <span className="af-optional">— необязательно</span>}
        </label>
        <select
          {...common}
          value={value || (def.noEmpty ? def.options[0].value : '')}
          className={error ? 'af-input-error' : ''}
        >
          {!def.noEmpty && <option value="">— выберите —</option>}
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {error && <div className="af-field-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="af-field">
      <label className="af-label">
        {def.label} <span className="af-label-en">{def.labelEn}</span>
        {def.optional && <span className="af-optional">— необязательно</span>}
      </label>
      <input
        type={def.kind || 'text'}
        {...common}
        min={def.kind === 'number' ? def.min : undefined}
        max={def.kind === 'number' ? def.max : undefined}
        step={def.kind === 'number' && def.max !== undefined && def.max <= 9 ? 0.5 : undefined}
        className={error ? 'af-input-error' : ''}
      />
      {error && <div className="af-field-error">{error}</div>}
    </div>
  );
}

function SectionFields({
  section,
  value,
  onChange,
  readOnly,
}: {
  section: SectionDef;
  value: any;
  onChange: (v: any) => void;
  readOnly?: boolean;
}) {
  if (section.fields) {
    return (
      <div className="af-grid">
        {section.fields.map((f) => (
          <Field
            key={f.key}
            def={f}
            value={value?.[f.key] ?? ''}
            onChange={(v) => onChange({ ...(value || {}), [f.key]: v })}
            readOnly={readOnly}
          />
        ))}
      </div>
    );
  }
  return null;
}

function TableSection({
  section,
  rows,
  onChange,
  readOnly,
}: {
  section: SectionDef;
  rows: any[];
  onChange: (rows: any[]) => void;
  readOnly?: boolean;
}) {
  const [openRows, setOpenRows] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    rows.forEach((row, i) => {
      if (row && !row.__notAttended) {
        const hasData = section.table?.columns.some((c) => row[c.key]?.toString().trim());
        if (hasData) init[i] = true;
      }
    });
    return init;
  });
  const toggleRow = (i: number) => setOpenRows((p) => ({ ...p, [i]: !p[i] }));

  if (!section.table) return null;
  const { columns, rowLabels, fixedRows, minRows, skipLabels } = section.table;
  const isCollapsible = !!fixedRows && !!rowLabels;

  const updateCell = (ri: number, key: string, v: string) => {
    const next = [...rows];
    next[ri] = { ...next[ri], [key]: v };
    onChange(next);
  };
  const setNotAttended = (ri: number, value: boolean) => {
    const next = [...rows];
    if (value) {
      const cleared: any = { __notAttended: true };
      for (const c of columns) cleared[c.key] = '';
      next[ri] = cleared;
    } else {
      next[ri] = { ...(next[ri] || {}), __notAttended: false };
    }
    onChange(next);
  };
  const addRow = () => {
    const empty: any = {};
    for (const c of columns) empty[c.key] = '';
    onChange([...rows, empty]);
  };
  const removeRow = (ri: number) => {
    if (fixedRows) return;
    if (minRows && rows.length <= minRows) return;
    onChange(rows.filter((_, i) => i !== ri));
  };

  if (isCollapsible) {
    return (
      <div className="af-table-wrap af-collapsible">
        {rows.map((row, ri) => {
          const isOpen = !!openRows[ri];
          const notAttended = !!row?.__notAttended;
          return (
            <div key={ri} className={`af-edu-row${notAttended ? ' not-attended' : ''}`}>
              <div className="af-edu-head" onClick={() => !notAttended && toggleRow(ri)}>
                <div className="af-edu-title">{rowLabels![ri] || `Строка ${ri + 1}`}</div>
                <label
                  className="af-edu-skip"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={notAttended}
                    onChange={(e) => setNotAttended(ri, e.target.checked)}
                  />
                  <span>{skipLabels?.[ri] || 'Не учился(-ась)'}</span>
                </label>
                {!notAttended && (
                  <Icon name={isOpen ? 'expand_less' : 'expand_more'} size={20} />
                )}
              </div>
              {!notAttended && isOpen && (
                <div className="af-row-cells">
                  {columns.map((c) => (
                    <Field
                      key={c.key}
                      def={c}
                      value={row?.[c.key] ?? ''}
                      onChange={(v) => updateCell(ri, c.key, v)}
                      readOnly={readOnly}
                      rowContext={row}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="af-table-wrap">
      <div className="af-table">
        {rows.map((row, ri) => (
          <div key={ri} className="af-table-row">
            {rowLabels && <div className="af-row-label">{rowLabels[ri] || `Строка ${ri + 1}`}</div>}
            <div className="af-row-cells">
              {columns.map((c) => (
                <Field
                  key={c.key}
                  def={c}
                  value={row?.[c.key] ?? ''}
                  onChange={(v) => updateCell(ri, c.key, v)}
                  readOnly={readOnly}
                  rowContext={row}
                />
              ))}
            </div>
            {!fixedRows && rows.length > (minRows || 1) && !readOnly && (
              <button
                type="button"
                className="af-row-remove"
                onClick={() => removeRow(ri)}
                title="Удалить строку"
              >
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      {!fixedRows && !readOnly && (
        <button type="button" className="af-add-row" onClick={addRow}>
          <Icon name="add" size={16} /> Добавить ещё
        </button>
      )}
    </div>
  );
}

type Props = {
  studentId: string;
  initialForm: any;
  canEdit: boolean;
  onSaved?: () => void;
};

export default function ApplicationFormSection({ studentId, initialForm, canEdit, onSaved }: Props) {
  const [form, setForm] = useState<any>(initialForm || emptyForm());
  const [manualSaving, setManualSaving] = useState(false);
  const [manualSaved, setManualSaved] = useState(false);
  // Локальные изменения, ещё не отправленные на сервер. Авто-сохранения
  // нет — изменения уходят в БД только по нажатию «Сохранить анкету».
  const [dirty, setDirty] = useState(false);
  const [externalConflict, setExternalConflict] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    personal: true,
  });

  const updateForm = (next: any) => {
    setForm(next);
    setDirty(true);
  };

  // Подхватываем обновления извне (родитель сделал reload). Если у
  // пользователя есть локальные несохранённые изменения — НЕ перезаписываем,
  // только показываем баннер о конфликте.
  useEffect(() => {
    if (!initialForm) return;
    if (dirty) {
      const same = JSON.stringify(initialForm) === JSON.stringify(form);
      if (!same) setExternalConflict(true);
      return;
    }
    setForm(initialForm);
    setExternalConflict(false);
  }, [JSON.stringify(initialForm)]);

  // Защита от потери несохранённых изменений: beforeunload + клики по
  // внутренним ссылкам + кнопка "назад" в браузере. Модалку рендерим
  // в конце компонента (после основного контента).
  const { modal: unsavedChangesModal } = useUnsavedChangesGuard(dirty);

  const onManualSave = async () => {
    if (!form || manualSaving || !dirty) return;
    setManualSaving(true);
    setManualSaved(false);
    try {
      await updateStudentForm(studentId, form);
      setManualSaved(true);
      setDirty(false);
      setExternalConflict(false);
      onSaved?.();
      setTimeout(() => setManualSaved(false), 2500);
    } catch {
      // silent — пользователь увидит, что dirty не сбросился, и попробует ещё раз
    } finally {
      setManualSaving(false);
    }
  };

  const progress = countProgress(form);
  const percent = progress.total ? Math.round((progress.filled / progress.total) * 100) : 0;

  const toggle = (key: string) =>
    setOpenSections((p) => ({ ...p, [key]: !p[key] }));

  return (
    <section className="stu-card af-card">
      <div className="af-header">
        <div>
          <h2 className="stu-section-title" style={{ margin: 0 }}>
            Application Form — Анкета студента
          </h2>
          <div className="af-sub" style={canEdit && dirty ? { color: 'var(--danger)' } : undefined}>
            {!canEdit
              ? 'Просмотр анкеты (редактирование недоступно)'
              : dirty
                ? 'У вас есть несохранённые изменения — не забудьте нажать «Сохранить анкету»'
                : 'Не забудьте нажать «Сохранить анкету» после редактирования'}
          </div>
        </div>
        <div className="af-save-state">
          {canEdit && manualSaved && (
            <span className="af-save saved">
              <Icon name="check_circle" size={16} /> Сохранено
            </span>
          )}
        </div>
      </div>

      {externalConflict && (
        <div className="af-conflict-banner">
          <Icon name="warning" size={16} />
          Анкета была изменена другим пользователем. Сохраните свои правки или обновите страницу,
          чтобы увидеть актуальную версию.
        </div>
      )}

      <div className="af-progress">
        <div className="af-progress-text">
          <span>Заполнено <b>{progress.filled}</b> из {progress.total} полей</span>
          <span className="af-progress-percent">{percent}%</span>
        </div>
        <div className="af-progress-bar">
          <motion.div
            className="af-progress-fill"
            animate={{ width: `${percent}%` }}
            transition={{ duration: 0.4 }}
          />
        </div>
      </div>

      <div className="af-note">
        <Icon name="info" size={18} />
        <div>
          Заполняйте поля <b>на английском языке</b> (как в паспорте). Анкета войдёт в пакет документов.
        </div>
      </div>

      <div className="af-sections">
        {FORM_SECTIONS.map((section) => {
          const isOpen = openSections[section.key] ?? false;
          return (
            <div key={section.key} className={`af-section${isOpen ? ' open' : ''}`}>
              <button
                type="button"
                className="af-section-head"
                onClick={() => toggle(section.key)}
              >
                <div className="af-section-head-left">
                  <div className="af-section-icon">
                    <Icon name={section.icon} size={18} />
                  </div>
                  <div>
                    <div className="af-section-title">{section.title}</div>
                    {section.titleEn && <div className="af-section-title-en">{section.titleEn}</div>}
                  </div>
                </div>
                <Icon
                  name={isOpen ? 'expand_less' : 'expand_more'}
                  size={24}
                  style={{ color: 'var(--text-soft)' }}
                />
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    key="body"
                    className="af-section-body"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {section.fields && (
                      <SectionFields
                        section={section}
                        value={form[section.key] || {}}
                        onChange={(v) => updateForm({ ...form, [section.key]: v })}
                        readOnly={!canEdit}
                      />
                    )}
                    {section.table && (
                      <TableSection
                        section={section}
                        rows={form[section.key] || []}
                        onChange={(rows) => updateForm({ ...form, [section.key]: rows })}
                        readOnly={!canEdit}
                      />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {canEdit && (
          <div className="af-save-bar af-save-bar-bottom">
            <button
              type="button"
              className="btn btn-primary af-save-btn"
              onClick={onManualSave}
              disabled={manualSaving || !dirty}
              title={!dirty ? 'Нет изменений для сохранения' : 'Сохранить анкету'}
            >
              <Icon name="save" size={18} />
              {manualSaving ? 'Сохраняем...' : manualSaved ? 'Сохранено ✓' : 'Сохранить анкету'}
            </button>
            <div className="af-save-hint">
              {dirty
                ? 'Изменения сохранятся только после нажатия кнопки'
                : 'Все изменения сохранены'}
            </div>
          </div>
        )}
      </div>
      {unsavedChangesModal}
    </section>
  );
}
