import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { decide, type AcademyStudentCard } from '../../api/academy';

/**
 * Решение руководства по ученику: «Отчислить» (ученик выходит из всех
 * групп, оценки остаются) или «Оставить» (флаги до этого момента считаются
 * рассмотренными, следующий снова потребует решения). Комментарий виден в
 * карточке ученика, а при отчислении — и самому ученику в кабинете.
 */
export default function DecisionModal({
  student,
  action,
  onClose,
  onDone,
}: {
  student: { id: string; fullName: string };
  action: 'EXPEL' | 'KEEP';
  onClose: () => void;
  onDone: (card: AcademyStudentCard) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [note, setNote] = useState('');
  const expel = action === 'EXPEL';

  const mut = useMutation({
    mutationFn: () => decide(student.id, action, note.trim() || undefined),
    onSuccess: (card) => {
      toast(expel ? t('academy.decision.expelled') : t('academy.decision.kept'), 'success');
      onDone(card);
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  return (
    <FormModal
      open
      title={`${expel ? t('academy.decision.expel') : t('academy.decision.keep')} — ${student.fullName}`}
      onClose={onClose}
      busy={mut.isPending}
      width={540}
      testId="decision-modal"
    >
      <div className={expel ? 'acad-warn is-danger' : 'acad-note'}>
        <Icon name={expel ? 'person_remove' : 'verified_user'} size={18} />
        <span>{expel ? t('academy.decision.expelHint') : t('academy.decision.keepHint')}</span>
      </div>
      <div className="form-group" style={{ marginTop: 14 }}>
        <label>{expel ? t('academy.decision.reason') : t('academy.decision.comment')}</label>
        <textarea
          className="crm-textarea"
          rows={3}
          maxLength={500}
          value={note}
          placeholder={expel ? t('academy.decision.reasonPh') : t('academy.decision.commentPh')}
          onChange={(e) => setNote(e.target.value)}
          data-testid="decision-note"
        />
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={`btn ${expel ? 'btn-danger' : 'btn-primary'}`}
          disabled={mut.isPending}
          onClick={() => mut.mutate()}
          data-testid="decision-submit"
        >
          {mut.isPending ? t('common.saving') : expel ? t('academy.decision.expel') : t('academy.decision.keep')}
        </button>
      </div>
    </FormModal>
  );
}
