import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../Icon';
import {
  downloadAcademyMaterial,
  getAcademyHomework,
  getAcademyLessons,
  type AcademyHomework,
  type AcademyLesson,
  type AcademyOverview,
} from '../../studentApi';
import { lkeys } from '../../queryClient';
import { tjDateFull, tjDayKey, tjDayLabel, tjTime } from '../../tjDate';
import { TotalPill, calendarDate, fileSize, materialIcon, patternText } from './academyBits';
import AcademyGrades from './AcademyGrades';

type Sub = 'schedule' | 'homework' | 'grades';
const FLAGS_FOR_DECISION = 3;

/**
 * Вкладка «Академия» в кабинете студента: группа и муаллим, дни занятий,
 * сводка (баҳои миёна, давомот, парчамҳо) и три раздела — ҷадвал,
 * вазифаи хонагӣ, баҳоҳо. Отчисленный видит плашку с причиной и свои
 * прежние оценки; занятия и ДЗ ему больше не показываются.
 */
export default function AcademySection({ overview }: { overview: Extract<AcademyOverview, { hasAcademy: true }> }) {
  const [sub, setSub] = useState<Sub>('schedule');
  const o = overview;
  const expelled = o.status === 'EXPELLED';

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
          <Icon name="group_add" size={24} />
          <div>
            <b>Шумо ҳоло дар ягон гурӯҳ нестед</b>
            <span>Маъмурият шуморо ба гурӯҳ илова мекунад — ҷадвал ва вазифаҳо дар ин ҷо пайдо мешаванд.</span>
          </div>
        </div>
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
        <div className="acad-cab-tile">
          <span>Баҳои миёна</span>
          <TotalPill total={o.summary.avg} />
        </div>
        <div className="acad-cab-tile">
          <span>Давомот</span>
          <b>{o.summary.attendancePct !== null ? `${o.summary.attendancePct}%` : '—'}</b>
        </div>
        <div className={`acad-cab-tile${o.flags.length ? ' is-flags' : ''}`} data-testid="academy-flags-tile">
          <span>Парчамҳои сурх</span>
          <b>
            {o.flags.length} / {FLAGS_FOR_DECISION}
          </b>
        </div>
      </div>

      {o.flags.length > 0 && (
        <section className="stu-card acad-cab-flags" data-testid="academy-flags">
          <h2>Парчамҳои сурх</h2>
          {!expelled && (
            <div className="acad-cab-warn">
              <Icon name="warning" size={18} />
              <span>
                {o.flags.length >= FLAGS_FOR_DECISION
                  ? 'Шумо 3 парчами сурх гирифтед — роҳбарият дар бораи идомаи таҳсили шумо қарор қабул мекунад.'
                  : 'Агар 3 парчами сурх гиред, роҳбарият метавонад шуморо аз академия хориҷ кунад.'}
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
          ['schedule', 'calendar_month', 'Ҷадвал'],
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
          </button>
        ))}
      </div>

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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = q.data ?? [];

  const download = async (m: { id: string; title: string }) => {
    setBusy(m.id);
    setError(null);
    try {
      await downloadAcademyMaterial(m.id, m.title);
    } catch {
      setError('Файлро боргирӣ кардан нашуд. Бори дигар кӯшиш кунед.');
    } finally {
      setBusy(null);
    }
  };

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
      {error && <div className="acad-cab-error">{error}</div>}
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
          {h.materials.length > 0 && (
            <div className="acad-cab-materials">
              {h.materials.map((m) =>
                m.kind === 'LINK' ? (
                  <a key={m.id} className="acad-cab-material" href={m.url || '#'} target="_blank" rel="noreferrer">
                    <Icon name="link" size={18} />
                    <span>{m.title}</span>
                    <small>Кушодан</small>
                  </a>
                ) : (
                  <button
                    key={m.id}
                    type="button"
                    className="acad-cab-material"
                    onClick={() => download(m)}
                    disabled={busy === m.id}
                    data-testid={`hw-file-${m.id}`}
                  >
                    <Icon name={materialIcon(m.kind, m.mimeType, m.title)} size={18} />
                    <span>{m.title}</span>
                    <small>{busy === m.id ? 'Боргирӣ…' : `${fileSize(m.size)} · Боргирӣ`}</small>
                  </button>
                ),
              )}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
