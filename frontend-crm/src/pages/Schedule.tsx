import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { hasRole } from '../lib/roles';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import { tjDateInput, tjFormatTime, tjMonthRange, tjToday } from '../lib/tjTime';
import Icon from '../Icon';
import Loading from '../components/Loading';
import ClassSessionModal from '../components/ClassSessionModal';
import { listGroups, listSessions, type ClassSession } from '../api/studyGroups';
import { listUsers } from '../api/users';

/**
 * Календарь занятий.
 *
 * Своей календарной библиотеки НЕТ и не заводится: сетка месяца — обычный
 * CSS-grid, а выбор даты в формах делает существующий CrmDatePicker
 * (react-day-picker уже в зависимостях). Границы периода уходят на бэк
 * строками `YYYY-MM-DD` — он раскрывает их в душанбинские сутки; ISO-момент,
 * посчитанный в браузере, сдвинул бы период на таймзону пользователя.
 */

const SESSION_COLOR: Record<string, string> = {
  SCHEDULED: '#0ea5e9',
  DONE: '#10b981',
  CANCELLED: '#94a3b8',
};

/** Индекс дня недели «понедельник = 0» для календарной даты. */
function mondayIndex(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export default function Schedule() {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const elevated = hasRole(me, 'FOUNDER', 'ADMIN');

  const [monthOffset, setMonthOffset] = useState(0);
  const [groupId, setGroupId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [view, setView] = useState<'month' | 'agenda'>('month');
  const [selectedDay, setSelectedDay] = useState<string>(tjToday());
  const [modal, setModal] = useState<{ session?: ClassSession | null; day?: string } | null>(null);

  // Границы месяца считаются в душанбинском календаре (tjMonthRange), а не
  // через new Date(...) в браузере.
  const range = useMemo(() => tjMonthRange(monthOffset), [monthOffset]);
  const [year, month] = range.from.split('-').map(Number);

  const params = useMemo(
    () => ({
      from: range.from,
      to: range.to,
      groupId: groupId || undefined,
      teacherId: elevated && teacherId ? teacherId : undefined,
    }),
    [range.from, range.to, groupId, teacherId, elevated],
  );

  const sessionsQuery = useQuery({
    queryKey: keys.groups.sessions(params),
    queryFn: () => listSessions(params),
  });
  const sessions = sessionsQuery.data ?? [];

  const groupsQuery = useQuery({
    queryKey: keys.groups.list({ status: 'ACTIVE' }),
    queryFn: () => listGroups({ status: 'ACTIVE' }),
  });
  const groups = groupsQuery.data ?? [];

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
    enabled: elevated,
  });

  /** Занятия по календарным дням Душанбе: ключ — `YYYY-MM-DD` начала. */
  const byDay = useMemo(() => {
    const map = new Map<string, ClassSession[]>();
    for (const s of sessions) {
      const key = tjDateInput(s.startsAt);
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [sessions]);

  const cells = useMemo(() => {
    const lead = mondayIndex(year, month, 1);
    const total = daysInMonth(year, month);
    const out: Array<string | null> = Array(lead).fill(null);
    for (let d = 1; d <= total; d++) {
      out.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [year, month]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: keys.groups.all });
  };

  const today = tjToday();
  const daySessions = byDay.get(selectedDay) ?? [];

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('groups.eyebrow')}</span>
        <h2 className="crm-section-title">{t('classes.title')}</h2>
      </div>

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 18, marginBottom: 16 }}
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn btn-sm btn-secondary" onClick={() => setMonthOffset((o) => o - 1)}>
              <Icon name="chevron_left" size={16} />
            </button>
            <button className="btn btn-sm btn-secondary" onClick={() => setMonthOffset(0)}>
              {t('common.today')}
            </button>
            <button className="btn btn-sm btn-secondary" onClick={() => setMonthOffset((o) => o + 1)}>
              <Icon name="chevron_right" size={16} />
            </button>
            <strong style={{ marginLeft: 8, fontSize: 16 }}>
              {t(`month.${month}`)} {year}
            </strong>
          </div>

          <div style={{ flex: 1 }} />

          <select className="crm-select" style={{ width: 200 }} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">{t('classes.allGroups')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>

          {elevated && (
            <select className="crm-select" style={{ width: 200 }} value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
              <option value="">{t('classes.allTeachers')}</option>
              {(usersQuery.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </select>
          )}

          <div style={{ display: 'inline-flex', gap: 4 }}>
            <button
              className={view === 'month' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'}
              onClick={() => setView('month')}
            >
              {t('classes.view.month')}
            </button>
            <button
              className={view === 'agenda' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'}
              onClick={() => setView('agenda')}
            >
              {t('classes.view.agenda')}
            </button>
          </div>

          {groups.length > 0 && (
            <button className="btn btn-sm btn-primary" onClick={() => setModal({ day: selectedDay })}>
              <Icon name="add" size={14} /> {t('classes.newSession')}
            </button>
          )}
        </div>
      </motion.div>

      {sessionsQuery.isLoading ? (
        <Loading />
      ) : view === 'month' ? (
        <div className="card" style={{ padding: 14, marginBottom: 16, overflowX: 'auto' }}>
          <div style={{ minWidth: 640 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 6 }}>
              {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => (
                <div
                  key={d}
                  style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-soft)', textAlign: 'center' }}
                >
                  {t(`weekday.short.${d}`)}
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
              {cells.map((day, i) => {
                if (!day) return <div key={`pad-${i}`} />;
                const list = byDay.get(day) ?? [];
                const isToday = day === today;
                const isSelected = day === selectedDay;
                return (
                  <button
                    key={day}
                    onClick={() => setSelectedDay(day)}
                    style={{
                      textAlign: 'left',
                      minHeight: 92,
                      padding: 6,
                      borderRadius: 10,
                      cursor: 'pointer',
                      background: isSelected ? 'var(--primary-soft)' : 'var(--bg-soft)',
                      border: `1.5px solid ${isToday ? 'var(--primary-dark)' : 'var(--border-soft)'}`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: isToday ? 700 : 500, color: 'var(--text-soft)' }}>
                      {Number(day.slice(8))}
                    </span>
                    {list.slice(0, 3).map((s) => (
                      <span
                        key={s.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setModal({ session: s });
                        }}
                        style={{
                          fontSize: 11,
                          lineHeight: 1.25,
                          padding: '2px 5px',
                          borderRadius: 6,
                          background: `${SESSION_COLOR[s.status]}22`,
                          borderLeft: `3px solid ${SESSION_COLOR[s.status]}`,
                          color: 'var(--text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          textDecoration: s.status === 'CANCELLED' ? 'line-through' : 'none',
                        }}
                      >
                        {tjFormatTime(s.startsAt)} {s.group?.name || ''}
                      </span>
                    ))}
                    {list.length > 3 && (
                      <span style={{ fontSize: 11, color: 'var(--text-soft)' }}>+{list.length - 3}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          {sessions.length === 0 ? (
            <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>{t('classes.empty')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sessions.map((s) => (
                <AgendaRow key={s.id} s={s} onOpen={() => setModal({ session: s })} onGroup={() => navigate(`/groups/${s.groupId}`)} />
              ))}
            </div>
          )}
        </div>
      )}

      {view === 'month' && (
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ marginBottom: 12 }}>
            {t('classes.dayOf')} {selectedDay} ({daySessions.length})
          </h3>
          {daySessions.length === 0 ? (
            <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>{t('classes.noSessionsDay')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {daySessions.map((s) => (
                <AgendaRow key={s.id} s={s} onOpen={() => setModal({ session: s })} onGroup={() => navigate(`/groups/${s.groupId}`)} />
              ))}
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {modal && (
          <ClassSessionModal
            session={modal.session}
            defaultDate={modal.day}
            groupOptions={groups.map((g) => ({ id: g.id, name: g.name }))}
            onClose={() => setModal(null)}
            onSaved={invalidate}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function AgendaRow({ s, onOpen, onGroup }: { s: ClassSession; onOpen: () => void; onGroup: () => void }) {
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
        borderLeft: `4px solid ${SESSION_COLOR[s.status]}`,
        background: 'var(--bg-soft)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {tjDateInput(s.startsAt)} · {tjFormatTime(s.startsAt)}—{tjFormatTime(s.endsAt)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
          <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={onGroup}>
            {s.group?.name || '—'}
          </span>
          {s.topic ? ` · ${s.topic}` : ''}
          {s.teacher ? ` · ${s.teacher.fullName}` : ''}
          {typeof s.group?._count?.members === 'number' ? ` · ${t('groups.membersCount')}: ${s.group._count.members}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span
          className="badge"
          style={{ color: SESSION_COLOR[s.status], borderColor: `${SESSION_COLOR[s.status]}55` }}
        >
          {t(`classes.status.${s.status}`)}
        </span>
        <button className="btn btn-sm btn-secondary" onClick={onOpen}>
          <Icon name="edit" size={14} />
        </button>
      </div>
    </div>
  );
}
