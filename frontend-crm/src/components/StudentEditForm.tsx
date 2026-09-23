import { useState } from 'react';
import CrmSelect from './CrmSelect';
import CrmDatePicker from './CrmDatePicker';
import DirectionOptions from './DirectionOptions';
import { EditField, EditForm } from './ProfileParts';
import type { updateStudent } from '../api/students';
import type { Direction, OnboardingStage, Student, StudentStatus } from '../api/types';
import { compose, email as emailRule, hasErrors, maxLen, minLen, numberRule, required, validateAll } from '../utils/validators';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { useChannelLabel, useOnboardingLabel, useStudentStatusLabel } from '../lib/labels';
import { tjDateInput } from '../lib/tjTime';

export type StudentPatch = Parameters<typeof updateStudent>[1];

/**
 * Правка данных студента — одна форма на карточку заявки и карточку
 * студента (раньше там было две копии). Открывается под данными, как формы
 * в карточке сотрудника. Сохранение — через onSave страницы: у каждой своя
 * оптимистичная мутация и свой ключ кеша.
 */
export default function StudentEditForm({ student, withOnboarding, saving, onSave, onCancel }: {
  student: Student;
  /** Этап онбординга правится только в карточке студента. */
  withOnboarding?: boolean;
  saving?: boolean;
  onSave: (patch: StudentPatch) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const channelLabel = useChannelLabel();
  const statusLabel = useStudentStatusLabel();
  const onboardingLabel = useOnboardingLabel();
  const [form, setForm] = useState(() => ({
    fullName: student.fullName,
    phones: student.phones.join(', '),
    phoneLabels: (student.phoneLabels || []).join(', '),
    preferredChannel: student.preferredChannel || '',
    // tjDateInput, а не slice(0, 10): дата рождения хранится как
    // душанбинская полночь (12.03 → «2006-03-11T19:00:00.000Z»), срез
    // строки подставил бы в пикер 11-е и сохранил бы сдвиг в БД.
    birthday: tjDateInput(student.birthday),
    email: student.email || '',
    direction: student.direction as Direction,
    cabinet: String(student.cabinet ?? ''),
    status: student.status as StudentStatus,
    onboardingStage: (student.onboardingStage || 'WELCOME') as OnboardingStage,
    comment: student.comment || '',
  }));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const touch = (k: string) => () => setTouched((tt) => ({ ...tt, [k]: true }));

  const errors = validateAll(
    { fullName: form.fullName, phones: form.phones, email: form.email, cabinet: form.cabinet, comment: form.comment },
    {
      fullName: compose(required(t('app.err.fullName')), minLen(2), maxLen(100)),
      phones: (v) => {
        const s = String(v ?? '').trim();
        if (!s) return undefined;
        const parts = s.split(',').map((p: string) => p.trim()).filter(Boolean);
        for (const p of parts) {
          const digits = p.replace(/\D/g, '');
          if (digits.length < 7) return t('app.err.phoneShort').replace('{p}', p);
          if (digits.length > 15) return t('app.err.phoneLong').replace('{p}', p);
        }
        return undefined;
      },
      email: emailRule(),
      cabinet: numberRule({ min: 1, max: 99, integer: true }),
      comment: maxLen(2000),
    },
  );
  const err = (k: string) => (touched[k] && (errors as any)[k]) || undefined;

  const save = () => {
    setTouched({ fullName: true, phones: true, email: true, cabinet: true, comment: true });
    if (hasErrors(errors)) {
      toast(t('toast.error'), 'error');
      return;
    }
    const phones = form.phones.split(',').map((p) => p.trim()).filter(Boolean);
    // Подписи подгоняем под число телефонов: лишние обрезаем, недостающие — пустые.
    const phoneLabels = (form.phoneLabels || '').split(',').map((s) => s.trim());
    while (phoneLabels.length < phones.length) phoneLabels.push('');
    phoneLabels.length = phones.length;
    onSave({
      fullName: form.fullName.trim(),
      phones,
      phoneLabels,
      preferredChannel: form.preferredChannel || undefined,
      birthday: form.birthday || undefined,
      email: form.email.trim() || undefined,
      direction: form.direction,
      cabinet: parseInt(form.cabinet, 10),
      status: form.status,
      ...(withOnboarding ? { onboardingStage: form.onboardingStage || undefined } : {}),
      comment: form.comment.trim() || undefined,
    } as StudentPatch);
  };

  return (
    <EditForm
      title={t('client.section.data')}
      saving={!!saving}
      onSave={save}
      onCancel={onCancel}
      testId="client-edit-form"
      footer={
        <EditField label={t('app.field.comment')} error={err('comment')} wide>
          <textarea
            className={`crm-textarea${err('comment') ? ' input-error' : ''}`}
            value={form.comment}
            onChange={(e) => set({ comment: e.target.value })}
            onBlur={touch('comment')}
            maxLength={2000}
            rows={3}
            style={{ resize: 'none' }}
            data-testid="edit-comment"
          />
        </EditField>
      }
    >
      <EditField label={`${t('app.field.fullName')} *`} error={err('fullName')}>
        <input
          className={`crm-input${err('fullName') ? ' input-error' : ''}`}
          value={form.fullName}
          onChange={(e) => set({ fullName: e.target.value })}
          onBlur={touch('fullName')}
          maxLength={100}
          data-testid="edit-fullName"
        />
      </EditField>
      <EditField label={t('app.field.phones')} error={err('phones')}>
        <input
          className={`crm-input${err('phones') ? ' input-error' : ''}`}
          value={form.phones}
          onChange={(e) => set({ phones: e.target.value.replace(/[^\d ,+\-()]/g, '') })}
          onBlur={touch('phones')}
          placeholder="+992123456789, +992111222333"
          data-testid="edit-phones"
        />
      </EditField>
      <EditField label={t('studentDetail.field.phoneLabels')}>
        <input className="crm-input" value={form.phoneLabels} onChange={(e) => set({ phoneLabels: e.target.value })} />
      </EditField>
      <EditField label={t('app.field.preferredChannel')}>
        <CrmSelect className="crm-select" value={form.preferredChannel} onChange={(e) => set({ preferredChannel: e.target.value })}>
          <option value="">—</option>
          <option value="WHATSAPP">{channelLabel('WHATSAPP')}</option>
          <option value="PHONE">{channelLabel('PHONE')}</option>
          <option value="INSTAGRAM">{channelLabel('INSTAGRAM')}</option>
          <option value="TELEGRAM">{channelLabel('TELEGRAM')}</option>
          <option value="EMAIL">{channelLabel('EMAIL')}</option>
        </CrmSelect>
      </EditField>
      <EditField label={t('app.field.birthday')}>
        <CrmDatePicker className="crm-input" value={form.birthday} onChange={(v) => set({ birthday: v })} style={{ width: '100%' }} />
      </EditField>
      <EditField label={t('userDetail.field.email')} error={err('email')}>
        <input
          type="email"
          className={`crm-input${err('email') ? ' input-error' : ''}`}
          value={form.email}
          onChange={(e) => set({ email: e.target.value })}
          onBlur={touch('email')}
          data-testid="edit-email"
        />
      </EditField>
      <EditField label={t('app.field.direction')}>
        <CrmSelect className="crm-select" value={form.direction} onChange={(e) => set({ direction: e.target.value as Direction })}>
          <DirectionOptions />
        </CrmSelect>
      </EditField>
      <EditField label={t('app.field.cabinet')} error={err('cabinet')}>
        <input
          type="number"
          min={1}
          max={99}
          className={`crm-input${err('cabinet') ? ' input-error' : ''}`}
          value={form.cabinet}
          onChange={(e) => set({ cabinet: e.target.value.replace(/[^\d]/g, '') })}
          onBlur={touch('cabinet')}
          data-testid="edit-cabinet"
        />
      </EditField>
      <EditField label={t('common.status')}>
        <CrmSelect className="crm-select" value={form.status} onChange={(e) => set({ status: e.target.value as StudentStatus })}>
          <option value="ACTIVE">{statusLabel('ACTIVE')}</option>
          <option value="PAUSED">{statusLabel('PAUSED')}</option>
          <option value="GRADUATED">{statusLabel('GRADUATED')}</option>
          <option value="ARCHIVED">{statusLabel('ARCHIVED')}</option>
        </CrmSelect>
      </EditField>
      {withOnboarding && (
        <EditField label={t('app.field.onboarding')}>
          <CrmSelect className="crm-select" value={form.onboardingStage} onChange={(e) => set({ onboardingStage: e.target.value as OnboardingStage })}>
            <option value="WELCOME">{onboardingLabel('WELCOME')}</option>
            <option value="DOCS_COLLECTED">{onboardingLabel('DOCS_COLLECTED')}</option>
            <option value="CABINET_OPENED">{onboardingLabel('CABINET_OPENED')}</option>
            <option value="ACADEMY_INTRO">{onboardingLabel('ACADEMY_INTRO')}</option>
            <option value="ACTIVE">{onboardingLabel('ACTIVE')}</option>
          </CrmSelect>
        </EditField>
      )}
    </EditForm>
  );
}
