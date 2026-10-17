import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import Loading from '../Loading';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { tjFormatDate, tjFormatDateTime, tjFormatTime } from '../../lib/tjTime';
import { getSessionDiary, type DiaryLog } from '../../api/academy';
import { shortKey, weekdayKey } from './academyUi';

/**
 * Дневник ДЗ урока глазами учителя: ученики × дни с дня урока по срок.
 * Зелёная клетка — запись есть (нажмите — текст ниже), красная — день
 * прошёл без записи, жёлтая — сегодня ещё не написал, серая — день не
 * наступил или ученика тогда ещё не было в группе. Ученик пишет только за
 * сегодня, поэтому картина честная.
 */
function weekdayOfKey(day: string): number {
  return ((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1;
}

export default function HomeworkDiaryModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useT();
  const q = useQuery({ queryKey: keys.academy.diary(sessionId), queryFn: () => getSessionDiary(sessionId) });
  const [open, setOpen] = useState<{ studentId: string; day: string } | null>(null);
  const d = q.data;

  const cellState = (log: DiaryLog | undefined, day: string, today: string, joinedDay?: string) => {
    if (log) return 'is-done';
    if (joinedDay && day < joinedDay) return 'is-before';
    if (day < today) return 'is-missed';
    if (day === today) return 'is-today';
    return 'is-future';
  };

  const activeStudents = d?.students.filter((s) => s.active) ?? [];
  const inWindow = !!d && d.days.includes(d.today);
  const todayCount = d ? activeStudents.filter((s) => d.logs[s.id]?.[d.today]).length : 0;
  const openLog = d && open ? d.logs[open.studentId]?.[open.day] : undefined;
  const openName = d && open ? d.students.find((s) => s.id === open.studentId)?.fullName : '';

  return (
    <FormModal open title={t('academy.diary.title')} onClose={onClose} dirty={false} width={900} testId="diary-modal">
      {q.isLoading || !d ? (
        <Loading />
      ) : (
        <div className="acad-diary">
          <div className="acad-diary-lesson">
            <div>
              <b>{d.session.topic || t('classes.noTopic')}</b>
              <span className="acad-hint">
                {' '}
                · {tjFormatDate(d.session.startsAt)}, {tjFormatTime(d.session.startsAt)} · {d.session.group.name}
              </span>
            </div>
            {d.session.homework && (
              <div className="acad-lesson-hw">
                <Icon name="menu_book" size={15} />
                <span>{d.session.homework}</span>
              </div>
            )}
            <div className="acad-diary-meta">
              {d.session.homeworkDue && (
                <span className="acad-lesson-due">
                  {t('academy.diary.due').replace('{date}', tjFormatDate(d.session.homeworkDue))}
                  {d.days[d.days.length - 1] < d.today ? ` · ${t('academy.diary.closed')}` : ''}
                </span>
              )}
              {inWindow && activeStudents.length > 0 && (
                <span className="acad-diary-today" data-testid="diary-today-stats">
                  {t('academy.diary.todayStats').replace('{n}', String(todayCount)).replace('{m}', String(activeStudents.length))}
                </span>
              )}
            </div>
          </div>

          {d.students.length === 0 ? (
            <div className="acad-hint">{t('groups.noMembers')}</div>
          ) : (
            <div className="acad-diary-wrap">
              <table className="acad-diary-grid" data-testid="diary-grid">
                <thead>
                  <tr>
                    <th className="acad-diary-name">{t('academy.journal.studentCol')}</th>
                    {d.days.map((day) => (
                      <th key={day} className={day === d.today ? 'is-today' : ''}>
                        <b>{shortKey(day)}</b>
                        <span>{t(`weekday.short.${weekdayKey(weekdayOfKey(day))}`)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.students.map((s) => (
                    <tr key={s.id} className={s.active ? '' : 'is-left'}>
                      <td className="acad-diary-name">{s.fullName}</td>
                      {d.days.map((day) => {
                        const log = d.logs[s.id]?.[day];
                        const state = cellState(log, day, d.today, s.joinedDay);
                        const isOpen = open?.studentId === s.id && open.day === day;
                        return (
                          <td key={day}>
                            <button
                              type="button"
                              className={`acad-diary-cell ${state}${isOpen ? ' is-open' : ''}`}
                              disabled={!log}
                              title={
                                log
                                  ? log.text
                                  : state === 'is-missed'
                                    ? t('academy.diary.missed')
                                    : state === 'is-today'
                                      ? t('academy.diary.todayEmpty')
                                      : state === 'is-before'
                                        ? t('academy.diary.notInGroup')
                                        : t('academy.diary.future')
                              }
                              onClick={() => setOpen(isOpen ? null : { studentId: s.id, day })}
                              data-testid={`diary-cell-${s.id}-${day}`}
                              data-state={state}
                            >
                              <Icon
                                name={log ? 'check' : state === 'is-missed' ? 'close' : state === 'is-today' ? 'schedule' : 'remove'}
                                size={16}
                              />
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {openLog && open && (
            <div className="acad-diary-entry" data-testid="diary-entry">
              <div className="acad-diary-entry-head">
                <b>{openName}</b> · {shortKey(open.day)}
                <span className="acad-hint">
                  {' '}
                  · {t('academy.diary.writtenAt').replace('{time}', tjFormatDateTime(openLog.createdAt))}
                  {Date.parse(openLog.updatedAt) - Date.parse(openLog.createdAt) > 60_000 &&
                    `, ${t('academy.diary.editedAt').replace('{time}', tjFormatTime(openLog.updatedAt))}`}
                </span>
              </div>
              <div className="acad-diary-entry-text">{openLog.text}</div>
            </div>
          )}

          <div className="acad-hint acad-diary-hint">{t('academy.diary.hint')}</div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </FormModal>
  );
}
