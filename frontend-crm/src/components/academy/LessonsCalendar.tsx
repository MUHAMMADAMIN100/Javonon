import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import Icon from '../../Icon';
import Loading from '../Loading';
import ClassSessionModal from '../ClassSessionModal';
import { useAuth } from '../../store/auth';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { absFileUrl, useFileToken } from '../../lib/fileUrl';
import { isAcademyManager } from '../../lib/permissions';
import { tjDateInput, tjFormatDate, tjFormatTime, tjMonthRange, tjToday } from '../../lib/tjTime';
import { listSessions, type ClassSession } from '../../api/studyGroups';
import { CHART_PALETTE } from './ScoreChart';
import { fileSize, materialIcon, weekdayKey } from './academyUi';

/**
 * Календарь занятий: месяц, в каждом дне — время и тема (или группа) урока.
 * Один компонент на вкладку «Календарь» группы и на страницу «Группы»
 * (все группы учителя, у каждой свой цвет). Клик по дню — справа занятия
 * дня целиком: тема, учитель, ДЗ со сроком, материалы и кнопки «Журнал
 * урока» и «Изменить».
 *
 * Своей календарной библиотеки нет (как и на «Расписании»): сетка — CSS-grid,
 * границы месяца — душанбинские сутки (tjMonthRange), занятия раскладываются
 * по дням Душанбе (tjDateInput).
 */

const STATUS_COLOR: Record<string, string> = {
  SCHEDULED: '#0ea5e9',
  DONE: '#10b981',
  CANCELLED: '#94a3b8',
};

function mondayIndex(day: string): number {
  return (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;
}

export default function LessonsCalendar({
  groupId,
  testId = 'lessons-calendar',
}: {
  /** Одна группа (вкладка группы); без него — все видимые группы. */
  groupId?: string;
  testId?: string;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  useFileToken();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string>(tjToday());
  const [editing, setEditing] = useState<ClassSession | null>(null);

  const range = useMemo(() => tjMonthRange(offset), [offset]);
  const [year, month] = range.from.split('-').map(Number);
  const params = useMemo(() => ({ from: range.from, to: range.to, groupId }), [range.from, range.to, groupId]);
  const query = useQuery({ queryKey: keys.groups.sessions(params), queryFn: () => listSessions(params) });
  const sessions = query.data ?? [];
  const today = tjToday();

  // Цвет группы — по порядку названий, чтобы у группы он не прыгал между месяцами.
  const groupColor = useMemo(() => {
    const names = Array.from(new Map(sessions.map((s) => [s.groupId, s.group?.name ?? ''])).entries()).sort((a, b) =>
      a[1].localeCompare(b[1], 'ru'),
    );
    return new Map(names.map(([id], i) => [id, CHART_PALETTE[i % CHART_PALETTE.length]]));
  }, [sessions]);
  const multi = !groupId;
  const colorOf = (s: ClassSession) => (s.status === 'CANCELLED' ? STATUS_COLOR.CANCELLED : multi ? groupColor.get(s.groupId) : STATUS_COLOR[s.status]);

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
    const lead = mondayIndex(range.from);
    const total = Number(range.to.slice(8));
    const out: Array<string | null> = Array(lead).fill(null);
    for (let d = 1; d <= total; d++) out.push(`${range.from.slice(0, 8)}${String(d).padStart(2, '0')}`);
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [range.from, range.to]);

  const goMonth = (delta: number) => {
    const next = tjMonthRange(offset + delta);
    setOffset((o) => o + delta);
    // Выбранный день переезжает в новый месяц: сегодня, если он там, иначе 1-е.
    setSelected(today >= next.from && today <= next.to ? today : next.from);
  };

  const daySessions = byDay.get(selected) ?? [];
  const live = sessions.filter((s) => s.status !== 'CANCELLED').length;
  const canEdit = (s: ClassSession) => isAcademyManager(me as any) || s.group?.teacherId === me?.id || s.teacherId === me?.id;
  const legend = multi ? Array.from(new Map(sessions.map((s) => [s.groupId, s.group?.name ?? '—'])).entries()) : [];

  return (
    <div className="acad-cal" data-testid={testId}>
      <div className="acad-cal-head">
        <div className="acad-cal-nav">
          <button type="button" className="btn btn-sm btn-secondary" aria-label={t('common.back')} onClick={() => goMonth(-1)} data-testid="cal-prev">
            <Icon name="chevron_left" size={18} />
          </button>
          <strong className="acad-cal-title" data-testid="cal-title">
            {t(`month.${month}`)} {year}
          </strong>
          <button type="button" className="btn btn-sm btn-secondary" aria-label={t('common.next')} onClick={() => goMonth(1)} data-testid="cal-next">
            <Icon name="chevron_right" size={18} />
          </button>
        </div>
        <div className="acad-cal-head-right">
          <span className="acad-hint">{t('academy.calendar.lessons').replace('{n}', String(live))}</span>
          {offset !== 0 && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                setOffset(0);
                setSelected(today);
              }}
              data-testid="cal-today"
            >
              {t('common.today')}
            </button>
          )}
        </div>
      </div>

      {legend.length > 1 && (
        <div className="acad-cal-legend">
          {legend.map(([id, name]) => (
            <span key={id}>
              <i style={{ background: groupColor.get(id) }} />
              {name}
            </span>
          ))}
        </div>
      )}

      {query.isLoading ? (
        <Loading />
      ) : (
        <div className="acad-cal-body">
          <div className="acad-cal-grid-wrap">
            <div className="acad-cal-weekdays">
              {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => (
                <span key={d}>{t(`weekday.short.${d}`)}</span>
              ))}
            </div>
            <div className="acad-cal-grid">
              {cells.map((day, i) => {
                if (!day) return <span key={`pad-${i}`} className="acad-cal-pad" />;
                const list = byDay.get(day) ?? [];
                return (
                  <button
                    key={day}
                    type="button"
                    className={`acad-cal-day${day === today ? ' is-today' : ''}${day === selected ? ' is-selected' : ''}${
                      list.length ? ' has-lessons' : ''
                    }`}
                    onClick={() => setSelected(day)}
                    data-testid={`cal-day-${day}`}
                  >
                    <span className="acad-cal-num">{Number(day.slice(8))}</span>
                    <span className="acad-cal-items">
                      {list.slice(0, 3).map((s) => (
                        <span
                          key={s.id}
                          className={`acad-cal-item${s.status === 'CANCELLED' ? ' is-cancelled' : ''}`}
                          style={{ ['--c' as string]: colorOf(s) }}
                        >
                          <b>{tjFormatTime(s.startsAt)}</b> {multi ? s.group?.name : s.topic || t('classes.noTopic')}
                        </span>
                      ))}
                      {list.length > 3 && <span className="acad-cal-more">+{list.length - 3}</span>}
                    </span>
                    <span className="acad-cal-dots" aria-hidden="true">
                      {list.slice(0, 4).map((s) => (
                        <i key={s.id} style={{ background: colorOf(s) }} />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="acad-cal-day-panel" data-testid="cal-day-panel">
            <div className="acad-cal-day-title">
              {t(`weekday.short.${weekdayKey(mondayIndex(selected) + 1)}`)}, {tjFormatDate(`${selected}T12:00:00.000Z`)}
            </div>
            {daySessions.length === 0 ? (
              <div className="acad-hint">{t('academy.calendar.noLessons')}</div>
            ) : (
              daySessions.map((s) => (
                <div
                  key={s.id}
                  className={`acad-cal-lesson${s.status === 'CANCELLED' ? ' is-cancelled' : ''}`}
                  style={{ ['--c' as string]: colorOf(s) }}
                  data-testid={`cal-lesson-${s.id}`}
                >
                  <div className="acad-cal-lesson-top">
                    <b>
                      {tjFormatTime(s.startsAt)}–{tjFormatTime(s.endsAt)}
                    </b>
                    <span className={`badge ${s.status === 'DONE' ? 'badge-success' : s.status === 'CANCELLED' ? 'badge-gray' : 'badge-info'}`}>
                      {t(`classes.status.${s.status}`)}
                    </span>
                  </div>
                  {multi && <div className="acad-cal-lesson-group">{s.group?.name}</div>}
                  <div className="acad-cal-lesson-topic">{s.topic || t('classes.noTopic')}</div>
                  {s.teacher && (
                    <div className="acad-hint">
                      <Icon name="swap_horiz" size={14} /> {s.teacher.fullName} ({t('classes.substitute')})
                    </div>
                  )}
                  {s.homework && (
                    <div className="acad-lesson-hw">
                      <Icon name="menu_book" size={15} />
                      <span>{s.homework}</span>
                    </div>
                  )}
                  {s.homeworkDue && (
                    <div className="acad-lesson-due">
                      {t('academy.lessons.due')}: {tjFormatDate(s.homeworkDue)}
                    </div>
                  )}
                  {(s.materials ?? []).length > 0 && (
                    <div className="acad-chips">
                      {(s.materials ?? []).map((m) => (
                        <a
                          key={m.id}
                          className="acad-chip"
                          href={m.kind === 'LINK' ? m.url : absFileUrl(m.url)}
                          target="_blank"
                          rel="noreferrer"
                          title={m.title}
                        >
                          <Icon name={materialIcon(m.kind, m.mimeType, m.title)} size={14} />
                          <span>{m.title}</span>
                          {m.kind === 'FILE' && m.size ? <small>{fileSize(m.size)}</small> : null}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="acad-cal-lesson-actions">
                    {s.status !== 'CANCELLED' && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => navigate(`/groups/${s.groupId}?lesson=${s.id}`)}
                        data-testid={`cal-journal-${s.id}`}
                      >
                        <Icon name="grading" size={15} /> {t('academy.calendar.openJournal')}
                      </button>
                    )}
                    {canEdit(s) && (
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(s)} data-testid={`cal-edit-${s.id}`}>
                        <Icon name="edit" size={15} /> {t('common.edit')}
                      </button>
                    )}
                    {multi && (
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => navigate(`/groups/${s.groupId}`)}>
                        <Icon name="open_in_new" size={15} /> {t('academy.calendar.openGroup')}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <AnimatePresence>
        {editing && (
          <ClassSessionModal
            session={editing}
            groupId={editing.groupId}
            groupTeacherId={editing.group?.teacherId ?? null}
            onClose={() => setEditing(null)}
            onSaved={() => qc.invalidateQueries({ queryKey: keys.groups.all })}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
