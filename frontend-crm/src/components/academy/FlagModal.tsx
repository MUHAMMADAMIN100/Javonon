import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import CrmSelect from '../CrmSelect';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { FLAGS_FOR_DECISION, giveFlag } from '../../api/academy';
import { FlagDots } from './academyUi';

/**
 * Красный флаг ученику — всегда с причиной. Окно предупреждает, что этот
 * флаг станет третьим: после него руководство решает, отчислять ли.
 */
export default function FlagModal({
  student,
  groups,
  onClose,
  onDone,
}: {
  student: { id: string; fullName: string; flags: number };
  /** Группы, от имени которых можно поставить флаг (учителю — его). */
  groups: Array<{ id: string; name: string }>;
  onClose: () => void;
  onDone: (r: { activeFlags: number; needsDecision: boolean }) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [reason, setReason] = useState('');
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [touched, setTouched] = useState(false);
  const tooShort = reason.trim().length < 3;
  const willDecide = student.flags + 1 >= FLAGS_FOR_DECISION;

  const mut = useMutation({
    mutationFn: () => giveFlag(student.id, reason.trim(), groupId || undefined),
    onSuccess: (r) => {
      toast(
        r.needsDecision ? t('academy.flags.givenDecision') : t('academy.flags.given'),
        r.needsDecision ? 'info' : 'success',
      );
      onDone(r);
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  return (
    <FormModal open title={`${t('academy.flags.give')} — ${student.fullName}`} onClose={onClose} busy={mut.isPending} width={540} testId="flag-modal">
      <div className="acad-flag-now">
        <span>{t('academy.flags.now')}</span>
        <FlagDots count={student.flags} />
        <b>{student.flags} / {FLAGS_FOR_DECISION}</b>
      </div>
      {groups.length > 1 && (
        <div className="form-group">
          <label>{t('classes.field.group')}</label>
          <CrmSelect className="crm-select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </CrmSelect>
        </div>
      )}
      <div className="form-group">
        <label>{t('academy.flags.reason')} *</label>
        <textarea
          className={`crm-textarea${touched && tooShort ? ' input-error' : ''}`}
          rows={3}
          maxLength={500}
          value={reason}
          autoFocus
          placeholder={t('academy.flags.reasonPh')}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => setTouched(true)}
          data-testid="flag-reason"
        />
        {touched && tooShort && <div className="form-error-text">{t('academy.flags.reasonRequired')}</div>}
      </div>
      {willDecide && (
        <div className="acad-warn" data-testid="flag-third-warning">
          <Icon name="warning" size={18} />
          <span>{t('academy.flags.thirdWarning')}</span>
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={tooShort || mut.isPending}
          onClick={() => mut.mutate()}
          data-testid="flag-submit"
        >
          <Icon name="flag" size={16} /> {mut.isPending ? t('common.saving') : t('academy.flags.give')}
        </button>
      </div>
    </FormModal>
  );
}
