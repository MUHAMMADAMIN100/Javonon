import { useMemo, useState } from 'react';
import CrmSelect from '../components/CrmSelect';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { tjFormatFull } from '../lib/tjTime';
import Icon from '../Icon';
import Loading from '../components/Loading';
import BackButton from '../components/BackButton';
import DismissedMark from '../components/DismissedMark';
import JournalTab from '../components/academy/JournalTab';
import LessonsTab from '../components/academy/LessonsTab';
import GroupStudentsTab from '../components/academy/GroupStudentsTab';
import { usePatternText, weekdayKey, tjWeekdayOf } from '../components/academy/academyUi';
import { weeklyPatternOf } from '../components/academy/pattern';
import { useRoleLabel } from '../lib/labels';
import {
  getGroup,
  updateGroup,
  deleteGroup,
  type StudyGroupDetail,
  type StudyGroupStatus,
} from '../api/studyGroups';
import { listPrograms } from '../api/programs';
import { listUsers } from '../api/users';

type Tab = 'journal' | 'lessons' | 'students' | 'settings';
const TABS: Tab[] = ['journal', 'lessons', 'students', 'settings'];

/**
 * Карточка группы академии: шапка (учитель, программа, дни занятий,
 * ближайшее занятие) и вкладки:
 *   «Журнал»   — посещение, оценки, комментарии, итоги недель, график;
 *   «Уроки»    — занятия с темой, ДЗ и материалами, шаблон расписания;
 *   «Ученики»  — состав, средний балл, флаги, добавление и выход;
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
          <span className={g.status === 'ACTIVE' ? 'badge badge-success' : 'badge badge-gray'}>
            {t(`groups.status.${g.status}`)}
          </span>
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
            <Icon name={k === 'journal' ? 'grading' : k === 'lessons' ? 'event_note' : k === 'students' ? 'group' : 'tune'} size={16} />
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
      {tab === 'settings' && g.access.manage && (
        <div className="card acad-card-pad">
          <GroupSettings group={g} onSaved={invalidate} />
        </div>
      )}
    </>
  );
}

/** Правка группы — название, программа, учитель, статус, описание; удаление. */
function GroupSettings({ group, onSaved }: { group: StudyGroupDetail; onSaved: () => void }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const roleLabel = useRoleLabel();
  const [name, setName] = useState(group.name);
  const [programId, setProgramId] = useState(group.programId || '');
  const [teacherId, setTeacherId] = useState(group.teacherId || '');
  const [status, setStatus] = useState<StudyGroupStatus>(group.status);
  const [description, setDescription] = useState(group.description || '');

  const programs = useQuery({ queryKey: keys.programs.list(), queryFn: () => listPrograms() });
  const users = useQuery({ queryKey: keys.users.list(), queryFn: () => listUsers() });
  // Учителя академии — первыми: обычно группу ведёт именно учитель.
  const teacherOptions = useMemo(() => {
    const list = [...(users.data ?? [])];
    const isTeacher = (u: any) => u.role === 'TEACHER' || (u.roles || []).includes('TEACHER');
    return list.sort((a, b) => Number(isTeacher(b)) - Number(isTeacher(a)) || a.fullName.localeCompare(b.fullName, 'ru'));
  }, [users.data]);

  const mut = useMutation({
    // Пустая строка в programId/teacherId — осознанное «отвязать»: бэк
    // трактует её как disconnect, а undefined как «не трогать».
    mutationFn: () => updateGroup(group.id, { name: name.trim(), programId, teacherId, status, description }),
    onSuccess: () => {
      toast(t('toast.saved'), 'success');
      onSaved();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteGroup(group.id),
    onSuccess: () => {
      toast(t('toast.deleted'), 'success');
      qc.invalidateQueries({ queryKey: keys.groups.all });
      navigate('/groups');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const dirty =
    name.trim() !== group.name ||
    programId !== (group.programId || '') ||
    teacherId !== (group.teacherId || '') ||
    status !== group.status ||
    description !== (group.description || '');

  const onDelete = async () => {
    const ok = await confirm({
      title: t('groups.confirm.delete'),
      message: `«${group.name}» — ${t('groups.hint.archive')}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) deleteMut.mutate();
  };

  return (
    <div data-testid="group-settings">
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>{t('groups.field.name')} *</label>
          <input className="crm-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-testid="gs-name" />
        </div>
        <div className="form-group">
          <label>{t('groups.field.teacher')}</label>
          <CrmSelect className="crm-select" value={teacherId} onChange={(e) => setTeacherId(e.target.value)} data-testid="gs-teacher">
            <option value="">{t('groups.noTeacher')}</option>
            {teacherOptions.map((u) => (
              <option key={u.id} value={u.id}>{u.fullName} · {roleLabel(u.role as string)}</option>
            ))}
          </CrmSelect>
        </div>
        <div className="form-group">
          <label>{t('groups.field.program')}</label>
          <CrmSelect className="crm-select" value={programId} onChange={(e) => setProgramId(e.target.value)}>
            <option value="">{t('groups.noProgram')}</option>
            {(programs.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </CrmSelect>
        </div>
        <div className="form-group">
          <label>{t('groups.field.status')}</label>
          <CrmSelect className="crm-select" value={status} onChange={(e) => setStatus(e.target.value as StudyGroupStatus)} data-testid="gs-status">
            <option value="ACTIVE">{t('groups.status.ACTIVE')}</option>
            <option value="ARCHIVED">{t('groups.status.ARCHIVED')}</option>
          </CrmSelect>
        </div>
      </div>
      <div className="form-group">
        <label>{t('groups.field.description')}</label>
        <textarea className="crm-textarea" rows={2} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="form-actions" style={{ marginTop: 8 }}>
        <button
          className="btn btn-primary"
          disabled={!dirty || name.trim().length < 2 || mut.isPending}
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
        <button className="btn btn-danger btn-sm" onClick={onDelete} disabled={deleteMut.isPending} data-testid="gs-delete">
          <Icon name="delete" size={15} /> {t('groups.deleteGroup')}
        </button>
      </div>
    </div>
  );
}
