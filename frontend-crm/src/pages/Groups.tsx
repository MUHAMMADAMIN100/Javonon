import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { hasRole } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import Icon from '../Icon';
import Loading from '../components/Loading';
import { listGroups, createGroup, type StudyGroupStatus } from '../api/studyGroups';
import { listPrograms } from '../api/programs';
import { listUsers } from '../api/users';

/**
 * Учебные группы.
 *
 * Индивидуальный студент — это группа из ОДНОГО человека. Отдельной
 * «персональной» ветки в UI нет намеренно: расписание, напоминания и кабинет
 * студента читают одну и ту же связку StudyGroup → ClassSession.
 *
 * Создание группы и назначение преподавателя — FOUNDER/ADMIN (тот же рубеж,
 * что в StudyGroupsService.assertCanAdminGroups). Преподаватель видит только
 * свои группы: бэк режет выборку в `where`, поэтому фронту фильтровать нечего.
 */
export default function Groups() {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const navigate = useNavigate();
  const { toast } = useUI();
  const qc = useQueryClient();

  const canAdmin = hasRole(me, 'FOUNDER', 'ADMIN');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StudyGroupStatus | ''>('ACTIVE');
  const [creating, setCreating] = useState(false);

  const filters = useMemo(
    () => ({ search: search.trim() || undefined, status: status || undefined }),
    [search, status],
  );

  const query = useQuery({
    queryKey: keys.groups.list(filters),
    queryFn: () => listGroups(filters),
  });
  const groups = query.data ?? [];

  const createMut = useMutation({
    mutationFn: createGroup,
    onSuccess: (g) => {
      toast(t('toast.created'), 'success');
      setCreating(false);
      qc.invalidateQueries({ queryKey: keys.groups.all });
      navigate(`/groups/${g.id}`);
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('groups.eyebrow')}</span>
        <h2 className="crm-section-title">{t('groups.title')}</h2>
      </div>

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 22, marginBottom: 16 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <p style={{ color: 'var(--text-soft)', fontSize: 13, margin: 0, maxWidth: 620 }}>
            {t('groups.hint.individual')}
          </p>
          {canAdmin && !creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="add" size={16} /> {t('groups.new')}
            </button>
          )}
        </div>

        {creating && (
          <CreateGroupForm
            busy={createMut.isPending}
            onCancel={() => setCreating(false)}
            onCreate={(d) => createMut.mutate(d)}
          />
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
          <input
            className="crm-input"
            style={{ flex: '1 1 220px', minWidth: 180 }}
            placeholder={t('groups.searchGroup')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="crm-select"
            style={{ width: 190 }}
            value={status}
            onChange={(e) => setStatus(e.target.value as StudyGroupStatus | '')}
          >
            <option value="">{t('common.all')}</option>
            <option value="ACTIVE">{t('groups.status.ACTIVE')}</option>
            <option value="ARCHIVED">{t('groups.status.ARCHIVED')}</option>
          </select>
        </div>
      </motion.div>

      {query.isLoading ? (
        <Loading />
      ) : groups.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
          {t('groups.empty')}
        </div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('groups.field.name')}</th>
                <th>{t('groups.field.program')}</th>
                <th>{t('groups.field.teacher')}</th>
                <th style={{ textAlign: 'right' }}>{t('groups.membersCount')}</th>
                <th style={{ textAlign: 'right' }}>{t('groups.sessionsCount')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr
                  key={g.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/groups/${g.id}`)}
                >
                  <td style={{ fontWeight: 600 }}>{g.name}</td>
                  <td style={{ color: 'var(--text-soft)' }}>
                    {g.program?.name || t('groups.noProgram')}
                  </td>
                  <td style={{ color: 'var(--text-soft)' }}>
                    {g.teacher?.fullName || t('groups.noTeacher')}
                  </td>
                  <td style={{ textAlign: 'right' }}>{g._count?.members ?? 0}</td>
                  <td style={{ textAlign: 'right' }}>{g._count?.sessions ?? 0}</td>
                  <td>
                    <span className={g.status === 'ACTIVE' ? 'badge badge-success' : 'badge badge-gray'}>
                      {t(`groups.status.${g.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CreateGroupForm({
  onCreate,
  onCancel,
  busy,
}: {
  onCreate: (d: { name: string; programId?: string; teacherId?: string; description?: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [programId, setProgramId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [description, setDescription] = useState('');

  const programs = useQuery({ queryKey: keys.programs.list(), queryFn: () => listPrograms() });
  const users = useQuery({ queryKey: keys.users.list(), queryFn: () => listUsers() });

  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        background: 'var(--bg-soft)',
        border: '1px solid var(--border-soft)',
        borderRadius: 12,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <div>
          <label style={labelStyle}>{t('groups.field.name')} *</label>
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
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={labelStyle}>{t('groups.field.description')}</label>
        <input className="crm-input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn btn-sm btn-secondary" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button
          className="btn btn-sm btn-primary"
          disabled={name.trim().length < 2 || busy}
          onClick={() =>
            onCreate({
              name: name.trim(),
              programId: programId || undefined,
              teacherId: teacherId || undefined,
              description: description.trim() || undefined,
            })
          }
        >
          {busy ? t('common.saving') : t('common.create')}
        </button>
      </div>
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
