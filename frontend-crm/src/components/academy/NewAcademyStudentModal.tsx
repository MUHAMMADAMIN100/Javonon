import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import CrmSelect from '../CrmSelect';
import CrmDatePicker from '../CrmDatePicker';
import PhoneInput from '../PhoneInput';
import CredRow from '../CredRow';
import { useAuth } from '../../store/auth';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { tjToday } from '../../lib/tjTime';
import { isAcademyManager } from '../../lib/permissions';
import { STUDENT_LOGIN_URL } from '../../lib/landingUrl';
import { compose, email as emailRule, maxLen, minLen, phoneRule, required } from '../../utils/validators';
import { createAcademyStudent, listLevels } from '../../api/academy';
import { listGroups } from '../../api/studyGroups';

/**
 * Ученик только академии (не клиент агентства): ФИО, телефон, телефоны
 * отца и матери (необязательно), e-mail для входа, дата рождения, уровень,
 * группа. Пароль создаёт сервер и показывает ОДИН раз — окно сразу
 * переключается на данные для входа с копированием.
 *
 * Заводят руководство (в любую группу или без группы) и учитель — сразу в
 * свою группу: из карточки группы она подставлена, со страницы учеников
 * выбирается из его групп.
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
  const me = useAuth((s) => s.user);
  const manager = isAcademyManager(me as any);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [fatherPhone, setFatherPhone] = useState('');
  const [motherPhone, setMotherPhone] = useState('');
  const [birthday, setBirthday] = useState('');
  const [levelId, setLevelId] = useState('');
  const [groupId, setGroupId] = useState(presetGroupId ?? '');
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [created, setCreated] = useState<{ id: string; fullName: string; email: string; password: string } | null>(null);

  // Учителю сервер отдаёт только его группы.
  const groups = useQuery({
    queryKey: keys.groups.list({ status: 'ACTIVE' }),
    queryFn: () => listGroups({ status: 'ACTIVE' }),
    enabled: !presetGroupId,
  });
  const levels = useQuery({ queryKey: keys.academy.levels(), queryFn: listLevels });

  const errors = {
    fullName: compose(required(t('academy.newStudent.errName')), minLen(2), maxLen(120))(fullName),
    phone: compose(required(t('academy.newStudent.errPhone')), phoneRule())(phone),
    email: compose(required(t('login.err.email')), emailRule())(email),
    fatherPhone: phoneRule(t('academy.newStudent.errParentPhone'))(fatherPhone),
    motherPhone: phoneRule(t('academy.newStudent.errParentPhone'))(motherPhone),
    groupId: !manager && !groupId ? t('academy.newStudent.groupRequired') : undefined,
  };
  const hasErr = Object.values(errors).some(Boolean);
  const show = (k: keyof typeof errors) => (touched[k] ? errors[k] : null);

  const mut = useMutation({
    mutationFn: () =>
      createAcademyStudent({
        fullName: fullName.trim(),
        phone,
        email: email.trim(),
        fatherPhone: fatherPhone || undefined,
        motherPhone: motherPhone || undefined,
        birthday: birthday || undefined,
        comment: comment.trim() || undefined,
        groupId: groupId || undefined,
        levelId: levelId || undefined,
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

  const levelList = levels.data ?? [];

  return (
    <FormModal open title={t('academy.newStudent.title')} onClose={onClose} busy={mut.isPending} width={640} testId="academy-student-form">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTouched({ fullName: true, phone: true, email: true, fatherPhone: true, motherPhone: true, groupId: true });
          if (!hasErr) mut.mutate();
        }}
      >
        <div className="acad-note" style={{ marginBottom: 16 }}>
          <Icon name="info" size={18} />
          <span>{manager ? t('academy.newStudent.hint') : t('academy.newStudent.hintTeacher')}</span>
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
        <div className="form-grid-2 acad-form-grid" data-testid="as-parents">
          <div className="form-group">
            <label>
              {t('academy.newStudent.fatherPhone')} <span className="acad-optional">· {t('academy.newStudent.optional')}</span>
            </label>
            <PhoneInput value={fatherPhone} onChange={(v) => { setFatherPhone(v); setTouched((p) => ({ ...p, fatherPhone: true })); }} error={!!show('fatherPhone')} />
            {show('fatherPhone') && <div className="form-error-text">{show('fatherPhone')}</div>}
          </div>
          <div className="form-group">
            <label>
              {t('academy.newStudent.motherPhone')} <span className="acad-optional">· {t('academy.newStudent.optional')}</span>
            </label>
            <PhoneInput value={motherPhone} onChange={(v) => { setMotherPhone(v); setTouched((p) => ({ ...p, motherPhone: true })); }} error={!!show('motherPhone')} />
            {show('motherPhone') && <div className="form-error-text">{show('motherPhone')}</div>}
          </div>
        </div>
        <div className="form-grid-2 acad-form-grid">
          <div className="form-group">
            <label>{t('academy.col.level')}</label>
            <CrmSelect className="crm-select" value={levelId} onChange={(e) => setLevelId(e.target.value)} data-testid="as-level">
              <option value="">{t('academy.level.none')}</option>
              {levelList.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </CrmSelect>
            {levels.isSuccess && levelList.length === 0 && <div className="acad-hint" style={{ marginTop: 6 }}>{t('academy.level.emptyList')}</div>}
          </div>
          <div className="form-group">
            <label>{t('app.field.birthday')}</label>
            <CrmDatePicker value={birthday} onChange={setBirthday} max={tjToday()} />
          </div>
        </div>
        {!presetGroupId && (
          <div className="form-group">
            <label>{t('classes.field.group')}{manager ? '' : ' *'}</label>
            <CrmSelect
              className={`crm-select${show('groupId') ? ' input-error' : ''}`}
              value={groupId}
              onChange={(e) => { setGroupId(e.target.value); setTouched((p) => ({ ...p, groupId: true })); }}
              data-testid="as-group"
            >
              <option value="">{manager ? t('academy.newStudent.noGroup') : t('classes.selectGroup')}</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </CrmSelect>
            {show('groupId') && <div className="form-error-text">{show('groupId')}</div>}
          </div>
        )}
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
