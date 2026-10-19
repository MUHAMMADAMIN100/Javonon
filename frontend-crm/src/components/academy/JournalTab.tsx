import { useEffect, useMemo, useRef, useState } from 'react';
import { roleCan } from '../../lib/permissions';
import { useAuth } from '../../store/auth';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import Loading from '../Loading';
import { SortSelect, SortTh, useTableSort } from '../TableSort';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { tjFormatDate, tjFormatTime } from '../../lib/tjTime';
import { useMediaQuery } from '../../lib/useMediaQuery';
import {
  PCT_MAX,
  getJournal,
  lessonTotal,
  saveEntries,
  type Attendance,
  type EntryPatch,
  type Journal,
  type JournalLesson,
  type JournalStudent,
  type LessonMark,
} from '../../api/academy';
import ScoreChart, { type ChartSeries } from './ScoreChart';
import {
  ATTENDANCE,
  FlagDots,
  LevelBadge,
  TotalBadge,
  leftKey,
  pct,
  shortDate,
  tjWeekdayOf,
  weekKeyOfDay,
  weekdayKey,
} from './academyUi';

/**
 * Журнал группы — как бумажный лист заказчика: выбираешь урок (полоса дат
 * сверху), ниже таблица «№ / Ф.И.О. / Attendance (Был · Нет · Опоздал) /
 * Homework % / Vocabulary % / Class Performance % / Итого». Итого — среднее
 * заполненных процентов, «Нет» — 0 %. Внизу листа — среднее по группе.
 *
 * Над листом — сводка и график «Итого по неделям», под ним — итоги каждого
 * ученика. Сводки и график считает сервер (academy/journal-math.ts): после
 * сохранения журнал перечитывается, а сама отметка меняется на экране сразу.
 * На телефоне лист — карточками учеников, удобно отмечать прямо на уроке.
 */

type PctField = 'homeworkPct' | 'vocabularyPct' | 'performancePct';
const PCT_FIELDS: PctField[] = ['homeworkPct', 'vocabularyPct', 'performancePct'];
const PCT_LABEL: Record<PctField, string> = {
  homeworkPct: 'academy.journal.col.homework',
  vocabularyPct: 'academy.journal.col.vocabulary',
  performancePct: 'academy.journal.col.performance',
};

const EMPTY_MARK: LessonMark = {
  attendance: null,
  homeworkPct: null,
  vocabularyPct: null,
  performancePct: null,
  comment: null,
  total: null,
};

/** Отметки урока сразу на экране — по тем же правилам, что на сервере. */
function applyEntries(j: Journal, lessonId: string, items: EntryPatch[]): Journal {
  const byStudent = { ...(j.marks[lessonId] ?? {}) };
  for (const item of items) {
    const next: LessonMark = { ...(byStudent[item.studentId] ?? EMPTY_MARK) };
    if (item.attendance !== undefined) next.attendance = item.attendance;
    for (const f of PCT_FIELDS) if (item[f] !== undefined) next[f] = item[f] as number | null;
    if (item.comment !== undefined) next.comment = item.comment || null;
    if (item.attendance === 'ABSENT' || item.attendance === null) {
      next.homeworkPct = null;
      next.vocabularyPct = null;
      next.performancePct = null;
    } else if (PCT_FIELDS.some((f) => next[f] !== null) && (next.attendance === null || next.attendance === 'ABSENT')) {
      next.attendance = 'PRESENT';
    }
    next.total = lessonTotal(next);
    byStudent[item.studentId] = next;
  }
  return { ...j, marks: { ...j.marks, [lessonId]: byStudent } };
}

/** Урок по умолчанию: сегодняшний, иначе последний наступивший, иначе первый. */
function defaultLesson(j: Journal): JournalLesson | undefined {
  const todays = j.lessons.filter((l) => l.day === j.today);
  if (todays.length) return todays[0];
  const reached = j.lessons.filter((l) => l.markable);
  return reached[reached.length - 1] ?? j.lessons[0];
}

const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

export default function JournalTab({
  groupId,
  meId,
  onGoLessons,
}: {
  groupId: string;
  meId?: string;
  /** Пустой журнал → «Добавить занятия» ведёт на вкладку уроков. */
  onGoLessons?: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  // Подменному учителю с ролью свои уроки отмечать — с «Ведением».
  const me = useAuth((s) => s.user);
  const substituteMarks = roleCan(me, 'groups:write');
  const jKey = keys.academy.journal(groupId);
  const narrow = useMediaQuery('(max-width: 760px)');
  const [params, setParams] = useSearchParams();

  const query = useQuery({ queryKey: jKey, queryFn: () => getJournal(groupId) });
  const j = query.data;
  const [commentFor, setCommentFor] = useState<{ lesson: JournalLesson; studentId: string } | null>(null);

  // Отметка меняется на экране СРАЗУ, в том же обработчике: если ждать отмены
  // запросов (await), кнопка на миг возвращается назад. Ошибка сервера
  // откатывает к снимку, после ответа журнал перечитывается (сводки и
  // график считает сервер).
  const entryMut = useMutation({
    mutationFn: (v: { lessonId: string; items: EntryPatch[]; prev?: Journal }) => saveEntries(v.lessonId, v.items),
    onError: (e: any, v) => {
      if (v.prev) qc.setQueryData(jKey, v.prev);
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: jKey });
      qc.invalidateQueries({ queryKey: keys.academy.all });
    },
  });

  const students = useMemo(() => new Map((j?.students ?? []).map((s) => [s.id, s])), [j?.students]);

  // Новый формат журнала (лист урока). Пока сервер не обновился после выкладки,
  // уроков в ответе нет — показываем пустой журнал, а не ошибку.
  const fresh = !!j && Array.isArray(j.lessons) && !!j.today;

  const chart = useMemo(() => {
    if (!j || !fresh) return { series: [] as ChartSeries[], weeks: [] as Array<{ x: number; label: string }> };
    const current = weekKeyOfDay(j.today);
    const started = j.weeks.filter((w) => w.key <= current);
    const series: ChartSeries[] = j.students
      .filter((s) => s.active || s.summary.graded > 0)
      .map((s) => ({
        id: s.id,
        name: s.fullName,
        points: started.flatMap((w) => (w.values && s.id in w.values ? [{ x: w.index, y: w.values[s.id] }] : [])),
        avg: s.summary.avg,
      }));
    return { series, weeks: started.map((w) => ({ x: w.index, label: `${t('academy.week')} ${w.index}` })) };
  }, [j, fresh, t]);

  if (query.isLoading || !j) return <Loading />;
  if (query.isError) return <div className="acad-empty">{t('toast.error')}</div>;

  if (!fresh || j.lessons.length === 0) {
    return (
      <div className="acad-empty" data-testid="journal-empty">
        <Icon name="event_note" size={40} />
        <div>{t('academy.journal.empty')}</div>
        {onGoLessons && j.canEditAll && (
          <button className="btn btn-primary btn-sm" onClick={onGoLessons}>
            <Icon name="event_repeat" size={16} /> {t('academy.lessons.addByTemplate')}
          </button>
        )}
      </div>
    );
  }

  const lesson = j.lessons.find((l) => l.id === params.get('lesson')) ?? defaultLesson(j)!;
  const selectLesson = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('lesson', id);
    setParams(p, { replace: true });
  };

  const canEditLesson = (l: JournalLesson) => j.canEditAll || (substituteMarks && !!meId && l.teacherId === meId);
  const editable = canEditLesson(lesson) && lesson.markable;

  const mark = (l: JournalLesson, items: EntryPatch[]) => {
    const prev = qc.getQueryData<Journal>(jKey);
    void qc.cancelQueries({ queryKey: jKey });
    if (prev) qc.setQueryData(jKey, applyEntries(prev, l.id, items));
    entryMut.mutate({ lessonId: l.id, items, prev });
  };

  // Лист урока: ученики по алфавиту, вышедшие — в конце.
  const sheetIds = j.sheet[lesson.id] ?? [];
  const rows = sheetIds
    .map((id) => students.get(id))
    .filter((s): s is JournalStudent => !!s)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.fullName.localeCompare(b.fullName, 'ru'));
  const marksOf = (studentId: string) => j.marks[lesson.id]?.[studentId] ?? EMPTY_MARK;
  const unmarked = rows.filter((s) => s.active && !marksOf(s.id).attendance);

  const active = j.students.filter((s) => s.active);
  const groupAvg = mean(active.flatMap((s) => (s.summary.avg !== null ? [s.summary.avg] : [])));
  const groupAtt = mean(active.flatMap((s) => (s.summary.attendancePct !== null ? [s.summary.attendancePct] : [])));
  const lessonsHeld = j.lessons.filter((l) => l.past).length;

  const commentMark = commentFor ? j.marks[commentFor.lesson.id]?.[commentFor.studentId] : null;

  return (
    <div className="acad-journal" data-testid="journal">
      <div className="acad-journal-stats">
        <div><span>{t('academy.stats.students')}</span><b>{active.length}</b></div>
        <div><span>{t('academy.stats.groupAvg')}</span><b data-testid="journal-group-avg">{pct(groupAvg)}</b></div>
        <div><span>{t('academy.stats.attendance')}</span><b>{pct(groupAtt)}</b></div>
        <div><span>{t('academy.stats.lessons')}</span><b>{lessonsHeld}</b></div>
      </div>

      <div className="card acad-chart-card">
        <div className="acad-chart-head">{t('academy.chart.title')}</div>
        <ScoreChart series={chart.series} weeks={chart.weeks} height={narrow ? 220 : 260} testId="journal-chart" />
      </div>

      <div className="card acad-sheet-card" data-testid="journal-sheet">
        <LessonStrip lessons={j.lessons} today={j.today} activeId={lesson.id} marks={j.marks} sheet={j.sheet} onSelect={selectLesson} />

        <div className="acad-sheet-head">
          <div className="acad-sheet-title" data-testid="sheet-title">
            <b>{t('academy.journal.lesson')} {lesson.number}</b>
            <span>
              {t(`weekday.short.${weekdayKey(tjWeekdayOf(lesson.startsAt))}`)}, {tjFormatDate(lesson.startsAt)} ·{' '}
              {tjFormatTime(lesson.startsAt)}–{tjFormatTime(lesson.endsAt)}
            </span>
            {lesson.day === j.today && <span className="acad-week-now">{t('academy.journal.today')}</span>}
            {!lesson.markable && <span className="acad-sheet-future">{t('academy.journal.future')}</span>}
          </div>
          <div className="acad-sheet-topic">{lesson.topic || t('classes.noTopic')}</div>
          {editable && unmarked.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm acad-sheet-allbtn"
              data-testid="mark-all"
              title={t('academy.journal.markAllHint')}
              onClick={() => mark(lesson, unmarked.map((s) => ({ studentId: s.id, attendance: 'PRESENT' as Attendance })))}
            >
              <Icon name="done_all" size={16} /> {t('academy.journal.markAll')}
            </button>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="acad-hint" style={{ padding: '12px 4px' }}>{t('academy.journal.notOnSheet')}</div>
        ) : narrow ? (
          <SheetCards
            lesson={lesson}
            rows={rows}
            marksOf={marksOf}
            editable={editable}
            onMark={(items) => mark(lesson, items)}
            onComment={(studentId) => setCommentFor({ lesson, studentId })}
          />
        ) : (
          <SheetTable
            lesson={lesson}
            rows={rows}
            marksOf={marksOf}
            editable={editable}
            onMark={(items) => mark(lesson, items)}
            onComment={(studentId) => setCommentFor({ lesson, studentId })}
          />
        )}
        <div className="acad-jt-legend">{t('academy.journal.pctHint')}</div>
      </div>

      <SummaryCard students={j.students} />

      <AnimatePresence>
        {commentFor && (
          <CommentModal
            title={`${students.get(commentFor.studentId)?.fullName ?? ''} · ${shortDate(commentFor.lesson.startsAt)}`}
            initial={commentMark?.comment ?? ''}
            readOnly={!canEditLesson(commentFor.lesson) || !commentFor.lesson.markable}
            onClose={() => setCommentFor(null)}
            onSave={(text) => {
              mark(commentFor.lesson, [{ studentId: commentFor.studentId, comment: text.trim() || null }]);
              setCommentFor(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Полоса дат уроков: стрелки «предыдущий / следующий», выбранный урок
 * прокручивается в середину. Точка под датой — урок отмечен полностью
 * (зелёная) или частично (жёлтая).
 */
function LessonStrip({
  lessons,
  today,
  activeId,
  marks,
  sheet,
  onSelect,
}: {
  lessons: JournalLesson[];
  today: string;
  activeId: string;
  marks: Journal['marks'];
  sheet: Journal['sheet'];
  onSelect: (id: string) => void;
}) {
  const { t } = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idx = lessons.findIndex((l) => l.id === activeId);

  useEffect(() => {
    const box = scrollRef.current;
    const chip = box?.querySelector<HTMLElement>(`[data-lesson="${activeId}"]`);
    if (!box || !chip) return;
    const left = chip.offsetLeft - box.clientWidth / 2 + chip.clientWidth / 2;
    box.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [activeId]);

  const fill = (l: JournalLesson): 'done' | 'partial' | 'none' => {
    const ids = sheet[l.id] ?? [];
    if (!ids.length) return 'none';
    const marked = ids.filter((id) => marks[l.id]?.[id]?.attendance).length;
    if (!marked) return 'none';
    return marked >= ids.length ? 'done' : 'partial';
  };

  return (
    <div className="acad-lesson-strip">
      <button
        type="button"
        className="acad-ls-nav"
        aria-label={t('academy.journal.prevLesson')}
        disabled={idx <= 0}
        onClick={() => idx > 0 && onSelect(lessons[idx - 1].id)}
        data-testid="lesson-prev"
      >
        <Icon name="chevron_left" size={20} />
      </button>
      <div className="acad-ls-scroll" ref={scrollRef}>
        {lessons.map((l) => {
          const f = fill(l);
          return (
            <button
              key={l.id}
              type="button"
              data-lesson={l.id}
              data-testid={`lesson-chip-${l.id}`}
              className={`acad-ls-chip${l.id === activeId ? ' is-active' : ''}${l.day === today ? ' is-today' : ''}${
                l.markable ? '' : ' is-future'
              } is-${f}`}
              onClick={() => onSelect(l.id)}
              title={l.topic || undefined}
            >
              <b>{t(`weekday.short.${weekdayKey(tjWeekdayOf(l.startsAt))}`)}</b>
              <span>{shortDate(l.startsAt)}</span>
              <i aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="acad-ls-nav"
        aria-label={t('academy.journal.nextLesson')}
        disabled={idx >= lessons.length - 1}
        onClick={() => idx < lessons.length - 1 && onSelect(lessons[idx + 1].id)}
        data-testid="lesson-next"
      >
        <Icon name="chevron_right" size={20} />
      </button>
    </div>
  );
}

type SheetProps = {
  lesson: JournalLesson;
  rows: JournalStudent[];
  marksOf: (studentId: string) => LessonMark;
  editable: boolean;
  onMark: (items: EntryPatch[]) => void;
  onComment: (studentId: string) => void;
};

/** Средние строки «Среднее по группе»: по заполненным значениям. */
function footer(rows: JournalStudent[], marksOf: SheetProps['marksOf']) {
  const ms = rows.map((s) => marksOf(s.id));
  const avgOf = (f: PctField | 'total') => mean(ms.flatMap((m) => (m[f] !== null ? [m[f] as number] : [])));
  return {
    present: ms.filter((m) => m.attendance === 'PRESENT').length,
    absent: ms.filter((m) => m.attendance === 'ABSENT').length,
    late: ms.filter((m) => m.attendance === 'LATE').length,
    homeworkPct: avgOf('homeworkPct'),
    vocabularyPct: avgOf('vocabularyPct'),
    performancePct: avgOf('performancePct'),
    total: avgOf('total'),
  };
}

/** Лист урока таблицей — как на бумаге (компьютер, планшет). */
function SheetTable({ lesson, rows, marksOf, editable, onMark, onComment }: SheetProps) {
  const { t } = useT();
  const tableRef = useRef<HTMLTableElement | null>(null);
  const foot = footer(rows, marksOf);

  // Enter в поле процента — к тому же столбцу в следующей строке, как в таблице.
  const focusNext = (row: number, col: number) => {
    const next = tableRef.current?.querySelector<HTMLInputElement>(`input[data-row="${row + 1}"][data-col="${col}"]`);
    if (next) {
      next.focus();
      next.select();
    } else {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  };

  return (
    <div className="acad-sheet-wrap">
      <table className="acad-sheet" ref={tableRef} data-testid={`sheet-${lesson.id}`}>
        <thead>
          <tr>
            <th className="acad-sh-no">{t('academy.journal.no')}</th>
            <th className="acad-sh-name">{t('academy.journal.studentCol')}</th>
            <th className="acad-sh-att">{t('academy.journal.col.attendance')}</th>
            {PCT_FIELDS.map((f) => (
              <th key={f} className="acad-sh-pct">{t(PCT_LABEL[f])}</th>
            ))}
            <th className="acad-sh-total">{t('academy.journal.col.total')}</th>
            <th className="acad-sh-comment" aria-label={t('academy.journal.comment')} />
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const m = marksOf(s.id);
            const absent = m.attendance === 'ABSENT';
            return (
              <tr key={s.id} className={s.active ? '' : 'is-left'} data-testid={`jrow-${s.id}`}>
                <td className="acad-sh-no">{i + 1}</td>
                <td className="acad-sh-name">
                  <span className="acad-sh-student">{s.fullName}</span>
                  <span className="acad-sh-tags">
                    <LevelBadge level={s.level} hideEmpty />
                    {s.flags > 0 && <FlagDots count={s.flags} />}
                    {!s.active && <span className="acad-jt-left">{t(leftKey(s.leftReason))}</span>}
                  </span>
                </td>
                <td className="acad-sh-att">
                  <AttSegment
                    value={m.attendance}
                    disabled={!editable}
                    testId={`att-${s.id}`}
                    onChange={(attendance) => onMark([{ studentId: s.id, attendance }])}
                  />
                </td>
                {PCT_FIELDS.map((f, col) => (
                  <td key={f} className="acad-sh-pct">
                    <PctInput
                      value={m[f]}
                      disabled={!editable || absent}
                      title={absent ? t('academy.journal.absentLocked') : undefined}
                      testId={`${f}-${s.id}`}
                      row={i}
                      col={col}
                      onSave={(v) => onMark([{ studentId: s.id, [f]: v }])}
                      onEnter={() => focusNext(i, col)}
                    />
                  </td>
                ))}
                <td className="acad-sh-total">
                  <TotalBadge total={m.total} testId={`total-${s.id}`} />
                </td>
                <td className="acad-sh-comment">
                  <button
                    type="button"
                    className={`acad-comment-btn${m.comment ? ' has-comment' : ''}`}
                    title={m.comment || t('academy.journal.comment')}
                    disabled={!lesson.markable || (!editable && !m.comment)}
                    data-testid={`comment-${s.id}`}
                    onClick={() => onComment(s.id)}
                  >
                    <Icon name={m.comment ? 'chat' : 'chat_bubble'} size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="acad-sheet-foot" data-testid="sheet-foot">
            <td />
            <td className="acad-sh-name">{t('academy.journal.groupAvg')}</td>
            <td className="acad-sh-att acad-sh-counts">
              {t('academy.journal.counts')
                .replace('{p}', String(foot.present))
                .replace('{a}', String(foot.absent))
                .replace('{l}', String(foot.late))}
            </td>
            {PCT_FIELDS.map((f) => (
              <td key={f} className="acad-sh-pct">{pct(foot[f])}</td>
            ))}
            <td className="acad-sh-total">
              <TotalBadge total={foot.total} testId="sheet-avg-total" />
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Лист урока на телефоне: карточка на ученика — посещение, три процента, итог. */
function SheetCards({ lesson, rows, marksOf, editable, onMark, onComment }: SheetProps) {
  const { t } = useT();
  const foot = footer(rows, marksOf);
  return (
    <div className="acad-sheet-cards" data-testid={`sheet-cards-${lesson.id}`}>
      {rows.map((s, i) => {
        const m = marksOf(s.id);
        const absent = m.attendance === 'ABSENT';
        return (
          <div key={s.id} className={`acad-sc-card${s.active ? '' : ' is-left'}`} data-testid={`jcard-${s.id}`}>
            <div className="acad-sc-head">
              <span className="acad-sc-name">
                <span className="acad-sc-num">{i + 1}.</span> {s.fullName}
              </span>
              <TotalBadge total={m.total} testId={`total-${s.id}`} />
            </div>
            {(s.level || s.flags > 0 || !s.active) && (
              <div className="acad-sh-tags">
                <LevelBadge level={s.level} hideEmpty />
                {s.flags > 0 && <FlagDots count={s.flags} />}
                {!s.active && <span className="acad-jt-left">{t(leftKey(s.leftReason))}</span>}
              </div>
            )}
            <AttSegment
              value={m.attendance}
              disabled={!editable}
              testId={`att-${s.id}`}
              onChange={(attendance) => onMark([{ studentId: s.id, attendance }])}
              wide
            />
            <div className="acad-sc-pcts">
              {PCT_FIELDS.map((f, col) => (
                <label key={f} className="acad-sc-pct">
                  <span>{t(PCT_LABEL[f])}</span>
                  <PctInput
                    value={m[f]}
                    disabled={!editable || absent}
                    testId={`${f}-${s.id}`}
                    row={i}
                    col={col}
                    onSave={(v) => onMark([{ studentId: s.id, [f]: v }])}
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className={`acad-sc-comment${m.comment ? ' has-comment' : ''}`}
              disabled={!lesson.markable || (!editable && !m.comment)}
              onClick={() => onComment(s.id)}
              data-testid={`comment-${s.id}`}
            >
              <Icon name={m.comment ? 'chat' : 'chat_bubble'} size={16} />
              <span>{m.comment || t('academy.journal.comment')}</span>
            </button>
          </div>
        );
      })}
      <div className="acad-sc-foot" data-testid="sheet-foot">
        <div className="acad-sc-foot-head">
          <b>{t('academy.journal.groupAvg')}</b>
          <TotalBadge total={foot.total} testId="sheet-avg-total" />
        </div>
        <div className="acad-hint">
          {t('academy.journal.counts')
            .replace('{p}', String(foot.present))
            .replace('{a}', String(foot.absent))
            .replace('{l}', String(foot.late))}
        </div>
        <div className="acad-sc-foot-pcts">
          {PCT_FIELDS.map((f) => (
            <span key={f}>
              {t(PCT_LABEL[f])}: <b>{pct(foot[f])}</b>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Был / Нет / Опоздал — как три клетки на бумажном листе. Выбор держится
 * локально до ответа: новые данные журнала приходят со следующим тиком.
 */
function AttSegment({
  value,
  disabled,
  testId,
  onChange,
  wide,
}: {
  value: Attendance | null;
  disabled: boolean;
  testId: string;
  onChange: (a: Attendance) => void;
  wide?: boolean;
}) {
  const { t } = useT();
  const [local, setLocal] = useState<Attendance | null | undefined>(undefined);
  useEffect(() => setLocal(undefined), [value]);
  const v = local !== undefined ? local : value;
  return (
    <div className={`acad-att${wide ? ' is-wide' : ''}`} role="radiogroup" data-testid={testId} data-value={v ?? ''}>
      {ATTENDANCE.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={v === a}
          disabled={disabled}
          className={`acad-att-btn is-${a.toLowerCase()}${v === a ? ' is-active' : ''}`}
          data-testid={`${testId}-${a}`}
          onClick={() => {
            if (v === a) return;
            setLocal(a);
            onChange(a);
          }}
        >
          {t(`academy.att.${a}`)}
        </button>
      ))}
    </div>
  );
}

/** Процент 0–100: сохраняется по уходу из поля или Enter; Esc — отменить. */
function PctInput({
  value,
  disabled,
  title,
  testId,
  row,
  col,
  onSave,
  onEnter,
}: {
  value: number | null;
  disabled?: boolean;
  title?: string;
  testId?: string;
  row: number;
  col: number;
  onSave: (v: number | null) => void;
  onEnter?: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  const commit = () => {
    const trimmed = text.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isInteger(next) || next < 0 || next > PCT_MAX)) {
      toast(t('academy.journal.range').replace('{max}', String(PCT_MAX)), 'error');
      setText(value === null ? '' : String(value));
      return;
    }
    if (next !== value) onSave(next);
  };
  return (
    <span className={`acad-pct${disabled ? ' is-disabled' : ''}`} title={title}>
      <input
        className="acad-pct-input"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        placeholder="—"
        data-testid={testId}
        data-row={row}
        data-col={col}
        aria-label={testId}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
        onBlur={commit}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (onEnter) {
              commit();
              onEnter();
            } else (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setText(value === null ? '' : String(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="acad-pct-sign">%</span>
    </span>
  );
}

/** Итоги учеников по всем урокам группы: посещение и средние по столбцам листа. */
function SummaryCard({ students }: { students: JournalStudent[] }) {
  const { t } = useT();
  const sort = useTableSort(
    students,
    [
      { key: 'fullName', label: t('common.fullName'), value: (s) => s.fullName },
      { key: 'level', label: t('academy.col.level'), value: (s) => s.level?.name },
      { key: 'att', label: t('academy.col.attendance'), type: 'number', value: (s) => s.summary.attendancePct },
      { key: 'late', label: t('academy.col.late'), type: 'number', value: (s) => s.summary.late },
      { key: 'hw', label: t('academy.journal.col.homework'), type: 'number', value: (s) => s.summary.homeworkAvg },
      { key: 'vocab', label: t('academy.journal.col.vocabulary'), type: 'number', value: (s) => s.summary.vocabularyAvg },
      { key: 'perf', label: t('academy.journal.col.performance'), type: 'number', value: (s) => s.summary.performanceAvg },
      { key: 'avg', label: t('academy.col.avg'), type: 'number', value: (s) => s.summary.avg },
    ],
    { param: 'jsort' },
  );
  if (!students.length) return null;
  return (
    <div className="card acad-card-pad acad-summary-card" data-testid="journal-summary">
      <h3 className="acad-section-title">{t('academy.journal.summary')}</h3>
      <div className="table-wrap">
        <SortSelect sort={sort} />
        <table className="table acad-summary-table">
          <thead>
            <tr>{sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}</tr>
          </thead>
          <tbody>
            {sort.sorted.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'is-left'} data-testid={`jsum-${s.id}`}>
                <td>
                  <strong>{s.fullName}</strong>
                  {!s.active && <span className="acad-jt-left">{t(leftKey(s.leftReason))}</span>}
                </td>
                <td data-label={t('academy.col.level')}><LevelBadge level={s.level} /></td>
                <td data-label={t('academy.col.attendance')}>
                  {pct(s.summary.attendancePct)}
                  {s.summary.held > 0 && <small className="acad-muted"> · {s.summary.attended}/{s.summary.held}</small>}
                </td>
                <td data-label={t('academy.col.late')}>{s.summary.late}</td>
                <td data-label={t('academy.journal.col.homework')}>{pct(s.summary.homeworkAvg)}</td>
                <td data-label={t('academy.journal.col.vocabulary')}>{pct(s.summary.vocabularyAvg)}</td>
                <td data-label={t('academy.journal.col.performance')}>{pct(s.summary.performanceAvg)}</td>
                <td data-label={t('academy.col.avg')}><TotalBadge total={s.summary.avg} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CommentModal({
  title,
  initial,
  readOnly,
  onClose,
  onSave,
}: {
  title: string;
  initial: string;
  readOnly: boolean;
  onClose: () => void;
  onSave: (text: string) => void;
}) {
  const { t } = useT();
  const [text, setText] = useState(initial);
  return (
    <FormModal open title={`${t('academy.journal.comment')} — ${title}`} onClose={onClose} width={520} testId="comment-modal">
      <div className="form-group">
        <textarea
          className="crm-textarea"
          rows={4}
          maxLength={500}
          value={text}
          readOnly={readOnly}
          autoFocus={!readOnly}
          placeholder={t('academy.journal.commentPh')}
          onChange={(e) => setText(e.target.value)}
          data-testid="comment-text"
        />
        <div className="acad-hint">{text.length}/500</div>
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {readOnly ? t('common.close') : t('common.cancel')}
        </button>
        {!readOnly && (
          <button type="button" className="btn btn-primary" data-testid="comment-save" onClick={() => onSave(text)}>
            {t('common.save')}
          </button>
        )}
      </div>
    </FormModal>
  );
}
