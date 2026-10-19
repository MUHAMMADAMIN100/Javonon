import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { tjFormatDate, tjFormatFull } from '../lib/tjTime';
import Icon from '../Icon';
import Loading from '../components/Loading';
import BackButton from '../components/BackButton';
import DismissedMark from '../components/DismissedMark';
import JournalTab from '../components/academy/JournalTab';
import LessonsTab from '../components/academy/LessonsTab';
import GroupStudentsTab from '../components/academy/GroupStudentsTab';
import LessonsCalendar from '../components/academy/LessonsCalendar';
import CompleteCourseModal from '../components/academy/CompleteCourseModal';
import GroupFields, { groupFormDirty, groupFormPayload, groupFormValue } from '../components/academy/GroupFields';
import { useGroupRemoval } from '../components/academy/useGroupRemoval';
import { usePatternText, weekdayKey, tjWeekdayOf } from '../components/academy/academyUi';
import { weeklyPatternOf } from '../components/academy/pattern';
import { getGroup, updateGroup, type StudyGroupDetail } from '../api/studyGroups';

type Tab = 'journal' | 'lessons' | 'students' | 'calendar' | 'settings';
const TABS: Tab[] = ['journal', 'lessons', 'students', 'calendar', 'settings'];
const TAB_ICON: Record<Tab, string> = {
  journal: 'grading',
  lessons: 'event_note',
  students: 'group',
  calendar: 'calendar_month',
  settings: 'tune',
};

/**
 * Карточка группы академии: шапка (учитель, программа, дни занятий,
 * ближайшее занятие, «Завершить курс») и вкладки:
 *   «Журнал»    — лист урока: посещение, проценты, итого, график, итоги;
 *   «Уроки»     — занятия с темой, ДЗ и материалами, дневник ДЗ, шаблон;
 *   «Ученики»   — состав, уровень, средний итог, флаги, добавление и выход;
 *   «Календарь» — занятия группы по дням месяца;
 *   «Настройки» — название, учитель, программа, статус (руководство).
 *
 * Кто что может — с сервера (access): manage — руководство академии,
 * run — учитель группы или руководство. Подменный учитель открывает
 * журнал и свои уроки.
 */
export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const patternText = usePatternText();

  const query = useQuery({
    queryKey: keys.groups.one(id || ''),
    queryFn: () => getGroup(id!),
    enabled: !!id,
  });
  const g = query.data;
  const [completing, setCompleting] = useState(false);

  const rawTab = params.get('tab') as Tab | null;
  const tab: Tab = rawTab && TABS.includes(rawTab) && (rawTab !== 'settings' || g?.access.manage) ? rawTab : 'journal';
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === 'journal') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: keys.groups.one(id || '') });
    qc.invalidateQueries({ queryKey: keys.groups.all });
  };

  const pattern = useMemo(() => weeklyPatternOf(g?.sessions ?? []), [g?.sessions]);
  const next = useMemo(() => {
    const now = Date.now();
    return (g?.sessions ?? []).find((s) => s.status !== 'CANCELLED' && new Date(s.endsAt).getTime() >= now) ?? null;
  }, [g?.sessions]);

  if (!id) return null;
  if (query.isLoading) return <Loading />;
  if (query.isError || !g) {
    return (
      <>
        <BackButton fallback="/groups" />
        <div className="card" style={{ padding: 28 }}>
          <h2>{t('groups.notFound')}</h2>
        </div>
      </>
    );
  }

  const activeCount = g.members.filter((m) => !m.leftAt).length;

  return (
    <>
      <BackButton fallback="/groups" />

      <motion.div className="card acad-group-head" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="acad-group-head-top">
          <div style={{ minWidth: 0 }}>
            <div className="acad-eyebrow">{t('groups.eyebrow')}</div>
            <h2 className="acad-group-name" data-testid="group-name">{g.name}</h2>
          </div>
          <div className="acad-group-head-right">
            {g.access.complete && (
              <button className="btn btn-secondary btn-sm" onClick={() => setCompleting(true)} data-testid="course-complete">
                <Icon name="school" size={16} /> {t('academy.course.complete')}
              </button>
            )}
            <span className={g.status === 'ACTIVE' ? 'badge badge-success' : 'badge badge-gray'}>
              {t(`groups.status.${g.status}`)}
            </span>
          </div>
        </div>
        <div className="acad-group-facts">
          <span className="acad-fact">
            <Icon name="person" size={16} />
            {g.teacher?.fullName || t('groups.noTeacher')}
            <DismissedMark person={g.teacher} />
          </span>
          {g.program && (
            <span className="acad-fact">
              <Icon name="menu_book" size={16} /> {g.program.name}
            </span>
          )}
          <span className="acad-fact">
            <Icon name="group" size={16} /> {t('academy.stats.students')}: {activeCount}
          </span>
          {pattern.length > 0 && (
            <span className="acad-fact" data-testid="group-pattern">
              <Icon name="schedule" size={16} /> {patternText(pattern)}
            </span>
          )}
          {next && (
            <span className="acad-fact is-next">
              <Icon name="event" size={16} />
              {t('academy.group.next')}: {t(`weekday.short.${weekdayKey(tjWeekdayOf(next.startsAt))}`)}, {tjFormatFull(next.startsAt)}
            </span>
          )}
        </div>
        {g.completedAt && (
          <div className="acad-course-done" data-testid="course-done">
            <Icon name="school" size={18} />
            <span>
              {t('academy.course.completedBanner').replace('{date}', tjFormatDate(g.completedAt))}
              {g.completedBy ? ` · ${g.completedBy.fullName}` : ''}
            </span>
          </div>
        )}
        {g.description && <div className="acad-group-desc">{g.description}</div>}
      </motion.div>

      <div className="acad-tabs" role="tablist">
        {TABS.filter((k) => k !== 'settings' || g.access.manage).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab(k)}
            data-testid={`group-tab-${k}`}
          >
            <Icon name={TAB_ICON[k]} size={16} />
            {t(`academy.tab.${k}`)}
            {k === 'students' && <span className="acad-tab-count">{activeCount}</span>}
          </button>
        ))}
      </div>

      {tab === 'journal' && <JournalTab groupId={g.id} meId={me?.id} onGoLessons={() => setTab('lessons')} />}
      {tab === 'lessons' && (
        <div className="card acad-card-pad">
          <LessonsTab group={g} meId={me?.id} onChanged={invalidate} />
        </div>
      )}
      {tab === 'students' && (
        <div className="card acad-card-pad">
          <GroupStudentsTab group={g} onChanged={invalidate} />
        </div>
      )}
      {tab === 'calendar' && (
        <div className="card acad-card-pad">
          <LessonsCalendar groupId={g.id} testId="group-calendar" />
        </div>
      )}
      {tab === 'settings' && g.access.manage && (
        <div className="card acad-card-pad">
          {/* Статус меняют и снаружи («В архив» из окна удаления, «Завершить
              курс») — форма начинается заново с тем, что на сервере. */}
          <GroupSettings key={g.status} group={g} onSaved={invalidate} />
        </div>
      )}

      <AnimatePresence>
        {completing && (
          <CompleteCourseModal
            groupId={g.id}
            groupName={g.name}
            onClose={() => setCompleting(false)}
            onDone={() => {
              invalidate();
              qc.invalidateQueries({ queryKey: keys.academy.all });
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * Правка группы — название, программа, учитель, статус, описание; удаление
 * тем же окном, что в списке групп (useGroupRemoval).
 */
function GroupSettings({ group, onSaved }: { group: StudyGroupDetail; onSaved: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const navigate = useNavigate();
  const [value, setValue] = useState(() => groupFormValue(group));
  const removal = useGroupRemoval({
    onDeleted: () => navigate('/groups'),
    onArchived: onSaved,
  });

  const mut = useMutation({
    mutationFn: () => updateGroup(group.id, groupFormPayload(value)),
    onSuccess: () => {
      toast(t('toast.saved'), 'success');
      onSaved();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const dirty = groupFormDirty(group, value);

  return (
    <div data-testid="group-settings">
      <GroupFields value={value} onChange={setValue} testIdPrefix="gs" />
      <div className="form-actions" style={{ marginTop: 8 }}>
        <button
          className="btn btn-primary"
          disabled={!dirty || value.name.trim().length < 2 || mut.isPending}
          onClick={() => mut.mutate()}
          data-testid="gs-save"
        >
          {mut.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>

      <div className="acad-danger-zone">
        <div>
          <b>{t('groups.deleteGroup')}</b>
          <div className="acad-hint">{t('academy.group.deleteHint')}</div>
        </div>
        <button
          className="btn btn-danger btn-sm"
          onClick={() => removal.remove(group.id)}
          disabled={removal.busyId === group.id}
          data-testid="gs-delete"
        >
          <Icon name="delete" size={15} /> {t('groups.deleteGroup')}
        </button>
      </div>
    </div>
  );
}
