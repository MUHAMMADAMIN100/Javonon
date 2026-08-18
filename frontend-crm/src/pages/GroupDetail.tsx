import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { hasRole } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { tjFormatDate, tjFormatFull, tjFormatTime } from '../lib/tjTime';
import Icon from '../Icon';
import Loading from '../components/Loading';
import ClassSessionModal from '../components/ClassSessionModal';
import {
  getGroup,
  updateGroup,
  deleteGroup,
  addGroupMembers,
  removeGroupMember,
  type ClassSession,
  type StudyGroupStatus,
} from '../api/studyGroups';
import { listPrograms } from '../api/programs';
import { listUsers } from '../api/users';
import { listStudents } from '../api/students';

const SESSION_STATUS_CLASS: Record<string, string> = {
  SCHEDULED: 'badge badge-info',
  DONE: 'badge badge-success',
  CANCELLED: 'badge badge-gray',
};

/**
 * Карточка группы: состав, преподаватель, расписание.
 *
 * Кто что может (зеркалит StudyGroupsService):
 *   - FOUNDER/ADMIN — всё: правка группы, состав, преподаватель, занятия;
 *   - преподаватель группы — только расписание своей группы;
 *   - остальные сюда не попадают (бэк отдаёт 403 ещё на getGroup).
 */
export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const navigate = useNavigate();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();

  const canAdmin = hasRole(me, 'FOUNDER', 'ADMIN');

  const query = useQuery({
    queryKey: keys.groups.one(id || ''),
    queryFn: () => getGroup(id!),
    enabled: !!id,
  });
  const g = query.data;

  const canManageSessions = canAdmin || (!!g?.teacherId && g.teacherId === me?.id);

  const [sessionModal, setSessionModal] = useState<{ session?: ClassSession | null } | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: keys.groups.one(id || '') });
    qc.invalidateQueries({ queryKey: keys.groups.all });
  };

  const removeMemberMut = useMutation({
    mutationFn: (studentId: string) => removeGroupMember(id!, studentId),
    onSuccess: () => {
      toast(t('toast.deleted'), 'success');
      invalidate();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteGroupMut = useMutation({
    mutationFn: () => deleteGroup(id!),
    onSuccess: () => {
      toast(t('toast.deleted'), 'success');
      qc.invalidateQueries({ queryKey: keys.groups.all });
      navigate('/groups');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const list = g?.sessions ?? [];
    return {
      upcoming: list.filter((s) => new Date(s.endsAt).getTime() >= now),
      past: list.filter((s) => new Date(s.endsAt).getTime() < now).reverse(),
    };
  }, [g?.sessions]);

  if (!id) return null;
  if (query.isLoading) return <Loading />;
  if (query.isError || !g) {
    return (
      <div className="card" style={{ padding: 28 }}>
        <button className="btn btn-secondary" onClick={() => navigate('/groups')}>
          <Icon name="arrow_back" size={16} /> {t('groups.back')}
        </button>
        <h2 style={{ marginTop: 16 }}>{t('groups.notFound')}</h2>
      </div>
    );
  }

  const onDeleteGroup = async () => {
    const ok = await confirm({
      title: t('groups.confirm.delete'),
      message: `«${g.name}» — ${t('groups.hint.archive')}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) deleteGroupMut.mutate();
  };

  const onRemoveMember = async (studentId: string, fullName: string) => {
    const ok = await confirm({
      title: t('groups.confirm.removeMember'),
      message: fullName,
      danger: true,
      confirmText: t('groups.removeMember'),
    });
    if (ok) removeMemberMut.mutate(studentId);
  };

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <button className="btn btn-secondary" onClick={() => navigate('/groups')}>
          <Icon name="arrow_back" size={16} /> {t('groups.back')}
        </button>
      </div>

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 24, marginBottom: 16 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {t('groups.eyebrow')}
            </div>
            <h2 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0', wordBreak: 'break-word' }}>{g.name}</h2>
            <div style={{ fontSize: 13, color: 'var(--text-soft)' }}>
              {(g.program?.name || t('groups.noProgram')) + ' · ' + (g.teacher?.fullName || t('groups.noTeacher'))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
              {t('common.created')}: {tjFormatDate(g.createdAt)}
            </div>
          </div>
          <span className={g.status === 'ACTIVE' ? 'badge badge-success' : 'badge badge-gray'}>
            {t(`groups.status.${g.status}`)}
          </span>
        </div>

        {g.description && (
          <div style={{ padding: 12, background: 'var(--bg-soft)', borderRadius: 8, fontSize: 13, marginTop: 12 }}>
            {g.description}
          </div>
        )}

        {canAdmin && <GroupSettings group={g} onSaved={invalidate} />}

        {canAdmin && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border-soft)', paddingTop: 12, marginTop: 12 }}>
            <button className="btn btn-sm btn-danger" onClick={onDeleteGroup} disabled={deleteGroupMut.isPending}>
              <Icon name="delete" size={14} /> {t('groups.deleteGroup')}
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-soft)', alignSelf: 'center' }}>
              {t('groups.hint.archive')}
            </span>
          </div>
        )}
      </motion.div>

      {/* ─── Состав ─────────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>
          {t('groups.members')} ({g.members.length})
        </h3>

        {canAdmin && <AddMembersBox groupId={g.id} existingIds={g.members.map((m) => m.studentId)} onAdded={invalidate} />}

        {g.members.length === 0 ? (
          <div style={{ color: 'var(--text-soft)', fontSize: 13, padding: '12px 0' }}>{t('groups.noMembers')}</div>
        ) : (
          <div className="table-wrap" style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>{t('common.fullName')}</th>
                  <th>{t('common.phone')}</th>
                  <th>{t('groups.joinedAt')}</th>
                  {canAdmin && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {g.members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <span
                        style={{ cursor: 'pointer', fontWeight: 500 }}
                        onClick={() => navigate(`/students/${m.studentId}`)}
                      >
                        {m.student.fullName}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-soft)' }}>{m.student.phones?.[0] || '—'}</td>
                    <td style={{ color: 'var(--text-soft)' }}>{tjFormatDate(m.joinedAt)}</td>
                    {canAdmin && (
                      <td>
                        <button
                          className="btn btn-sm btn-secondary"
                          title={t('groups.removeMember')}
                          onClick={() => onRemoveMember(m.studentId, m.student.fullName)}
                          disabled={removeMemberMut.isPending}
                        >
                          <Icon name="person_remove" size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Расписание группы ──────────────────────────────────────────── */}
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{t('classes.sessions')} ({g.sessions.length})</h3>
          {canManageSessions && g.status === 'ACTIVE' && (
            <button className="btn btn-sm btn-primary" onClick={() => setSessionModal({})}>
              <Icon name="add" size={14} /> {t('classes.newSession')}
            </button>
          )}
        </div>

        {g.sessions.length === 0 ? (
          <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>{t('classes.empty')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {upcoming.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                editable={canManageSessions}
                onEdit={() => setSessionModal({ session: s })}
              />
            ))}
            {past.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 8 }}>
                {t('classes.pastSessions')}
              </div>
            )}
            {past.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                editable={canManageSessions}
                onEdit={() => setSessionModal({ session: s })}
                dim
              />
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {sessionModal && (
          <ClassSessionModal
            groupId={g.id}
            session={sessionModal.session}
            onClose={() => setSessionModal(null)}
            onSaved={invalidate}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function SessionRow({
  s,
  editable,
  onEdit,
  dim,
}: {
  s: ClassSession;
  editable: boolean;
  onEdit: () => void;
  dim?: boolean;
}) {
  const { t } = useT();
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--border-soft)',
        background: 'var(--bg-soft)',
        opacity: dim ? 0.65 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {tjFormatFull(s.startsAt)} — {tjFormatTime(s.endsAt)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
          {s.topic || t('classes.noTopic')}
          {s.teacher ? ` · ${s.teacher.fullName} (${t('classes.substitute')})` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className={SESSION_STATUS_CLASS[s.status] || 'badge badge-gray'}>
          {t(`classes.status.${s.status}`)}
        </span>
        {editable && (
          <button className="btn btn-sm btn-secondary" onClick={onEdit}>
            <Icon name="edit" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Правка самой группы — программа, преподаватель, статус, название. */
function GroupSettings({
  group,
  onSaved,
}: {
  group: { id: string; name: string; programId: string | null; teacherId: string | null; status: StudyGroupStatus; description: string | null };
  onSaved: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [name, setName] = useState(group.name);
  const [programId, setProgramId] = useState(group.programId || '');
  const [teacherId, setTeacherId] = useState(group.teacherId || '');
  const [status, setStatus] = useState<StudyGroupStatus>(group.status);
  const [description, setDescription] = useState(group.description || '');

  const programs = useQuery({ queryKey: keys.programs.list(), queryFn: () => listPrograms() });
  const users = useQuery({ queryKey: keys.users.list(), queryFn: () => listUsers() });

  const mut = useMutation({
    // Пустая строка в programId/teacherId — осознанное «отвязать»: бэк
    // трактует её как disconnect, а undefined как «не трогать».
    mutationFn: () =>
      updateGroup(group.id, {
        name: name.trim(),
        programId,
        teacherId,
        status,
        description,
      }),
    onSuccess: () => {
      toast(t('toast.saved'), 'success');
      onSaved();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const dirty =
    name.trim() !== group.name ||
    programId !== (group.programId || '') ||
    teacherId !== (group.teacherId || '') ||
    status !== group.status ||
    description !== (group.description || '');

  return (
    <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 14, marginTop: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <div>
          <label style={labelStyle}>{t('groups.field.name')}</label>
          <input className="crm-input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>{t('groups.field.program')}</label>
          <select className="crm-select" value={programId} onChange={(e) => setProgramId(e.target.value)}>
            <option value="">{t('groups.noProgram')}</option>
            {(programs.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t('groups.field.teacher')}</label>
          <select className="crm-select" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            <option value="">{t('groups.noTeacher')}</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>{u.fullName}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t('groups.field.status')}</label>
          <select
            className="crm-select"
            value={status}
            onChange={(e) => setStatus(e.target.value as StudyGroupStatus)}
          >
            <option value="ACTIVE">{t('groups.status.ACTIVE')}</option>
            <option value="ARCHIVED">{t('groups.status.ARCHIVED')}</option>
          </select>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={labelStyle}>{t('groups.field.description')}</label>
        <input className="crm-input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button
          className="btn btn-sm btn-primary"
          disabled={!dirty || name.trim().length < 2 || mut.isPending}
          onClick={() => mut.mutate()}
        >
          {mut.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

/**
 * Добавление студентов. Поиск с debounce и `limit` — тот же приём, что в
 * SubmissionForm: без него каждый keystroke тянул бы всю базу студентов.
 */
function AddMembersBox({
  groupId,
  existingIds,
  onAdded,
}: {
  groupId: string;
  existingIds: string[];
  onAdded: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<Array<{ id: string; fullName: string }>>([]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const results = useQuery({
    queryKey: ['students-search', debounced],
    queryFn: () => listStudents({ search: debounced, limit: 50 }),
    enabled: debounced.length >= 2,
  });

  const mut = useMutation({
    mutationFn: () => addGroupMembers(groupId, picked.map((p) => p.id)),
    onSuccess: () => {
      toast(t('toast.saved'), 'success');
      setPicked([]);
      setSearch('');
      onAdded();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const taken = new Set([...existingIds, ...picked.map((p) => p.id)]);
  const options = (results.data ?? []).filter((s) => !taken.has(s.id)).slice(0, 12);

  return (
    <div style={{ padding: 12, background: 'var(--bg-soft)', border: '1px solid var(--border-soft)', borderRadius: 10 }}>
      <label style={labelStyle}>{t('groups.addMembers')}</label>
      <input
        className="crm-input"
        placeholder={t('groups.searchStudent')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {options.map((s) => (
            <button
              key={s.id}
              className="btn btn-sm btn-secondary"
              onClick={() => setPicked((prev) => [...prev, { id: s.id, fullName: s.fullName }])}
            >
              <Icon name="add" size={13} /> {s.fullName}
            </button>
          ))}
        </div>
      )}
      {picked.length > 0 && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {picked.map((p) => (
              <span
                key={p.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 10px',
                  borderRadius: 999,
                  background: 'var(--primary-soft)',
                  fontSize: 13,
                }}
              >
                {p.fullName}
                <button
                  onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-soft)' }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn btn-sm btn-primary" onClick={() => mut.mutate()} disabled={mut.isPending}>
              {mut.isPending ? t('common.saving') : `${t('common.add')} (${picked.length})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-soft)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 4,
  display: 'block',
};
