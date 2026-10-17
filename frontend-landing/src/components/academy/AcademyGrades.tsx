import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import Icon from '../../Icon';
import { getAcademyProgress, type AcademyProgressGroup, type AcademyProgressWeek } from '../../studentApi';
import { lkeys } from '../../queryClient';
import { tjWeekday } from '../../tjDate';
import ProgressChart from './ProgressChart';
import { TotalPill, dayMonth, keyDayMonth } from './academyBits';

/**
 * «Баҳоҳо»: по каждой группе — график итогов недель (свой и средний по
 * группе), ниже недели (свежие сверху): за каждый урок давомот, баҳо и
 * шарҳи муаллим, в конце недели бонус, имтиҳон и натиҷа.
 */
export default function AcademyGrades() {
  const q = useQuery({ queryKey: lkeys.academy.progress(), queryFn: getAcademyProgress });
  if (q.isLoading) return <div className="stu-card acad-cab-empty">Боргузорӣ…</div>;
  const groups = (q.data ?? []).filter((g) => g.weeks.length > 0);
  if (!groups.length) {
    return (
      <div className="stu-card acad-cab-empty" data-testid="academy-grades-empty">
        <Icon name="grading" size={36} />
        <span>Ҳоло баҳо нест</span>
      </div>
    );
  }
  return (
    <div data-testid="academy-grades">
      {groups.map((g) => (
        <GroupGrades key={g.group.id} g={g} />
      ))}
    </div>
  );
}

function GroupGrades({ g }: { g: AcademyProgressGroup }) {
  // Недели, которые ещё не начались, ученику не показываем — в них пусто.
  const started = g.weeks.filter((w) => w.lessons.some((l) => l.past) || w.final);
  const weeksDesc = [...started].reverse();
  const def = [...started].reverse()[0]?.key ?? weeksDesc[0]?.key;
  const [open, setOpen] = useState<Set<string>>(new Set(def ? [def] : []));
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const finals = g.weeks.filter((w) => w.final);
  return (
    <section className="stu-card acad-cab-grades" data-testid={`grades-${g.group.id}`}>
      <div className="acad-cab-grades-head">
        <div>
          <div className="acad-cab-eyebrow">{g.active ? 'Гурӯҳи ман' : 'Гурӯҳи пешина'}</div>
          <h2>{g.group.name}</h2>
          {g.group.teacher && <div className="acad-cab-sub">Муаллим: {g.group.teacher.fullName}</div>}
        </div>
        <div className="acad-cab-grades-sum">
          <span>Баҳои миёна <TotalPill total={g.summary.avg} /></span>
          <span>Давомот <b>{g.summary.attendancePct !== null ? `${g.summary.attendancePct}%` : '—'}</b></span>
        </div>
      </div>

      {finals.length > 0 && (
        <ProgressChart
          weeks={started.map((w) => ({ x: w.index, label: `Ҳафтаи ${w.index}` }))}
          series={[
            { id: 'me', name: 'Шумо', color: '#01368B', points: finals.map((w) => ({ x: w.index, y: w.total })) },
            {
              id: 'avg',
              name: 'Миёнаи гурӯҳ',
              color: '#94a3b8',
              dashed: true,
              points: g.weeks.filter((w) => w.groupAvg !== null).map((w) => ({ x: w.index, y: w.groupAvg as number })),
            },
          ]}
        />
      )}

      <div className="acad-cab-weeks">
        {weeksDesc.map((w) => (
          <WeekBlock key={w.key} w={w} open={open.has(w.key)} onToggle={() => toggle(w.key)} />
        ))}
      </div>
      <p className="acad-cab-formula">
        Натиҷаи ҳафта = дарсҳо (давомот + баҳоҳо, то 30 хол) + имтиҳон (то 70) + бонус (то 10), ҳадди аксар 100.
        То гузоштани имтиҳон натиҷа хокистарранг аст.
      </p>
    </section>
  );
}

function WeekBlock({ w, open, onToggle }: { w: AcademyProgressWeek; open: boolean; onToggle: () => void }) {
  return (
    <div className={`acad-cab-week${open ? ' is-open' : ''}`} data-testid={`grades-week-${w.index}`}>
      <button type="button" className="acad-cab-week-head" onClick={onToggle} aria-expanded={open}>
        <span className="acad-cab-week-title">
          Ҳафтаи {w.index}
          <Icon name={open ? 'expand_less' : 'expand_more'} size={20} />
        </span>
        <span className="acad-cab-week-range">{keyDayMonth(w.from)} – {keyDayMonth(w.to)}</span>
        <span className="acad-cab-week-total">
          <TotalPill total={w.held || w.final ? w.total : null} final={w.final} title={w.final ? undefined : 'Имтиҳон ҳоло гузошта нашудааст'} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden' }}
          >
            <div className="acad-cab-lessons">
              {w.lessons.map((l) => {
                const m = l.mark;
                return (
                  <div key={l.id} className={`acad-cab-lesson${l.past ? '' : ' is-future'}`}>
                    <div className="acad-cab-lesson-date">
                      <b>{dayMonth(l.startsAt)}</b>
                      <span>{tjWeekday(l.startsAt)}</span>
                    </div>
                    <div className="acad-cab-lesson-body">
                      <div className="acad-cab-lesson-topic">{l.topic || 'Дарс'}</div>
                      {m?.comment && (
                        <div className="acad-cab-comment">
                          <Icon name="chat" size={15} />
                          <span>{m.comment}</span>
                        </div>
                      )}
                    </div>
                    <div className="acad-cab-lesson-marks">
                      {!l.past ? (
                        <span className="acad-cab-tag is-soon">Ҳоло нарасидааст</span>
                      ) : m?.present === true ? (
                        <span className="acad-cab-tag is-yes">Ҳозир</span>
                      ) : m?.present === false ? (
                        <span className="acad-cab-tag is-no">Ғоиб</span>
                      ) : (
                        <span className="acad-cab-tag">—</span>
                      )}
                      {m?.score ? <span className="acad-cab-score" title="Баҳо">{m.score}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="acad-cab-week-end">
              <span>Бонус: <b>{w.bonus ?? '—'}</b></span>
              <span>Имтиҳон: <b>{w.exam ?? '—'}</b></span>
              <span>Барои дарсҳо: <b>{w.held ? w.lessonPoints : '—'}</b></span>
              <span className="acad-cab-week-end-total">
                Натиҷа: <TotalPill total={w.held || w.final ? w.total : null} final={w.final} />
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
