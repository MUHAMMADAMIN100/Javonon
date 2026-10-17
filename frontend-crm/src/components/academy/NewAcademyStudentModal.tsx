import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import CrmSelect from '../CrmSelect';
import CrmDatePicker from '../CrmDatePicker';
import PhoneInput from '../PhoneInput';
import CredRow from '../CredRow';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { tjToday } from '../../lib/tjTime';
import { STUDENT_LOGIN_URL } from '../../lib/landingUrl';
import { compose, email as emailRule, maxLen, minLen, phoneRule, required } from '../../utils/validators';
import { createAcademyStudent } from '../../api/academy';
import { listGroups } from '../../api/studyGroups';

/**
 * Ученик только академии (не клиент агентства): ФИО, телефон, e-mail для
 * входа, дата рождения, группа. Пароль создаёт сервер и показывает ОДИН
 * раз — окно сразу переключается на данные для входа с копированием.
 */
export default function NewAcademyStudentModal({
  presetGroupId,
  onClose,
  onCreated,
}: {
  presetGroupId?: string;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [birthday, setBirthday] = useState('');
  const [groupId, setGroupId] = useState(presetGroupId ?? '');
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [created, setCreated] = useState<{ id: string; fullName: string; email: string; password: string } | null>(null);

  const groups = useQuery({
    queryKey: keys.groups.list({ status: 'ACTIVE' }),
    queryFn: () => listGroups({ status: 'ACTIVE' }),
    enabled: !presetGroupId,
  });

  const errors = {
    fullName: compose(required(t('academy.newStudent.errName')), minLen(2), maxLen(120))(fullName),
    phone: compose(required(t('academy.newStudent.errPhone')), phoneRule())(phone),
    email: compose(required(t('login.err.email')), emailRule())(email),
  };
  const hasErr = Object.values(errors).some(Boolean);
  const show = (k: keyof typeof errors) => (touched[k] ? errors[k] : null);

  const mut = useMutation({
    mutationFn: () =>
      createAcademyStudent({
        fullName: fullName.trim(),
        phone,
        email: email.trim(),
        birthday: birthday || undefined,
        comment: comment.trim() || undefined,
        groupId: groupId || undefined,
      }),
    onSuccess: (r) => {
      setCreated(r);
      onCreated?.(r.id);
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const copyAll = async () => {
    if (!created) return;
    const text = `${t('userDetail.field.email')}: ${created.email}\n${t('login.password')}: ${created.password}\n${t('login.title')}: ${STUDENT_LOGIN_URL}`;
    try {
      await navigator.clipboard.writeText(text);
      toast(t('toast.copied'), 'success');
    } catch {
      toast(t('toast.error'), 'error');
    }
  };

  if (created) {
    return (
      <FormModal open title={t('academy.newStudent.done')} onClose={onClose} dirty={false} width={500} testId="academy-student-created">
        <div className="acad-created">
          <div className="acad-created-icon"><Icon name="check_circle" size={28} /></div>
          <div className="acad-created-text">
            <b>{created.fullName}</b> — {t('studentDetail.password.oneTime')}
          </div>
        </div>
        <div className="creds-box" data-testid="academy-creds">
          <CredRow label={t('userDetail.field.email')} value={created.email} />
          <CredRow label={t('login.password')} value={created.password} />
          <CredRow label={t('login.title')} value={STUDENT_LOGIN_URL.replace('https://', '')} small />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={copyAll} data-testid="academy-creds-copy">
            <Icon name="content_copy" size={16} /> {t('common.copy')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose} data-testid="academy-creds-close">
            {t('common.done')}
          </button>
        </div>
      </FormModal>
    );
  }

  return (
    <FormModal open title={t('academy.newStudent.title')} onClose={onClose} busy={mut.isPending} width={620} testId="academy-student-form">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTouched({ fullName: true, phone: true, email: true });
          if (!hasErr) mut.mutate();
        }}
      >
        <div className="acad-note" style={{ marginBottom: 16 }}>
          <Icon name="info" size={18} />
          <span>{t('academy.newStudent.hint')}</span>
        </div>
        <div className="form-group">
          <label>{t('common.fullName')} *</label>
          <input
            className={`crm-input${show('fullName') ? ' input-error' : ''}`}
            value={fullName}
            maxLength={120}
            onChange={(e) => setFullName(e.target.value)}
            onBlur={() => setTouched((p) => ({ ...p, fullName: true }))}
            data-testid="as-name"
          />
          {show('fullName') && <div className="form-error-text">{show('fullName')}</div>}
        </div>
        <div className="form-grid-2 acad-form-grid">
          <div className="form-group">
            <label>{t('common.phone')} *</label>
            <PhoneInput value={phone} onChange={(v) => { setPhone(v); setTouched((p) => ({ ...p, phone: true })); }} error={!!show('phone')} />
            {show('phone') && <div className="form-error-text">{show('phone')}</div>}
          </div>
          <div className="form-group">
            <label>{t('userDetail.field.email')} *</label>
            <input
              type="email"
              className={`crm-input${show('email') ? ' input-error' : ''}`}
              value={email}
              maxLength={160}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((p) => ({ ...p, email: true }))}
              data-testid="as-email"
            />
            {show('email') && <div className="form-error-text">{show('email')}</div>}
          </div>
        </div>
        <div className="form-grid-2 acad-form-grid">
          <div className="form-group">
            <label>{t('app.field.birthday')}</label>
            <CrmDatePicker value={birthday} onChange={setBirthday} max={tjToday()} />
          </div>
          {!presetGroupId && (
            <div className="form-group">
              <label>{t('classes.field.group')}</label>
              <CrmSelect className="crm-select" value={groupId} onChange={(e) => setGroupId(e.target.value)} data-testid="as-group">
                <option value="">{t('academy.newStudent.noGroup')}</option>
                {(groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </CrmSelect>
            </div>
          )}
        </div>
        <div className="form-group">
          <label>{t('common.comment')}</label>
          <textarea className="crm-textarea" rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={mut.isPending} data-testid="as-submit">
            {mut.isPending ? t('common.saving') : t('common.create')}
          </button>
        </div>
      </form>
    </FormModal>
  );
}
