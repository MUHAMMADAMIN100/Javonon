import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import FormModal from '../FormModal';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { updateGroup, type StudyGroup } from '../../api/studyGroups';
import GroupFields, { groupFormDirty, groupFormPayload, groupFormValue } from './GroupFields';

/** «Редактировать» в списке групп — те же поля, что во вкладке «Настройки» группы. */
export default function GroupEditModal({ group, onClose }: { group: StudyGroup; onClose: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const [value, setValue] = useState(() => groupFormValue(group));
  const dirty = groupFormDirty(group, value);

  const mut = useMutation({
    mutationFn: () => updateGroup(group.id, groupFormPayload(value)),
    onSuccess: () => {
      toast(t('toast.saved'), 'success');
      qc.invalidateQueries({ queryKey: keys.groups.all });
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  return (
    <FormModal
      open
      title={t('groups.edit')}
      onClose={onClose}
      dirty={dirty}
      busy={mut.isPending}
      width={640}
      testId="group-edit"
    >
      <GroupFields value={value} onChange={setValue} testIdPrefix="ge" />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || value.name.trim().length < 2 || mut.isPending}
          onClick={() => mut.mutate()}
          data-testid="ge-save"
        >
          {mut.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </FormModal>
  );
}
