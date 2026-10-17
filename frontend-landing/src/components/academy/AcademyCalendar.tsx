import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../Icon';
import { getAcademyCalendar, type AcademyCalendarLesson } from '../../studentApi';
import { lkeys } from '../../queryClient';
import { tjDayKey, tjTime } from '../../tjDate';
import { addDaysKey, calendarDate, keyDayMonth, monthTitle, weekdayOfKey, weekdayShort } from './academyBits';
import MaterialsList from './MaterialsList';

/**
 * «Тақвим»: занятия ученика по дням месяца. Клик по дню — ниже занятия
 * этого дня: время, тема, группа, муаллим, вазифаи хонагӣ со сроком и
 * материалы (у начавшихся уроков — как в расписании). Месяц — в
 * душанбинских сутках: сервер раскладывает уроки так же.
 */
const STATUS_COLOR: Record<string, string> = {
  SCHEDULED: '#0284c7',
  DONE: '#059669',
  CANCELLED: '#94a3b8',
};

function monthRange(offset: number, today: string) {
  const [y, m] = today.split('-').map(Number);
  const index = y * 12 + (m - 1) + offset;
  const ry = Math.floor(index / 12);
  const rm = (index % 12) + 1;
  const days = new Date(Date.UTC(ry, rm, 0)).getUTCDate();
  const from = `${ry}-${String(rm).padStart(2, '0')}-01`;
  return { year: ry, month: rm, from, to: addDaysKey(from, days - 1), days };
}

export default function AcademyCalendar() {
  const today = tjDayKey(new Date());
  const [offset, setOffset] = useState(0);
  const range = useMemo(() => monthRange(offset, today), [offset, today]);
  const [selected, setSelected] = useState(today);
  const q = useQuery({
    queryKey: lkeys.academy.calendar(range.from, range.to),
    queryFn: () => getAcademyCalendar(range.from, range.to),
  });
  const lessons = q.data ?? [];

  const byDay = useMemo(() => {
    const map = new Map<string, AcademyCalendarLesson[]>();
    for (const l of lessons) {
      const key = tjDayKey(l.startsAt);
      const list = map.get(key);
      if (list) list.push(l);
      else map.set(key, [l]);
    }
    return map;
  }, [lessons]);

  const cells = useMemo(() => {
    const lead = weekdayOfKey(range.from) - 1;
    const out: Array<string | null> = Array(lead).fill(null);
    for (let i = 0; i < range.days; i++) out.push(addDaysKey(range.from, i));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [range.from, range.days]);

  const go = (delta: number) => {
    const next = monthRange(offset + delta, today);
    setOffset((o) => o + delta);
    setSelected(today >= next.from && today <= next.to ? today : next.from);
  };

  const dayLessons = byDay.get(selected) ?? [];
  const multiGroup = new Set(lessons.map((l) => l.group.id)).size > 1;

  return (
    <section className="stu-card acad-cab-cal" data-testid="academy-calendar">
      <div className="acad-cab-cal-head">
        <button type="button" className="acad-cab-cal-nav" aria-label="Моҳи гузашта" onClick={() => go(-1)} data-testid="cab-cal-prev">
          <Icon name="chevron_left" size={20} />
        </button>
        <h2 data-testid="cab-cal-title">{monthTitle(range.year, range.month)}</h2>
        <button type="button" className="acad-cab-cal-nav" aria-label="Моҳи оянда" onClick={() => go(1)} data-testid="cab-cal-next">
          <Icon name="chevron_right" size={20} />
        </button>
      </div>

      <div className="acad-cab-cal-weekdays">
        {[1, 2, 3, 4, 5, 6, 7].map((d) => (
          <span key={d}>{weekdayShort(d)}</span>
        ))}
      </div>
      <div className="acad-cab-cal-grid">
        {cells.map((day, i) => {
          if (!day) return <span key={`pad-${i}`} />;
          const list = byDay.get(day) ?? [];
          return (
            <button
              key={day}
              type="button"
              className={`acad-cab-cal-day${day === today ? ' is-today' : ''}${day === selected ? ' is-selected' : ''}${list.length ? ' has-lessons' : ''}`}
              onClick={() => setSelected(day)}
              data-testid={`cab-cal-day-${day}`}
            >
              <span className="acad-cab-cal-num">{Number(day.slice(8))}</span>
              <span className="acad-cab-cal-items">
                {list.slice(0, 2).map((l) => (
                  <span
                    key={l.id}
                    className={`acad-cab-cal-item${l.status === 'CANCELLED' ? ' is-cancelled' : ''}`}
                    style={{ ['--c' as string]: STATUS_COLOR[l.status] }}
                  >
                    {tjTime(l.startsAt)} {l.topic || 'Дарс'}
                  </span>
                ))}
                {list.length > 2 && <span className="acad-cab-cal-more">+{list.length - 2}</span>}
              </span>
              <span className="acad-cab-cal-dots" aria-hidden="true">
                {list.slice(0, 3).map((l) => (
                  <i key={l.id} style={{ background: STATUS_COLOR[l.status] }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div className="acad-cab-cal-day-panel" data-testid="cab-cal-panel">
        <div className="acad-cab-cal-day-title">
          {weekdayShort(weekdayOfKey(selected))}, {keyDayMonth(selected)}
        </div>
        {q.isLoading ? (
          <div className="acad-cab-cal-none">Боргузорӣ…</div>
        ) : dayLessons.length === 0 ? (
          <div className="acad-cab-cal-none">Дар ин рӯз дарс нест</div>
        ) : (
          dayLessons.map((l) => (
            <div
              key={l.id}
              className={`acad-cab-cal-lesson${l.status === 'CANCELLED' ? ' is-cancelled' : ''}`}
              style={{ ['--c' as string]: STATUS_COLOR[l.status] }}
              data-testid={`cab-cal-lesson-${l.id}`}
            >
              <div className="acad-cab-cal-lesson-top">
                <b>
                  {tjTime(l.startsAt)}–{tjTime(l.endsAt)}
                </b>
                {l.status === 'CANCELLED' ? (
                  <span className="acad-cab-cancel">Бекор шуд</span>
                ) : l.status === 'DONE' ? (
                  <span className="acad-cab-tag is-yes">Гузашт</span>
                ) : null}
              </div>
              <div className="acad-cab-cal-lesson-topic">{l.topic || 'Дарс'}</div>
              <div className="acad-cab-cal-lesson-meta">
                {multiGroup && (
                  <span>
                    <Icon name="group" size={14} /> {l.group.name}
                  </span>
                )}
                {l.teacher && (
                  <span>
                    <Icon name="person" size={14} /> {l.teacher.fullName}
                  </span>
                )}
              </div>
              {l.homework && (
                <div className="acad-cab-cal-hw">
                  <Icon name="menu_book" size={16} />
                  <div>
                    <span>{l.homework}</span>
                    {l.homeworkDue && <small>Мӯҳлат: то {calendarDate(l.homeworkDue)}</small>}
                  </div>
                </div>
              )}
              {!l.started && l.status !== 'CANCELLED' && (
                <div className="acad-cab-cal-soon">Вазифа ва маводҳо бо оғози дарс кушода мешаванд</div>
              )}
              <MaterialsList materials={l.materials} testPrefix="cal-file" />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
