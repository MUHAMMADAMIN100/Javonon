import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../Icon';
import { getAcademyProgress, type AcademyProgressGroup } from '../../studentApi';
import { lkeys } from '../../queryClient';
import { tjWeekday } from '../../tjDate';
import ProgressChart from './ProgressChart';
import { ATTENDANCE_TJ, TotalPill, dayMonth, pct } from './academyBits';

/** Сколько уроков показывать сразу; остальные — «Боз нишон додан». */
const PAGE = 12;

/**
 * «Баҳоҳо»: по каждой группе — сводка (натиҷаи миёна, давомот, дер
 * омаданҳо), график «Ҳамагӣ аз рӯи ҳафтаҳо» (свой и средний по группе) и
 * уроки, свежие сверху: давомот, Homework, Vocabulary, Class Performance,
 * Ҳамагӣ и шарҳи муаллим — как лист журнала в CRM.
 */
export default function AcademyGrades() {
  const q = useQuery({ queryKey: lkeys.academy.progress(), queryFn: getAcademyProgress });
  if (q.isLoading) return <div className="stu-card acad-cab-empty">Боргузорӣ…</div>;
  const groups = (q.data ?? []).filter((g) => Array.isArray(g.lessons) && g.lessons.length > 0);
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
  const [limit, setLimit] = useState(PAGE);
  const lessons = [...g.lessons].reverse();
  const weeks = (g.weeks ?? []).filter((w) => 'me' in w);
  return (
    <section className="stu-card acad-cab-grades" data-testid={`grades-${g.group.id}`}>
      <div className="acad-cab-grades-head">
        <div>
          <div className="acad-cab-eyebrow">{g.active ? 'Гурӯҳи ман' : g.completed ? 'Курси хатмшуда' : 'Гурӯҳи пешина'}</div>
          <h2>{g.group.name}</h2>
          {g.group.teacher && <div className="acad-cab-sub">Муаллим: {g.group.teacher.fullName}</div>}
        </div>
        <div className="acad-cab-grades-sum">
          <span>Натиҷаи миёна <TotalPill total={g.summary.avg} /></span>
          <span>Давомот <b>{pct(g.summary.attendancePct)}</b></span>
          {g.summary.late > 0 && <span>Дер омадан <b>{g.summary.late}</b></span>}
        </div>
      </div>

      {weeks.some((w) => w.me !== null) && (
        <ProgressChart
          weeks={weeks.map((w) => ({ x: w.index, label: `Ҳафтаи ${w.index}` }))}
          series={[
            { id: 'me', name: 'Шумо', color: '#01368B', points: weeks.filter((w) => w.me !== null).map((w) => ({ x: w.index, y: w.me as number })) },
            {
              id: 'avg',
              name: 'Миёнаи гурӯҳ',
              color: '#94a3b8',
              dashed: true,
              points: weeks.filter((w) => w.groupAvg !== null).map((w) => ({ x: w.index, y: w.groupAvg as number })),
            },
          ]}
        />
      )}

      <div className="acad-cab-marks" data-testid={`grades-lessons-${g.group.id}`}>
        <div className="acad-cab-mark is-head" aria-hidden="true">
          <span>Сана</span>
          <span>Мавзӯъ</span>
          <span>Давомот</span>
          <span>Homework</span>
          <span>Vocabulary</span>
          <span>Class</span>
          <span>Ҳамагӣ</span>
        </div>
        {lessons.slice(0, limit).map((l) => {
          const m = l.mark;
          return (
            <div key={l.id} className="acad-cab-mark" data-testid={`grade-${l.id}`}>
              <span className="acad-cab-mark-date">
                <b>{dayMonth(l.startsAt)}</b>
                <small>{tjWeekday(l.startsAt)}</small>
              </span>
              <span className="acad-cab-mark-topic">
                {l.topic || 'Дарс'}
                {m?.comment && (
                  <span className="acad-cab-comment">
                    <Icon name="chat" size={15} />
                    <span>{m.comment}</span>
                  </span>
                )}
              </span>
              <span className="acad-cab-mark-att">
                {m?.attendance ? (
                  <span className={`acad-cab-att is-${m.attendance.toLowerCase()}`}>{ATTENDANCE_TJ[m.attendance]}</span>
                ) : (
                  <span className="acad-cab-tag">—</span>
                )}
              </span>
              <span className="acad-cab-mark-pct" data-label="Homework">{pct(m?.homeworkPct)}</span>
              <span className="acad-cab-mark-pct" data-label="Vocabulary">{pct(m?.vocabularyPct)}</span>
              <span className="acad-cab-mark-pct" data-label="Class">{pct(m?.performancePct)}</span>
              <span className="acad-cab-mark-total">
                <TotalPill total={m?.total} />
              </span>
            </div>
          );
        })}
      </div>
      {lessons.length > limit && (
        <button type="button" className="acad-cab-more" onClick={() => setLimit((n) => n + PAGE * 2)}>
          Боз нишон додан ({lessons.length - limit})
        </button>
      )}
      <p className="acad-cab-formula">
        Ҳамагии дарс — миёнаи фоизҳои Homework, Vocabulary ва Class Performance. Агар дар дарс набошед («Ғоиб»), ҳамагӣ 0% ҳисоб мешавад.
      </p>
    </section>
  );
}
