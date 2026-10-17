import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import CrmSelect from '../components/CrmSelect';
import Icon from '../Icon';
import Loading from '../components/Loading';
import ListTotal from '../components/ListTotal';
import Pagination from '../components/Pagination';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import ActiveFilterChips from '../components/ActiveFilterChips';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { isAcademyManager } from '../lib/permissions';
import { enumParam, pageParam, stringParam, useUrlListState } from '../lib/useUrlListState';
import { listAcademyStudents, type AcademyStatus } from '../api/academy';
import { listGroups } from '../api/studyGroups';
import { listUsers } from '../api/users';
import { AcademyStatusBadge, Avatar, FlagDots, TotalBadge } from '../components/academy/academyUi';
import NewAcademyStudentModal from '../components/academy/NewAcademyStudentModal';

const STATUSES: AcademyStatus[] = ['ACTIVE', 'PENDING', 'EXPELLED', 'NO_GROUP'];
const TYPES = ['ACADEMY', 'AGENCY'] as const;
const PAGE_SIZE = 20;

/**
 * Ученики академии: студенты агентства в группах и ученики только академии.
 * Учитель видит учеников своих групп, руководство — всех и заводит новых.
 * Плашка «Ждут решения» — ученики с 3+ красными флагами, по которым
 * руководство ещё не решило «отчислить / оставить».
 */
export default function AcademyStudents() {
  const { t } = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const manager = isAcademyManager(me as any);
  const [creating, setCreating] = useState(false);

  const { values, setValue, reset } = useUrlListState(
    {
      search: stringParam(),
      group: stringParam('', 64),
      teacher: stringParam('', 64),
      status: enumParam(STATUSES),
      type: enumParam(TYPES),
      page: pageParam(),
    },
    { pageKey: 'page' },
  );
  const { group, teacher, status, type, page } = values;
  const [searchInput, setSearchInput] = useState(values.search);
  useEffect(() => setSearchInput(values.search), [values.search]);
  useEffect(() => {
    if (searchInput === values.search) return;
    const id = setTimeout(() => setValue('search', searchInput), 300);
    return () => clearTimeout(id);
  }, [searchInput, values.search, setValue]);

  const filters = {
    search: values.search || undefined,
    groupId: group || undefined,
    teacherId: manager ? teacher || undefined : undefined,
    type: manager ? type || undefined : undefined,
  };
  // Статус считаем на сервере, но фильтруем на месте — счётчики по всем
  // статусам нужны для плашки «Ждут решения» и подписей фильтра.
  const query = useQuery({
    queryKey: keys.academy.students(filters),
    queryFn: () => listAcademyStudents(filters),
  });
  const all = query.data?.items ?? [];
  const counts = query.data?.counts;
  const items = useMemo(() => (status ? all.filter((s) => s.status === status) : all), [all, status]);

  const totalQuery = useQuery({
    queryKey: keys.academy.students({}),
    queryFn: () => listAcademyStudents({}),
  });
  const narrowed = !!(values.search || group || teacher || status || type);

  const groupsQuery = useQuery({ queryKey: keys.groups.list({}), queryFn: () => listGroups({}) });
  const usersQuery = useQuery({ queryKey: keys.users.list(), queryFn: () => listUsers(), enabled: manager });
  const teachers = useMemo(() => {
    const ids = new Set((groupsQuery.data ?? []).map((g) => g.teacherId).filter(Boolean));
    return (usersQuery.data ?? []).filter((u) => ids.has(u.id)).sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
  }, [groupsQuery.data, usersQuery.data]);

  const sort = useTableSort(
    items,
    [
      { key: 'fullName', label: t('common.fullName'), value: (s) => s.fullName },
      { key: 'groups', label: t('academy.col.groups'), value: (s) => s.groups.map((g) => g.name).join(', ') || null },
      { key: 'avg', label: t('academy.col.avg'), type: 'number', value: (s) => s.summary.avg },
      { key: 'att', label: t('academy.col.attendance'), type: 'number', value: (s) => s.summary.attendancePct },
      { key: 'flags', label: t('academy.flags.title'), type: 'number', value: (s) => s.flags },
      { key: 'status', label: t('common.status'), value: (s) => t(`academy.status.${s.status}`) },
    ],
    { pageParam: 'page' },
  );
  useEffect(() => {
    if (!query.isSuccess) return;
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (page > pages) setValue('page', pages, { replace: true });
  }, [query.isSuccess, items.length, page, setValue]);
  const paged = sort.sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const groupName = (groupsQuery.data ?? []).find((g) => g.id === group)?.name;
  const teacherName = teachers.find((u) => u.id === teacher)?.fullName;

  return (
    <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} data-testid="academy-students">
      <div className="card-header is-titleless">
        <ListTotal noun="academyStudents" found={items.length} total={totalQuery.data?.items.length} filtered={narrowed} testId="academy-students-total" />
        <div className="card-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {manager && (
            <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="academy-new-student">
              <Icon name="person_add" size={16} /> {t('academy.newStudent.title')}
            </button>
          )}
        </div>
      </div>
      <div className="card-body">
        {!!counts?.PENDING && status !== 'PENDING' && (
          <button type="button" className="acad-pending-banner" onClick={() => setValue('status', 'PENDING')} data-testid="pending-banner">
            <Icon name="flag" size={18} />
            <span>
              {t('academy.pending.banner')} <b>{counts.PENDING}</b>
            </span>
            <span className="acad-pending-go">{t('academy.pending.show')}</span>
          </button>
        )}
        <div className="filters-search">
          <input
            className="crm-input"
            placeholder={t('academy.students.searchListPh')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            data-testid="academy-search"
          />
        </div>
        <div className="filters">
          <CrmSelect className="crm-select" value={group} onChange={(e) => setValue('group', e.target.value)} data-testid="academy-filter-group">
            <option value="">{t('academy.filter.group')}</option>
            {(groupsQuery.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </CrmSelect>
          {manager && teachers.length > 0 && (
            <CrmSelect className="crm-select" value={teacher} onChange={(e) => setValue('teacher', e.target.value)} data-testid="academy-filter-teacher">
              <option value="">{t('academy.filter.teacher')}</option>
              {teachers.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </CrmSelect>
          )}
          <CrmSelect
            className="crm-select"
            value={status}
            onChange={(e) => setValue('status', e.target.value as AcademyStatus | '')}
            data-testid="academy-filter-status"
          >
            <option value="">{t('academy.filter.status')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`academy.status.${s}`)}{counts ? ` (${counts[s]})` : ''}
              </option>
            ))}
          </CrmSelect>
          {manager && (
            <CrmSelect
              className="crm-select"
              value={type}
              onChange={(e) => setValue('type', e.target.value as '' | 'ACADEMY' | 'AGENCY')}
              data-testid="academy-filter-type"
            >
              <option value="">{t('academy.filter.type')}</option>
              <option value="ACADEMY">{t('academy.tag.academyOnly')}</option>
              <option value="AGENCY">{t('academy.tag.agency')}</option>
            </CrmSelect>
          )}
          {narrowed && (
            <button type="button" className="btn btn-secondary" onClick={() => { setSearchInput(''); reset(['search', 'group', 'teacher', 'status', 'type']); }}>
              {t('common.reset')}
            </button>
          )}
        </div>
        <ActiveFilterChips
          chips={[
            ...(group ? [{ key: 'group', label: `${t('classes.field.group')}: ${groupName ?? '…'}`, onClear: () => reset(['group']) }] : []),
            ...(teacher ? [{ key: 'teacher', label: `${t('groups.field.teacher')}: ${teacherName ?? '…'}`, onClear: () => reset(['teacher']) }] : []),
            ...(status ? [{ key: 'status', label: `${t('common.status')}: ${t(`academy.status.${status}`)}`, onClear: () => reset(['status']) }] : []),
            ...(type ? [{ key: 'type', label: type === 'ACADEMY' ? t('academy.tag.academyOnly') : t('academy.tag.agency'), onClear: () => reset(['type']) }] : []),
          ]}
        />

        <AnimatePresence mode="wait">
          {query.isLoading ? (
            <Loading />
          ) : items.length === 0 ? (
            <motion.div key="empty" className="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <div className="empty-icon"><Icon name="person_book" size={48} /></div>
              {narrowed ? t('common.empty') : t('academy.students.empty')}
            </motion.div>
          ) : (
            <motion.div key="table" className="table-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <SortSelect sort={sort} />
              <table className="table acad-students-table">
                <thead>
                  <tr>{sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}</tr>
                </thead>
                <tbody>
                  {paged.map((s) => (
                    <tr
                      key={s.id}
                      className="acad-row"
                      onClick={() => navigate(`/academy/students/${s.id}`)}
                      data-testid={`astudent-${s.id}`}
                    >
                      <td className="acad-name-cell">
                        <span className="acad-person">
                          <Avatar name={s.fullName} photoUrl={s.photoUrl} size={32} />
                          <span>
                            <strong>{s.fullName}</strong>
                            {s.academyOnly && <span className="acad-tag">{t('academy.tag.academyOnly')}</span>}
                            <small className="acad-person-sub">
                              {[s.phone, s.age !== null ? `${s.age} ${t('academy.years')}` : null].filter(Boolean).join(' · ')}
                            </small>
                          </span>
                        </span>
                      </td>
                      <td data-label={t('academy.col.groups')}>
                        {s.groups.length ? s.groups.map((g) => g.name).join(', ') : <span style={{ color: 'var(--text-light)' }}>—</span>}
                      </td>
                      <td data-label={t('academy.col.avg')}><TotalBadge total={s.summary.avg} /></td>
                      <td data-label={t('academy.col.attendance')}>
                        {s.summary.attendancePct !== null ? `${s.summary.attendancePct}%` : '—'}
                      </td>
                      <td data-label={t('academy.flags.title')}><FlagDots count={s.flags} /></td>
                      <td data-label={t('common.status')}><AcademyStatusBadge status={s.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={page} total={items.length} pageSize={PAGE_SIZE} onChange={(p) => setValue('page', p)} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {creating && (
          <NewAcademyStudentModal
            onClose={() => setCreating(false)}
            onCreated={() => qc.invalidateQueries({ queryKey: keys.academy.all })}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
