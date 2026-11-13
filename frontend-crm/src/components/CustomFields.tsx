import { useQuery } from '@tanstack/react-query';
import CrmSelect from './CrmSelect';
import CrmDatePicker from './CrmDatePicker';
import { Field } from './ProfileParts';
import { useT, type Lang } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { fetchLeadFields, type CustomValues, type LeadField } from '../api/leadFields';

/**
 * Свои поля анкеты лида («Лиды → Настройки → Поля анкеты», 13.11.2026):
 * ввод в формах лида и студента, показ в карточках, подписи для таблицы
 * и выгрузки. Список полей — один запрос на всю CRM (кеш react-query,
 * сброс — событием lookups:changed в Layout).
 */
export const LEAD_FIELDS_KEY = ['lead-fields'] as const;

export function useLeadFields(): LeadField[] {
  const authed = useAuth((s) => !!s.user);
  const q = useQuery({ queryKey: LEAD_FIELDS_KEY, queryFn: fetchLeadFields, staleTime: 5 * 60_000, enabled: authed });
  return q.data ?? [];
}

export function fieldLabel(f: LeadField, lang: Lang): string {
  return (lang === 'tg' ? f.labelTg : f.labelRu) || f.labelRu;
}

function optionLabel(f: LeadField, key: string, lang: Lang): string {
  const o = (f.options ?? []).find((x) => x.key === key);
  return o ? (lang === 'tg' ? o.labelTg : o.labelRu) || o.labelRu : key;
}

/** Значение поля текстом — для карточки, таблицы и выгрузки. '' — не заполнено. */
export function formatCustom(f: LeadField, v: unknown, lang: Lang, yesNo: [string, string]): string {
  if (v === undefined || v === null || v === '') return '';
  switch (f.type) {
    case 'NUMBER':
      return typeof v === 'number' ? v.toLocaleString('ru-RU') : String(v);
    case 'DATE': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
      return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v);
    }
    case 'BOOL':
      return v === true ? yesNo[0] : v === false ? yesNo[1] : '';
    case 'SELECT':
      return optionLabel(f, String(v), lang);
    case 'MULTI':
      return Array.isArray(v) ? v.map((k) => optionLabel(f, String(k), lang)).join(', ') : '';
    default:
      return String(v);
  }
}

export function useFormatCustom() {
  const { t, lang } = useT();
  const yesNo: [string, string] = [t('common.yes'), t('common.no')];
  return (f: LeadField, v: unknown) => formatCustom(f, v, lang, yesNo);
}

/** Состояние формы: строки для полей ввода, массив — для «несколько вариантов». */
export type CustomDraft = Record<string, string | string[]>;

export function toDraft(fields: LeadField[], values: CustomValues | null | undefined): CustomDraft {
  // Значения переводим без оглядки на список полей: он может прийти позже формы.
  const out: CustomDraft = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    out[k] = Array.isArray(v) ? v.map(String) : typeof v === 'boolean' ? (v ? 'true' : 'false') : v == null ? '' : String(v);
  }
  for (const f of fields) if (!(f.key in out)) out[f.key] = f.type === 'MULTI' ? [] : '';
  return out;
}

/** Поменялись ли ответы (сравниваем то, что ушло бы на сервер). */
export function draftChanged(fields: LeadField[], draft: CustomDraft, values: CustomValues | null | undefined): boolean {
  return JSON.stringify(draftToPayload(fields, draft)) !== JSON.stringify(draftToPayload(fields, toDraft(fields, values)));
}

/** Черновик → то, что уходит на сервер: пустое — null (снять значение). */
export function draftToPayload(fields: LeadField[], draft: CustomDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = draft[f.key];
    if (f.type === 'MULTI') {
      out[f.key] = Array.isArray(v) && v.length ? v : null;
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) { out[f.key] = null; continue; }
    if (f.type === 'NUMBER') out[f.key] = Number(s.replace(',', '.').replace(/\s/g, ''));
    else if (f.type === 'BOOL') out[f.key] = s === 'true';
    else out[f.key] = s;
  }
  return out;
}

/** Ошибки черновика: { ключ поля: текст }. */
export function validateDraft(fields: LeadField[], draft: CustomDraft, t: (k: string) => string): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of fields) {
    const v = draft[f.key];
    const empty = Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim();
    if (empty) {
      if (f.required) errs[f.key] = t('cf.err.required');
      continue;
    }
    const s = String(v).trim();
    if (f.type === 'NUMBER' && !Number.isFinite(Number(s.replace(',', '.').replace(/\s/g, '')))) errs[f.key] = t('cf.err.number');
    if (f.type === 'TEXT') {
      if (s.length > 500) errs[f.key] = t('cf.err.long');
      else if (/[<>]/.test(s)) errs[f.key] = t('cf.err.html');
    }
  }
  return errs;
}

/** Блок «Анкета» в форме лида или студента. */
export function CustomFieldInputs({
  fields,
  draft,
  onChange,
  errors,
  showErrors,
}: {
  fields: LeadField[];
  draft: CustomDraft;
  onChange: (key: string, value: string | string[]) => void;
  errors: Record<string, string>;
  showErrors: boolean;
}) {
  const { t, lang } = useT();
  if (!fields.length) return null;
  return (
    <fieldset className="cf-block" data-testid="cf-block">
      <legend className="cf-legend">{t('cf.title')}</legend>
      <div className="form-grid-2 cf-grid">
        {fields.map((f) => {
          const err = showErrors ? errors[f.key] : undefined;
          const id = `cf-${f.key}`;
          const v = draft[f.key];
          return (
            <div key={f.key} className={`form-group${f.type === 'MULTI' || f.type === 'TEXT' ? ' cf-wide' : ''}`}>
              <label htmlFor={id}>{fieldLabel(f, lang)}{f.required ? ' *' : ''}</label>
              {f.type === 'TEXT' && (
                <input id={id} className={`crm-input${err ? ' input-error' : ''}`} value={String(v ?? '')} maxLength={500}
                  onChange={(e) => onChange(f.key, e.target.value)} data-testid={id} />
              )}
              {f.type === 'NUMBER' && (
                <input id={id} className={`crm-input${err ? ' input-error' : ''}`} value={String(v ?? '')} inputMode="decimal"
                  onChange={(e) => onChange(f.key, e.target.value)} data-testid={id} />
              )}
              {f.type === 'DATE' && (
                <div data-testid={id}>
                  <CrmDatePicker value={String(v ?? '')} onChange={(x) => onChange(f.key, x)} />
                </div>
              )}
              {f.type === 'SELECT' && (
                <CrmSelect className={`crm-select${err ? ' input-error' : ''}`} value={String(v ?? '')}
                  onChange={(e) => onChange(f.key, e.target.value)} data-testid={id}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o.key} value={o.key}>{(lang === 'tg' ? o.labelTg : o.labelRu) || o.labelRu}</option>
                  ))}
                </CrmSelect>
              )}
              {f.type === 'BOOL' && (
                <CrmSelect className={`crm-select${err ? ' input-error' : ''}`} value={String(v ?? '')}
                  onChange={(e) => onChange(f.key, e.target.value)} data-testid={id}>
                  <option value="">—</option>
                  <option value="true">{t('common.yes')}</option>
                  <option value="false">{t('common.no')}</option>
                </CrmSelect>
              )}
              {f.type === 'MULTI' && (
                <div className="cf-multi" role="group" aria-label={fieldLabel(f, lang)} data-testid={id}>
                  {(f.options ?? []).map((o) => {
                    const arr = Array.isArray(v) ? v : [];
                    const on = arr.includes(o.key);
                    return (
                      <label key={o.key} className={`cf-chip${on ? ' is-on' : ''}`}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => onChange(f.key, on ? arr.filter((x) => x !== o.key) : [...arr, o.key])}
                          data-testid={`${id}-${o.key}`}
                        />
                        {(lang === 'tg' ? o.labelTg : o.labelRu) || o.labelRu}
                      </label>
                    );
                  })}
                </div>
              )}
              {err && <div className="form-error-text" role="alert">{err}</div>}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Значения своих полей строками карточки (лид, студент). */
export function CustomFieldRows({ values }: { values: CustomValues | null | undefined }) {
  const { lang } = useT();
  const fields = useLeadFields();
  const fmt = useFormatCustom();
  return (
    <>
      {fields.map((f) => {
        const text = fmt(f, values?.[f.key]);
        return (
          <Field
            key={f.key}
            label={fieldLabel(f, lang)}
            testId={`field-cf-${f.key}`}
            wide={f.type === 'TEXT' || f.type === 'MULTI'}
            value={text || '—'}
          />
        );
      })}
    </>
  );
}
