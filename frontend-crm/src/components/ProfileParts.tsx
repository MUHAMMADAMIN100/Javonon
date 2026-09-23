import type { ReactNode } from 'react';
import Icon from '../Icon';
import CrmDatePicker from './CrmDatePicker';
import { useT } from '../lib/i18n';

/**
 * Общие детали карточек-«досье»: сотрудник (UserDetail), заявка
 * (ApplicationDetail) и студент (StudentDetail) собраны из одних и тех же
 * кусков — поле «подпись над значением», «✎ Изменить» у заголовка группы и
 * цветной аватар с инициалами. Один источник — одинаковый вид везде.
 */

/** Поле: подпись сверху, значение ниже, под ним — подсказка или действия. */
export function Field({ label, value, hint, extra, wide, testId }: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  extra?: ReactNode;
  /** На всю ширину сетки — для длинного текста (комментарий). */
  wide?: boolean;
  testId?: string;
}) {
  return (
    <div className={`profile-field${wide ? ' is-wide' : ''}`} data-testid={testId}>
      <div className="profile-field-label">{label}</div>
      <div className="profile-field-value">{value}</div>
      {hint && <div className="profile-field-hint">{hint}</div>}
      {extra}
    </div>
  );
}

/** «✎ Изменить» у заголовка группы; нажата — форма открыта. */
export function EditButton({ active, onClick, testId }: { active: boolean; onClick: () => void; testId: string }) {
  const { t } = useT();
  return (
    <button type="button" className={`profile-edit-btn${active ? ' is-active' : ''}`} onClick={onClick} data-testid={testId} aria-expanded={active}>
      <Icon name={active ? 'close' : 'edit'} size={15} />
      {active ? t('common.cancel') : t('profile.edit')}
    </button>
  );
}

/** Цвет аватара — постоянный для человека (тона с читаемыми белыми инициалами). */
const HERO_COLORS = ['#c2414b', '#3d7f2f', '#2667a8', '#6b54c9', '#b8387a', '#1d7c7e', '#b4561a', '#1f5fbf'];
export function heroColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HERO_COLORS[h % HERO_COLORS.length];
}
export function heroInitials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
}

/** Общая рамка формы правки: заголовок, поля сеткой, «Отмена / Сохранить». */
export function EditForm({ title, saving, onSave, onCancel, children, footer, testId }: {
  title: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  children: ReactNode;
  /** Под сеткой полей, до кнопок — например, длинный комментарий. */
  footer?: ReactNode;
  testId?: string;
}) {
  const { t } = useT();
  return (
    <div className="profile-edit-form" data-testid={testId}>
      <div className="profile-edit-title">{title}</div>
      <div className="profile-edit-grid">{children}</div>
      {footer}
      <div className="profile-edit-actions">
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onSave} disabled={saving} data-testid="edit-save">
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

/** Поле формы правки: подпись сверху, под полем — текст ошибки. */
export function EditField({ label, error, wide, children }: { label: string; error?: string | false; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`profile-edit-field${wide ? ' is-wide' : ''}`}>
      <span className="profile-field-label">{label}</span>
      {children}
      {error && <div className="form-error-text">{error}</div>}
    </div>
  );
}

export function LabelInput({ label, value, onChange, type = 'text' }: any) {
  return (
    <EditField label={label}>
      {type === 'date' ? (
        <CrmDatePicker
          className="crm-input"
          value={value}
          onChange={(v) => onChange(v)}
          style={{ width: '100%' }}
        />
      ) : (
        <input
          className="crm-input"
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: '100%' }}
        />
      )}
    </EditField>
  );
}
