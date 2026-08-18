import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { listStudentUpcomingSessions, type StudentClassSession } from '../studentApi';
import { lkeys } from '../queryClient';
import { tjDayKey, tjDayLabel, tjTime } from '../tjDate';
import Icon from '../Icon';

/**
 * РАСПИСАНИЕ СТУДЕНТА — ближайшие занятия.
 *
 * Секция самоустраняется, если занятий нет: у большинства студентов кабинета
 * группы нет вовсе, и пустая карточка «Ҳоло дарс нест» была бы шумом на
 * главной, а не информацией. Пока данные грузятся — тоже ничего не рисуем,
 * иначе на каждом заходе мигал бы скелет секции, которой у студента нет.
 */
export default function ScheduleSection() {
  const query = useQuery<StudentClassSession[]>({
    queryKey: lkeys.schedule.upcoming(),
    queryFn: () => listStudentUpcomingSessions(),
  });

  const sessions = query.data ?? [];

  // Группировка по душанбинским суткам. Бэкенд уже отдал их по возрастанию
  // startsAt, поэтому порядок дней и занятий внутри дня сохраняется сам.
  const days = useMemo(() => {
    const now = new Date();
    const out: { key: string; label: string; items: StudentClassSession[] }[] = [];
    for (const s of sessions) {
      const key = tjDayKey(s.startsAt);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(s);
      else out.push({ key, label: tjDayLabel(s.startsAt, now), items: [s] });
    }
    return out;
  }, [sessions]);

  if (sessions.length === 0) return null;

  return (
    <motion.section
      className="stu-card"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="stu-sched-head">
        <h2>Дарсҳои наздик</h2>
        <span className="stu-sched-count">
          <Icon name="event" size={15} />
          {sessions.length} дарс
        </span>
      </div>

      <div className="stu-sched-days">
        {days.map((day) => (
          <div key={day.key} className="stu-sched-day">
            <div className="stu-sched-day-label">{day.label}</div>
            <div className="stu-sched-items">
              {day.items.map((s) => (
                <div key={s.id} className="stu-sched-item">
                  <div className="stu-sched-time">
                    <span className="stu-sched-time-start">{tjTime(s.startsAt)}</span>
                    <span className="stu-sched-time-end">{tjTime(s.endsAt)}</span>
                  </div>
                  <div className="stu-sched-body">
                    <div className="stu-sched-topic">
                      {s.topic || s.group.program?.name || 'Дарс'}
                    </div>
                    <div className="stu-sched-meta">
                      <span>
                        <Icon name="group" size={14} />
                        {s.group.name}
                      </span>
                      {/* Имя преподавателя приходит только когда на занятие
                          назначена замена; штатного преподавателя группы этот
                          ответ не содержит — пустую строку «Устод: —» не
                          показываем. */}
                      {s.teacher && (
                        <span>
                          <Icon name="person" size={14} />
                          {s.teacher.fullName}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </motion.section>
  );
}
