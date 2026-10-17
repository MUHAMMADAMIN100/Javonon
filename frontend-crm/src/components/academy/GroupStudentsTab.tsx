import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import Icon from '../../Icon';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { tjFormatDate } from '../../lib/tjTime';
import { SortSelect, SortTh, useTableSort } from '../TableSort';
import { addGroupMembers, removeGroupMember, type StudyGroupDetail } from '../../api/studyGroups';
import { getJournal, pickStudents, type JournalStudent } from '../../api/academy';
import { Avatar, FlagDots, LevelBadge, TotalBadge, leftKey, pct } from './academyUi';
import FlagModal from './FlagModal';
import NewAcademyStudentModal from './NewAcademyStudentModal';

/**
 * Ученики группы: уровень, средний итог, посещаемость, флаги, «в группе с».
 * Добавляют учеников руководство (студентов агентства и учеников академии —
 * поиском по ФИО, e-mail или телефону) и учитель группы (нового ученика
 * формой или ученика академии без группы «из базы»). Убирает из группы
 * только руководство. Учитель и руководство ставят красный флаг.
 * Вышедшие (убранные, отчисленные, окончившие курс) — отдельным списком.
 */
export default function GroupStudentsTab({ group, onChanged }: { group: StudyGroupDetail; onChanged: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const canManage = group.access.manage;
  const canRun = group.access.run;
  const [flagFor, setFlagFor] = useState<JournalStudent | null>(null);
  const [creating, setCreating] = useState(false);

  // Сводки (средний итог, посещаемость, флаги) — из журнала группы.
  const journal = useQuery({ queryKey: keys.academy.journal(group.id), queryFn: () => getJournal(group.id) });
  const byId = useMemo(() => new Map((journal.data?.students ?? []).map((s) => [s.id, s])), [journal.data]);

  const active = group.members.filter((m) => !m.leftAt);
  const left = group.members.filter((m) => !!m.leftAt);

  const sort = useTableSort(active, [
    { key: 'fullName', label: t('common.fullName'), value: (m) => m.student.fullName },
    { key: 'level', label: t('academy.col.level'), value: (m) => m.student.academyLevel?.name },
    { key: 'phone', label: t('common.phone'), value: (m) => m.student.phones?.[0] },
    { key: 'avg', label: t('academy.col.avg'), type: 'number', value: (m) => byId.get(m.studentId)?.summary.avg ?? null },
    { key: 'att', label: t('academy.col.attendance'), type: 'number', value: (m) => byId.get(m.studentId)?.summary.attendancePct ?? null },
    { key: 'flags', label: t('academy.flags.title'), type: 'number', value: (m) => byId.get(m.studentId)?.flags ?? 0 },
    { key: 'joinedAt', label: t('groups.joinedAt'), type: 'date', value: (m) => m.joinedAt },
  ]);

  const invalidate = () => {
    onChanged();
    qc.invalidateQueries({ queryKey: keys.academy.journal(group.id) });
    qc.invalidateQueries({ queryKey: keys.academy.all });
  };

  const removeMut = useMutation({
    mutationFn: (studentId: string) => removeGroupMember(group.id, studentId),
    onSuccess: () => {
      toast(t('academy.students.removed'), 'success');
      invalidate();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onRemove = async (studentId: string, fullName: string) => {
    const ok = await confirm({
      title: t('groups.confirm.removeMember'),
      message: `${fullName} — ${t('academy.students.removeHint')}`,
      danger: true,
      confirmText: t('groups.removeMember'),
    });
    if (ok) removeMut.mutate(studentId);
  };

  return (
    <div className="acad-group-students" data-testid="group-students">
      {group.access.addStudents && (
        <AddStudentsBox
          groupId={group.id}
          manager={canManage}
          onAdded={invalidate}
          onCreate={() => setCreating(true)}
        />
      )}

      {active.length === 0 ? (
        <div className="acad-empty">
          <Icon name="group_add" size={40} />
          <div>{t('groups.noMembers')}</div>
        </div>
      ) : (
        <div className="table-wrap">
          <SortSelect sort={sort} />
          <table className="table acad-members">
            <thead>
              <tr>
                {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
                <th style={{ width: 1 }} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((m) => {
                const js = byId.get(m.studentId);
                return (
                  <tr key={m.id} className="acad-row" data-testid={`member-${m.studentId}`} onClick={() => navigate(`/academy/students/${m.studentId}`)}>
                    <td className="acad-name-cell">
                      <span className="acad-person">
                        <Avatar name={m.student.fullName} photoUrl={m.student.photoUrl} size={30} />
                        <span>
                          <strong>{m.student.fullName}</strong>
                          {m.student.academyOnly && <span className="acad-tag">{t('academy.tag.academyOnly')}</span>}
                        </span>
                      </span>
                    </td>
                    <td data-label={t('academy.col.level')}>
                      <LevelBadge level={m.student.academyLevel} testId={`member-level-${m.studentId}`} />
                    </td>
                    <td data-label={t('common.phone')} className="acad-nowrap">{m.student.phones?.[0] || '—'}</td>
                    <td data-label={t('academy.col.avg')}>
                      <TotalBadge total={js?.summary.avg ?? null} />
                    </td>
                    <td data-label={t('academy.col.attendance')}>{pct(js?.summary.attendancePct)}</td>
                    <td data-label={t('academy.flags.title')}>
                      <FlagDots count={js?.flags ?? 0} />
                    </td>
                    <td data-label={t('groups.joinedAt')} style={{ color: 'var(--text-soft)' }}>{tjFormatDate(m.joinedAt)}</td>
                    <td className="acad-row-actions" onClick={(e) => e.stopPropagation()}>
                      {canRun && js && group.status === 'ACTIVE' && (
                        <button
                          className="btn btn-sm btn-secondary acad-flag-btn"
                          title={t('academy.flags.give')}
                          data-testid={`flag-${m.studentId}`}
                          onClick={() => setFlagFor(js)}
                        >
                          <Icon name="flag" size={15} />
                        </button>
                      )}
                      {canManage && (
                        <button
                          className="btn btn-sm btn-secondary"
                          title={t('groups.removeMember')}
                          data-testid={`remove-${m.studentId}`}
                          onClick={() => onRemove(m.studentId, m.student.fullName)}
                          disabled={removeMut.isPending}
                        >
                          <Icon name="person_remove" size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {left.length > 0 && (
        <details className="acad-left-list" open={active.length === 0}>
          <summary>
            {t('academy.students.left')} ({left.length})
          </summary>
          {left.map((m) => (
            <div key={m.id} className="acad-left-row" onClick={() => navigate(`/academy/students/${m.studentId}`)}>
              <span>{m.student.fullName}</span>
              <LevelBadge level={m.student.academyLevel} hideEmpty />
              <span
                className={
                  m.leftReason === 'EXPELLED'
                    ? 'acad-status is-expelled'
                    : m.leftReason === 'COMPLETED'
                      ? 'acad-status is-active'
                      : 'acad-status is-nogroup'
                }
              >
                {t(leftKey(m.leftReason))}
              </span>
              <small>{tjFormatDate(m.leftAt)}</small>
            </div>
          ))}
        </details>
      )}

      <AnimatePresence>
        {flagFor && (
          <FlagModal
            student={flagFor}
            groups={[{ id: group.id, name: group.name }]}
            onClose={() => setFlagFor(null)}
            onDone={invalidate}
          />
        )}
        {creating && (
          <NewAcademyStudentModal presetGroupId={group.id} onClose={() => setCreating(false)} onCreated={invalidate} />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Добавление в группу.
 *   Руководство — поиск с задержкой по ФИО, e-mail или телефону среди
 *   студентов агентства и учеников академии.
 *   Учитель — «Из базы»: список учеников академии без группы показывается
 *   сразу, поиск сужает его. Клиентов агентства учитель не видит.
 * Выбранные — плашками, потом «Добавить (N)». Отчисленных выбрать нельзя.
 */
function AddStudentsBox({
  groupId,
  manager,
  onAdded,
  onCreate,
}: {
  groupId: string;
  manager: boolean;
  onAdded: () => void;
  onCreate: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<Array<{ id: string; fullName: string }>>([]);
  const [fromBase, setFromBase] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const listOpen = manager ? debounced.length >= 2 : fromBase;
  const results = useQuery({
    queryKey: keys.academy.pick(debounced, groupId),
    queryFn: () => pickStudents(debounced, groupId),
    enabled: listOpen,
  });

  const mut = useMutation({
    mutationFn: () => addGroupMembers(groupId, picked.map((p) => p.id)),
    onSuccess: () => {
      toast(t('academy.students.added').replace('{n}', String(picked.length)), 'success');
      setPicked([]);
      setSearch('');
      onAdded();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const pickedIds = new Set(picked.map((p) => p.id));
  const options = (results.data ?? []).filter((s) => !pickedIds.has(s.id));

  return (
    <div className="acad-add-box" data-testid="add-students-box">
      <div className="acad-add-head">
        {manager ? (
          <div className="acad-add-search">
            <Icon name="search" size={18} />
            <input
              className="crm-input"
              placeholder={t('academy.students.searchPh')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="add-student-search"
            />
          </div>
        ) : (
          <div className="acad-add-title">
            <Icon name="group_add" size={20} />
            <b>{t('academy.students.addTitle')}</b>
          </div>
        )}
        <div className="acad-add-actions">
          {!manager && (
            <button
              type="button"
              className={`btn ${fromBase ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFromBase((v) => !v)}
              aria-expanded={fromBase}
              data-testid="add-from-base"
            >
              <Icon name="person_search" size={16} /> {t('academy.students.fromBase')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onCreate} data-testid="new-academy-student">
            <Icon name="person_add" size={16} /> {t('academy.newStudent.title')}
          </button>
        </div>
      </div>

      {!manager && fromBase && (
        <div className="acad-add-base">
          <div className="acad-hint">{t('academy.students.fromBaseHint')}</div>
          <div className="acad-add-search">
            <Icon name="search" size={18} />
            <input
              className="crm-input"
              placeholder={t('academy.students.filterPh')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="add-student-search"
            />
          </div>
        </div>
      )}

      {listOpen && (
        <div className="acad-add-results" data-testid="add-results">
          {results.isFetching && !results.data ? (
            <span className="acad-hint">{t('common.loading')}</span>
          ) : options.length === 0 ? (
            <span className="acad-hint">
              {!manager && !debounced ? t('academy.students.fromBaseEmpty') : t('academy.students.notFound')}
            </span>
          ) : (
            options.map((s) => {
              const disabled = s.inGroup || s.expelled;
              return (
                <button
                  key={s.id}
                  type="button"
                  className="acad-add-option"
                  disabled={disabled}
                  data-testid={`pick-${s.id}`}
                  onClick={() => setPicked((prev) => [...prev, { id: s.id, fullName: s.fullName }])}
                >
                  <Icon name={disabled ? 'block' : 'add'} size={15} />
                  <span className="acad-add-name">{s.fullName}</span>
                  <small>
                    {[
                      s.phone,
                      s.level?.name,
                      manager ? (s.academyOnly ? t('academy.tag.academyOnly') : t('academy.tag.agency')) : null,
                      s.inGroup ? t('academy.students.alreadyIn') : null,
                      s.expelled ? t('academy.status.EXPELLED') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </button>
              );
            })
          )}
        </div>
      )}
      {picked.length > 0 && (
        <div className="acad-add-picked">
          {picked.map((p) => (
            <span key={p.id} className="acad-pill">
              {p.fullName}
              <button type="button" aria-label={t('common.delete')} onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          <button className="btn btn-primary btn-sm" onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="add-students-submit">
            {mut.isPending ? t('common.saving') : `${t('common.add')} (${picked.length})`}
          </button>
        </div>
      )}
    </div>
  );
}
