import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import CrmSelect from '../CrmSelect';
import Loading from '../Loading';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { completeCourse, getCoursePreview } from '../../api/academy';
import { Avatar, LevelBadge } from './academyUi';

/**
 * «Завершить курс»: у каждого ученика уже выбран следующий уровень (по
 * порядку «Академия → Уровни»), тому, кто не готов, можно оставить прежний.
 * После подтверждения ученики выходят из группы с отметкой «Окончил курс»,
 * будущие занятия отменяются, группа уходит в архив.
 */
export default function CompleteCourseModal({
  groupId,
  groupName,
  onClose,
  onDone,
}: {
  groupId: string;
  groupName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const preview = useQuery({ queryKey: keys.academy.course(groupId), queryFn: () => getCoursePreview(groupId), staleTime: 0 });
  const [choice, setChoice] = useState<Record<string, string>>({});

  // Начальный выбор — предложенный сервером следующий уровень.
  useEffect(() => {
    if (!preview.data) return;
    setChoice(Object.fromEntries(preview.data.students.map((s) => [s.id, s.suggestedLevelId ?? s.level?.id ?? ''])));
  }, [preview.data]);

  const mut = useMutation({
    mutationFn: () =>
      completeCourse(
        groupId,
        (preview.data?.students ?? []).map((s) => ({ studentId: s.id, levelId: choice[s.id] || null })),
      ),
    onSuccess: (r) => {
      toast(t('academy.course.done').replace('{n}', String(r.changed)), 'success');
      onDone();
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const p = preview.data;
  return (
    <FormModal
      open
      title={`${t('academy.course.complete')} — ${groupName}`}
      onClose={onClose}
      busy={mut.isPending}
      width={680}
      testId="complete-course-modal"
    >
      {preview.isLoading || !p ? (
        <Loading />
      ) : (
        <>
          <div className="acad-note" style={{ marginBottom: 14 }}>
            <Icon name="school" size={18} />
            <span>{p.students.length ? t('academy.course.hint') : t('academy.course.noStudents')}</span>
          </div>
          {p.students.length > 0 && p.levels.length === 0 && (
            <div className="acad-warn" style={{ marginBottom: 12 }}>
              <Icon name="info" size={18} />
              <span>{t('academy.course.noLevels')}</span>
            </div>
          )}
          {p.students.length > 0 && (
            <div className="acad-course-list" data-testid="course-list">
              <div className="acad-course-row is-head">
                <span>{t('common.fullName')}</span>
                <span>{t('academy.course.current')}</span>
                <span />
                <span>{t('academy.course.next')}</span>
              </div>
              {p.students.map((s) => {
                const chosen = choice[s.id] ?? '';
                const changed = chosen !== (s.level?.id ?? '');
                return (
                  <div key={s.id} className={`acad-course-row${changed ? ' is-changed' : ''}`} data-testid={`course-row-${s.id}`}>
                    <span className="acad-person">
                      <Avatar name={s.fullName} photoUrl={s.photoUrl} size={28} />
                      <strong>{s.fullName}</strong>
                    </span>
                    <span className="acad-course-cur">
                      <LevelBadge level={s.level} />
                    </span>
                    <Icon name="arrow_forward" size={18} className="acad-course-arrow" />
                    <CrmSelect
                      className="crm-select"
                      value={chosen}
                      onChange={(e) => setChoice((prev) => ({ ...prev, [s.id]: e.target.value }))}
                      data-testid={`course-level-${s.id}`}
                    >
                      <option value="">{t('academy.level.none')}</option>
                      {p.levels.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </CrmSelect>
                  </div>
                );
              })}
            </div>
          )}
          <div className="acad-hint" style={{ marginTop: 12 }}>
            {t('academy.course.after')}
            {p.futureLessons > 0 && ` ${t('academy.course.futureCancelled').replace('{n}', String(p.futureLessons))}`}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => mut.mutate()}
              disabled={mut.isPending}
              data-testid="course-submit"
            >
              <Icon name="school" size={16} /> {mut.isPending ? t('common.saving') : t('academy.course.complete')}
            </button>
          </div>
        </>
      )}
    </FormModal>
  );
}
