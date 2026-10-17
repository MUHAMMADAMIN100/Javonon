import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../../Icon';
import {
  getAcademyHomework,
  getAcademyLessons,
  writeAcademyDiary,
  type AcademyHomework,
  type AcademyLesson,
  type AcademyOverview,
} from '../../studentApi';
import { lkeys } from '../../queryClient';
import { tjDateFull, tjDayKey, tjDayLabel, tjTime } from '../../tjDate';
import { LevelPill, TotalPill, calendarDate, keyDayMonth, patternText, pct, weekdayOfKey, weekdayShort } from './academyBits';
import AcademyGrades from './AcademyGrades';
import AcademyCalendar from './AcademyCalendar';
import MaterialsList from './MaterialsList';

type Sub = 'calendar' | 'schedule' | 'homework' | 'grades';
const FLAGS_FOR_DECISION = 4;

const LEVEL_REASON: Record<string, string> = {
  START: 'ҳангоми сабт',
  MANUAL: 'иваз шуд',
  COURSE: 'курс анҷом ёфт',
};

/**
 * Вкладка «Академия» в кабинете студента: группа и муаллим, сатҳ (уровень)
 * с историей, сводка (натиҷаи миёна, давомот, парчамҳо), напоминание о
 * рӯзномаи вазифа и четыре раздела — тақвим, ҷадвал, вазифаи хонагӣ (с
 * дневником), баҳоҳо. Отчисленный видит плашку с причиной и свои прежние
 * оценки; занятия и ДЗ ему больше не показываются.
 */
export default function AcademySection({ overview }: { overview: Extract<AcademyOverview, { hasAcademy: true }> }) {
  // Поля новой версии сервера — с запасом на минуты, пока сайт уже обновился, а API ещё нет.
  const o = {
    ...overview,
    diaryDue: overview.diaryDue ?? [],
    levelHistory: overview.levelHistory ?? [],
    completedCourses: overview.completedCourses ?? [],
  };
  const [sub, setSub] = useState<Sub>(o.diaryDue.length ? 'homework' : 'schedule');
  const expelled = o.status === 'EXPELLED';
  const lastCourse = o.completedCourses[o.completedCourses.length - 1];

  return (
    <div className="acad-cab" data-testid="academy-tab">
      {expelled && o.expelled && (
        <motion.div className="acad-cab-banner is-expelled" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} data-testid="academy-expelled">
          <Icon name="block" size={26} />
          <div>
            <b>Шумо аз академия хориҷ карда шудед</b>
            <span>Сана: {tjDateFull(o.expelled.at)}</span>
            {o.expelled.note && <span>Сабаб: {o.expelled.note}</span>}
            <span>Барои маълумот ба маъмурияти Javonon муроҷиат кунед.</span>
          </div>
        </motion.div>
      )}

      {!expelled && o.groups.length === 0 && (
        <div className="acad-cab-banner" data-testid="academy-nogroup">
          <Icon name={lastCourse ? 'school' : 'group_add'} size={24} />
          <div>
            {lastCourse ? (
              <>
                <b>Курси «{lastCourse.name}» анҷом ёфт</b>
                <span>Табрик! Маъмурият шуморо ба гурӯҳи нав илова мекунад — ҷадвал ва вазифаҳо дар ин ҷо пайдо мешаванд.</span>
              </>
            ) : (
              <>
                <b>Шумо ҳоло дар ягон гурӯҳ нестед</b>
                <span>Маъмурият шуморо ба гурӯҳ илова мекунад — ҷадвал ва вазифаҳо дар ин ҷо пайдо мешаванд.</span>
              </>
            )}
          </div>
        </div>
      )}

      {o.diaryDue.length > 0 && (
        <motion.div className="acad-cab-banner is-diary" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} data-testid="academy-diary-due">
          <Icon name="edit_note" size={26} />
          <div>
            <b>Имрӯз дар рӯзномаи вазифа нависед</b>
            <span>
              Чӣ кор кардед ва вазифа чӣ гуна пеш меравад:{' '}
              {o.diaryDue.map((d) => d.topic || 'Дарс').join(', ')}
            </span>
          </div>
          {sub !== 'homework' && (
            <button type="button" className="acad-cab-banner-btn" onClick={() => setSub('homework')} data-testid="academy-diary-go">
              Навиштан
            </button>
          )}
        </motion.div>
      )}

      {o.groups.map((g) => (
        <motion.section key={g.id} className="stu-card acad-cab-group" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} data-testid={`academy-group-${g.id}`}>
          <div className="acad-cab-eyebrow">Гурӯҳи ман</div>
          <h2>{g.name}</h2>
          <div className="acad-cab-facts">
            <span>
              <Icon name="person" size={16} /> Муаллим: <b>{g.teacher?.fullName || '—'}</b>
            </span>
            {g.pattern.length > 0 && (
              <span>
                <Icon name="schedule" size={16} /> {patternText(g.pattern)}
              </span>
            )}
            {g.nextLesson && (
              <span className="is-next">
                <Icon name="event" size={16} /> Дарси оянда: {tjDayLabel(g.nextLesson.startsAt, new Date())}, {tjTime(g.nextLesson.startsAt)}
              </span>
            )}
          </div>
        </motion.section>
      ))}

      <div className="acad-cab-tiles">
        <div className="acad-cab-tile" data-testid="academy-level-tile">
          <span>Сатҳ</span>
          <LevelPill name={o.level?.name} />
        </div>
        <div className="acad-cab-tile">
          <span>Натиҷаи миёна</span>
          <TotalPill total={o.summary.avg} />
        </div>
        <div className="acad-cab-tile">
          <span>Давомот</span>
          <b>{pct(o.summary.attendancePct)}</b>
        </div>
        <div className={`acad-cab-tile${o.flags.length ? ' is-flags' : ''}`} data-testid="academy-flags-tile">
          <span>Парчамҳои сурх</span>
          <b>
            {o.flags.length} / {FLAGS_FOR_DECISION}
          </b>
        </div>
      </div>

      {o.levelHistory.length > 0 && (
        <section className="stu-card acad-cab-levels" data-testid="academy-level-history">
          <h2>Таърихи сатҳҳо</h2>
          <div className="acad-cab-level-list">
            {o.levelHistory.map((h) => (
              <div key={h.id} className="acad-cab-level-row">
                <span className="acad-cab-level-names">
                  {h.fromName && <span className="acad-cab-level is-empty">{h.fromName}</span>}
                  {h.fromName && <Icon name="arrow_forward" size={16} />}
                  <LevelPill name={h.toName} />
                </span>
                <span className="acad-cab-level-meta">
                  {tjDateFull(h.createdAt)} · {LEVEL_REASON[h.reason] ?? ''}
                  {h.group ? ` · ${h.group.name}` : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {o.flags.length > 0 && (
        <section className="stu-card acad-cab-flags" data-testid="academy-flags">
          <h2>Парчамҳои сурх</h2>
          {!expelled && (
            <div className="acad-cab-warn">
              <Icon name="warning" size={18} />
              <span>
                {o.flags.length >= FLAGS_FOR_DECISION
                  ? `Шумо ${FLAGS_FOR_DECISION} парчами сурх гирифтед — роҳбарият дар бораи идомаи таҳсили шумо қарор қабул мекунад.`
                  : `Агар ${FLAGS_FOR_DECISION} парчами сурх гиред, роҳбарият метавонад шуморо аз академия хориҷ кунад.`}
              </span>
            </div>
          )}
          <div className="acad-cab-flag-list">
            {o.flags.map((f) => (
              <div key={f.id} className="acad-cab-flag">
                <Icon name="flag" size={18} />
                <div>
                  <b>{f.reason}</b>
                  <span>
                    {tjDateFull(f.createdAt)}
                    {f.group ? ` · ${f.group.name}` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="acad-cab-subtabs" role="tablist">
        {([
          ['calendar', 'calendar_month', 'Тақвим'],
          ['schedule', 'event_note', 'Ҷадвал'],
          ['homework', 'menu_book', 'Вазифаи хонагӣ'],
          ['grades', 'grading', 'Баҳоҳо'],
        ] as Array<[Sub, string, string]>).map(([key, icon, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={sub === key}
            className={`acad-cab-subtab${sub === key ? ' active' : ''}`}
            onClick={() => setSub(key)}
            data-testid={`academy-sub-${key}`}
          >
            <Icon name={icon} size={18} /> {label}
            {key === 'homework' && o.diaryDue.length > 0 && <i className="acad-cab-subtab-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>

      {sub === 'calendar' && <AcademyCalendar />}
      {sub === 'schedule' && <AcademySchedule />}
      {sub === 'homework' && <AcademyHomeworkList />}
      {sub === 'grades' && <AcademyGrades />}
    </div>
  );
}

function AcademySchedule() {
  const q = useQuery({ queryKey: lkeys.academy.lessons(), queryFn: getAcademyLessons });
  const upcoming = q.data?.upcoming ?? [];
  const days = useMemo(() => {
    const now = new Date();
    const out: { key: string; label: string; items: AcademyLesson[] }[] = [];
    for (const s of upcoming) {
      const key = tjDayKey(s.startsAt);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(s);
      else out.push({ key, label: tjDayLabel(s.startsAt, now), items: [s] });
    }
    return out;
  }, [upcoming]);

  if (q.isLoading) return <div className="stu-card acad-cab-empty">Боргузорӣ…</div>;
  if (!upcoming.length) {
    return (
      <div className="stu-card acad-cab-empty" data-testid="academy-schedule-empty">
        <Icon name="event_busy" size={36} />
        <span>Дарсҳои наздик нестанд</span>
      </div>
    );
  }
  return (
    <section className="stu-card" data-testid="academy-schedule">
      <div className="stu-sched-head">
        <h2>Ҷадвали дарсҳо</h2>
        <span className="stu-sched-count">
          <Icon name="event" size={15} /> {upcoming.length} дарс
        </span>
      </div>
      <div className="stu-sched-days">
        {days.map((day) => (
          <div key={day.key} className="stu-sched-day">
            <div className="stu-sched-day-label">{day.label}</div>
            <div className="stu-sched-items">
              {day.items.map((s) => (
                <div key={s.id} className={`stu-sched-item${s.status === 'CANCELLED' ? ' is-cancelled' : ''}`}>
                  <div className="stu-sched-time">
                    <span className="stu-sched-time-start">{tjTime(s.startsAt)}</span>
                    <span className="stu-sched-time-end">{tjTime(s.endsAt)}</span>
                  </div>
                  <div className="stu-sched-body">
                    <div className="stu-sched-topic">
                      {s.topic || 'Дарс'}
                      {s.status === 'CANCELLED' && <span className="acad-cab-cancel">Бекор шуд</span>}
                    </div>
                    <div className="stu-sched-meta">
                      <span><Icon name="group" size={14} /> {s.group.name}</span>
                      {(s.teacher || s.group.teacher) && (
                        <span><Icon name="person" size={14} /> {(s.teacher || s.group.teacher)!.fullName}</span>
                      )}
                      {(s.homework || s._count.materials > 0) && (
                        <span className="acad-cab-hw-mark"><Icon name="menu_book" size={14} /> Вазифаи хонагӣ ҳаст</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AcademyHomeworkList() {
  const q = useQuery({ queryKey: lkeys.academy.homework(), queryFn: getAcademyHomework });
  const items = q.data ?? [];

  if (q.isLoading) return <div className="stu-card acad-cab-empty">Боргузорӣ…</div>;
  if (!items.length) {
    return (
      <div className="stu-card acad-cab-empty" data-testid="academy-homework-empty">
        <Icon name="task" size={36} />
        <span>Ҳоло вазифаи хонагӣ нест</span>
      </div>
    );
  }
  return (
    <section className="acad-cab-hw-list" data-testid="academy-homework">
      {items.map((h: AcademyHomework) => (
        <article key={h.id} className="stu-card acad-cab-hw" data-testid={`hw-${h.id}`}>
          <div className="acad-cab-hw-head">
            <div>
              <div className="acad-cab-eyebrow">{tjDayLabel(h.startsAt, new Date())} · {h.group.name}</div>
              <h3>{h.topic || 'Дарс'}</h3>
            </div>
            {h.homeworkDue && <span className="acad-cab-due">Мӯҳлат: то {calendarDate(h.homeworkDue)}</span>}
          </div>
          {h.homework && <p className="acad-cab-hw-text">{h.homework}</p>}
          <MaterialsList materials={h.materials} />
          {h.diary && <HomeworkDiary hw={h} />}
        </article>
      ))}
    </section>
  );
}

/**
 * Рӯзномаи вазифа: с дня урока по срок — по записи на день, что сделал и
 * как идёт. Писать можно только за сегодня (до 23:59 по Душанбе) и
 * поправить сегодняшнюю запись; прошедшие дни не дописываются.
 */
function HomeworkDiary({ hw }: { hw: AcademyHomework }) {
  const d = hw.diary!;
  const qc = useQueryClient();
  const todayLog = d.logs[d.today];
  const [text, setText] = useState(todayLog?.text ?? '');
  const [editing, setEditing] = useState(!todayLog);
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => writeAcademyDiary(hw.id, text.trim()),
    onSuccess: (saved) => {
      setError(null);
      setEditing(false);
      qc.setQueryData<AcademyHomework[]>(lkeys.academy.homework(), (cur) =>
        (cur ?? []).map((x) =>
          x.id === hw.id && x.diary
            ? { ...x, diary: { ...x.diary, logs: { ...x.diary.logs, [saved.day]: { text: saved.text, createdAt: saved.createdAt, updatedAt: saved.updatedAt } } } }
            : x,
        ),
      );
      qc.invalidateQueries({ queryKey: lkeys.academy.overview() });
    },
    onError: (e: any) => setError(e?.response?.data?.message || 'Сабт нашуд. Бори дигар кӯшиш кунед.'),
  });

  const written = d.days.filter((day) => d.logs[day]);
  return (
    <div className="acad-cab-diary" data-testid={`diary-${hw.id}`}>
      <div className="acad-cab-diary-head">
        <b>
          <Icon name="edit_note" size={18} /> Рӯзномаи вазифа
        </b>
        <span>
          навишта шуд: {written.length} аз {d.days.length}
        </span>
      </div>
      <div className="acad-cab-diary-days">
        {d.days.map((day) => {
          const state = d.logs[day] ? 'is-done' : day < d.today ? 'is-missed' : day === d.today ? 'is-today' : 'is-future';
          return (
            <span key={day} className={`acad-cab-diary-day ${state}`} title={d.logs[day]?.text} data-testid={`diary-day-${hw.id}-${day}`}>
              <b>{keyDayMonth(day)}</b>
              <small>{weekdayShort(weekdayOfKey(day))}</small>
            </span>
          );
        })}
      </div>

      {d.canWrite &&
        (editing ? (
          <div className="acad-cab-diary-write">
            <label htmlFor={`diary-text-${hw.id}`}>Имрӯз ({keyDayMonth(d.today)}) чӣ кор кардед? Вазифа чӣ гуна пеш меравад?</label>
            <textarea
              id={`diary-text-${hw.id}`}
              rows={3}
              maxLength={2000}
              value={text}
              placeholder="Масалан: 20 калимаро ёд гирифтам, машқи 3-ро иҷро кардам, дар машқи 4 савол дорам…"
              onChange={(e) => setText(e.target.value)}
              data-testid={`diary-text-${hw.id}`}
            />
            {error && <div className="acad-cab-error">{error}</div>}
            <div className="acad-cab-diary-actions">
              {todayLog && (
                <button type="button" className="acad-cab-link" onClick={() => { setText(todayLog.text); setEditing(false); }}>
                  Бекор кардан
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={!text.trim() || mut.isPending}
                onClick={() => mut.mutate()}
                data-testid={`diary-save-${hw.id}`}
              >
                {mut.isPending ? 'Сабт…' : 'Сабт кардан'}
              </button>
            </div>
          </div>
        ) : (
          <div className="acad-cab-diary-saved" data-testid={`diary-saved-${hw.id}`}>
            <Icon name="check_circle" size={18} />
            <span>Сабти имрӯз нигоҳ дошта шуд. То охири рӯз онро тағйир додан мумкин аст.</span>
            <button type="button" className="acad-cab-link" onClick={() => setEditing(true)} data-testid={`diary-edit-${hw.id}`}>
              Тағйир додан
            </button>
          </div>
        ))}
      {!d.open && <div className="acad-cab-diary-closed">Мӯҳлати вазифа гузашт — рӯзнома баста шуд.</div>}

      {written.length > 0 && (
        <div className="acad-cab-diary-entries">
          {[...written].reverse().map((day) => (
            <div key={day} className="acad-cab-diary-entry">
              <span className="acad-cab-diary-entry-day">
                {keyDayMonth(day)} <small>{weekdayShort(weekdayOfKey(day))}</small>
              </span>
              <span className="acad-cab-diary-entry-text">{d.logs[day].text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
