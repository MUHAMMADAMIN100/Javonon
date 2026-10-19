import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import CrmSelect from '../CrmSelect';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { useRoleLabel } from '../../lib/labels';
import { listPrograms } from '../../api/programs';
import { listUsers } from '../../api/users';
import type { StudyGroup, StudyGroupStatus, UpdateStudyGroupDto } from '../../api/studyGroups';

export interface GroupFormValue {
  name: string;
  programId: string;
  teacherId: string;
  status: StudyGroupStatus;
  description: string;
}

export function groupFormValue(g: StudyGroup): GroupFormValue {
  return {
    name: g.name,
    programId: g.programId || '',
    teacherId: g.teacherId || '',
    status: g.status,
    description: g.description || '',
  };
}

export function groupFormDirty(g: StudyGroup, v: GroupFormValue) {
  const base = groupFormValue(g);
  return (
    v.name.trim() !== base.name ||
    v.programId !== base.programId ||
    v.teacherId !== base.teacherId ||
    v.status !== base.status ||
    v.description !== base.description
  );
}

/**
 * Пустая строка в programId/teacherId — осознанное «отвязать»: бэк
 * трактует её как disconnect, а undefined как «не трогать».
 */
export function groupFormPayload(v: GroupFormValue): UpdateStudyGroupDto {
  return {
    name: v.name.trim(),
    programId: v.programId,
    teacherId: v.teacherId,
    status: v.status,
    description: v.description,
  };
}

/**
 * Поля группы — название, учитель, программа, статус, описание. Одни и те
 * же в окне «Редактировать» списка групп и во вкладке «Настройки» группы.
 */
export default function GroupFields({
  value,
  onChange,
  testIdPrefix,
}: {
  value: GroupFormValue;
  onChange: (v: GroupFormValue) => void;
  testIdPrefix: string;
}) {
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const programs = useQuery({ queryKey: keys.programs.list(), queryFn: () => listPrograms() });
  const users = useQuery({ queryKey: keys.users.list(), queryFn: () => listUsers() });
  // Учителя академии — первыми: обычно группу ведёт именно учитель.
  const teacherOptions = useMemo(() => {
    const list = [...(users.data ?? [])];
    const isTeacher = (u: any) => u.role === 'TEACHER' || (u.roles || []).includes('TEACHER');
    return list.sort((a, b) => Number(isTeacher(b)) - Number(isTeacher(a)) || a.fullName.localeCompare(b.fullName, 'ru'));
  }, [users.data]);

  const set = (patch: Partial<GroupFormValue>) => onChange({ ...value, ...patch });

  return (
    <>
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>{t('groups.field.name')} *</label>
          <input
            className="crm-input"
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
            maxLength={120}
            data-testid={`${testIdPrefix}-name`}
          />
        </div>
        <div className="form-group">
          <label>{t('groups.field.teacher')}</label>
          <CrmSelect
            className="crm-select"
            value={value.teacherId}
            onChange={(e) => set({ teacherId: e.target.value })}
            data-testid={`${testIdPrefix}-teacher`}
          >
            <option value="">{t('groups.noTeacher')}</option>
            {teacherOptions.map((u) => (
              <option key={u.id} value={u.id}>{u.fullName} · {roleLabel(u.role as string)}</option>
            ))}
          </CrmSelect>
        </div>
        <div className="form-group">
          <label>{t('groups.field.program')}</label>
          <CrmSelect
            className="crm-select"
            value={value.programId}
            onChange={(e) => set({ programId: e.target.value })}
            data-testid={`${testIdPrefix}-program`}
          >
            <option value="">{t('groups.noProgram')}</option>
            {(programs.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </CrmSelect>
        </div>
        <div className="form-group">
          <label>{t('groups.field.status')}</label>
          <CrmSelect
            className="crm-select"
            value={value.status}
            onChange={(e) => set({ status: e.target.value as StudyGroupStatus })}
            data-testid={`${testIdPrefix}-status`}
          >
            <option value="ACTIVE">{t('groups.status.ACTIVE')}</option>
            <option value="ARCHIVED">{t('groups.status.ARCHIVED')}</option>
          </CrmSelect>
        </div>
      </div>
      <div className="form-group">
        <label>{t('groups.field.description')}</label>
        <textarea
          className="crm-textarea"
          rows={2}
          value={value.description}
          maxLength={1000}
          onChange={(e) => set({ description: e.target.value })}
          data-testid={`${testIdPrefix}-description`}
        />
      </div>
    </>
  );
}
