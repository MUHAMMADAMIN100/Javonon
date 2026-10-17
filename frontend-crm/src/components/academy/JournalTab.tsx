import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import Icon from '../../Icon';
import CrmSelect from '../CrmSelect';
import FormModal from '../FormModal';
import Loading from '../Loading';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { tjFormatTime, tjToday } from '../../lib/tjTime';
import { useMediaQuery } from '../../lib/useMediaQuery';
import {
  BONUS_MAX,
  EXAM_MAX,
  getJournal,
  saveEntries,
  saveWeeks,
  type EntryPatch,
  type Journal,
  type JournalLesson,
  type JournalRow,
  type JournalWeek,
  type WeekPatch,
} from '../../api/academy';
import ScoreChart, { type ChartSeries } from './ScoreChart';
import { Avatar, FlagDots, TotalBadge, shortDate, tjWeekdayOf, weekRange, weekdayKey } from './academyUi';

/**
 * Журнал группы — как журнал с образца заказчика: сверху график итогов
 * недель, ниже недели (свежие сверху) раскрываются таблицей «ученик ×
 * урок»: посещение, оценка 1–5, комментарий; в конце недели бонус, экзамен
 * и итог из 100. На телефоне неделя открывается по одному уроку — так
 * учителю удобно отмечать прямо на занятии.
 *
 * Итоги считает сервер (academy/journal-math.ts): после сохранения журнал
 * перечитывается, а сама отметка меняется на экране сразу.
 */

const SCORES = [1, 2, 3, 4, 5];

function applyEntries(j: Journal, sessionId: string, items: EntryPatch[]): Journal {
  return {
    ...j,
    weeks: j.weeks.map((w) =>
      w.lessons.some((l) => l.id === sessionId)
        ? {
            ...w,
            rows: w.rows.map((r) => {
              const item = items.find((i) => i.studentId === r.studentId);
              if (!item) return r;
              const prev = r.entries[sessionId] ?? { present: null, score: null, comment: null };
              const next = { ...prev };
              if (item.present !== undefined) next.present = item.present;
              if (item.score !== undefined) next.score = item.score;
              if (item.comment !== undefined) next.comment = item.comment || null;
              if (item.present === false) next.score = null;
              else if (next.score !== null) next.present = true;
              return { ...r, entries: { ...r.entries, [sessionId]: next } };
            }),
          }
        : w,
    ),
  };
}

function applyWeeks(j: Journal, weekKey: string, items: WeekPatch[]): Journal {
  return {
    ...j,
    weeks: j.weeks.map((w) =>
      w.key === weekKey
        ? {
            ...w,
            rows: w.rows.map((r) => {
              const item = items.find((i) => i.studentId === r.studentId);
              if (!item) return r;
              return {
                ...r,
                bonus: item.bonus !== undefined ? item.bonus : r.bonus,
                exam: item.exam !== undefined ? item.exam : r.exam,
              };
            }),
          }
        : w,
    ),
  };
}

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
  const jKey = keys.academy.journal(groupId);
  const narrow = useMediaQuery('(max-width: 760px)');

  const query = useQuery({ queryKey: jKey, queryFn: () => getJournal(groupId) });
  const j = query.data;

  const [open, setOpen] = useState<Set<string> | null>(null);
  const [commentFor, setCommentFor] = useState<{ lesson: JournalLesson; studentId: string } | null>(null);

  // Открыта по умолчанию текущая неделя, иначе последняя начавшаяся.
  useEffect(() => {
    if (!j || open !== null) return;
    const started = j.weeks.filter((w) => w.key <= j.currentWeek);
    const def = j.weeks.find((w) => w.key === j.currentWeek) ?? started[started.length - 1] ?? j.weeks[0];
    setOpen(new Set(def ? [def.key] : []));
  }, [j, open]);

  // Отметка меняется на экране СРАЗУ, в том же обработчике клика: если ждать
  // отмены запросов (await), управляемая галочка на миг возвращается назад.
  // Ошибка сервера откатывает к снимку, после ответа журнал перечитывается
  // (итоги недели считает сервер).
  const entryMut = useMutation({
    mutationFn: (v: { sessionId: string; items: EntryPatch[]; prev?: Journal }) => saveEntries(v.sessionId, v.items),
    onError: (e: any, v) => {
      if (v.prev) qc.setQueryData(jKey, v.prev);
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: jKey });
      qc.invalidateQueries({ queryKey: keys.academy.all });
    },
  });

  const weekMut = useMutation({
    mutationFn: (v: { weekKey: string; items: WeekPatch[]; prev?: Journal }) => saveWeeks(groupId, v.weekKey, v.items),
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

  // График: окончательные итоги недель (с экзаменом) до текущей недели.
  const chart = useMemo(() => {
    if (!j) return { series: [] as ChartSeries[], weeks: [] as Array<{ x: number; label: string }> };
    const started = j.weeks.filter((w) => w.key <= j.currentWeek);
    const series: ChartSeries[] = j.students
      .filter((s) => s.active || s.summary.finalWeeks > 0)
      .map((s) => ({
        id: s.id,
        name: s.fullName,
        points: started.flatMap((w) => {
          const r = w.rows.find((x) => x.studentId === s.id);
          return r && r.final ? [{ x: w.index, y: r.total }] : [];
        }),
        avg: s.summary.avg,
      }));
    return { series, weeks: started.map((w) => ({ x: w.index, label: `${t('academy.week')} ${w.index}` })) };
  }, [j, t]);

  if (query.isLoading || !j) return <Loading />;
  if (query.isError) return <div className="acad-empty">{t('toast.error')}</div>;

  if (j.weeks.length === 0) {
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

  const canEditLesson = (l: JournalLesson) => j.canEditAll || (!!meId && l.teacherId === meId);
  const weeksDesc = [...j.weeks].reverse();
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const markEntry = (lesson: JournalLesson, items: EntryPatch[]) => {
    const prev = qc.getQueryData<Journal>(jKey);
    void qc.cancelQueries({ queryKey: jKey });
    if (prev) qc.setQueryData(jKey, applyEntries(prev, lesson.id, items));
    entryMut.mutate({ sessionId: lesson.id, items, prev });
  };
  const markWeek = (week: JournalWeek, items: WeekPatch[]) => {
    const prev = qc.getQueryData<Journal>(jKey);
    void qc.cancelQueries({ queryKey: jKey });
    if (prev) qc.setQueryData(jKey, applyWeeks(prev, week.key, items));
    weekMut.mutate({ weekKey: week.key, items, prev });
  };

  const activeCount = j.students.filter((s) => s.active).length;
  const avgs = j.students.filter((s) => s.active && s.summary.avg !== null).map((s) => s.summary.avg as number);
  const att = j.students.filter((s) => s.active && s.summary.attendancePct !== null).map((s) => s.summary.attendancePct as number);
  const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

  const commentRow = commentFor
    ? j.weeks.flatMap((w) => w.rows).find((r) => r.studentId === commentFor.studentId && commentFor.lesson.id in r.entries)
    : null;

  return (
    <div className="acad-journal" data-testid="journal">
      <div className="acad-journal-stats">
        <div><span>{t('academy.stats.students')}</span><b>{activeCount}</b></div>
        <div><span>{t('academy.stats.groupAvg')}</span><b data-testid="journal-group-avg">{mean(avgs) ?? '—'}</b></div>
        <div><span>{t('academy.stats.attendance')}</span><b>{mean(att) !== null ? `${mean(att)}%` : '—'}</b></div>
        <div><span>{t('academy.stats.weeks')}</span><b>{j.weeks.filter((w) => w.key <= j.currentWeek).length}</b></div>
      </div>

      <div className="card acad-chart-card">
        <ScoreChart series={chart.series} weeks={chart.weeks} height={narrow ? 220 : 280} testId="journal-chart" />
      </div>

      <div className="acad-weeks">
        {weeksDesc.map((w) => {
          const isOpen = !!open?.has(w.key);
          const isCurrent = w.key === j.currentWeek;
          return (
            <div key={w.key} className={`card acad-week${isOpen ? ' is-open' : ''}`} data-testid={`week-${w.index}`}>
              <button type="button" className="acad-week-head" onClick={() => toggle(w.key)} aria-expanded={isOpen}>
                <span className="acad-week-title">
                  {t('academy.week')} {w.index}
                  <Icon name={isOpen ? 'expand_less' : 'expand_more'} size={22} />
                </span>
                <span className="acad-week-range">{weekRange(w.from, w.to)}</span>
                {isCurrent && <span className="acad-week-now">{t('academy.week.current')}</span>}
                <span className="acad-week-meta">
                  {t('academy.week.lessons')}: {w.lessons.length}
                </span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ overflow: 'hidden' }}
                  >
                    {narrow ? (
                      <WeekPhone
                        week={w}
                        students={students}
                        canEditLesson={canEditLesson}
                        canEditWeek={j.canEditAll}
                        onMark={markEntry}
                        onWeek={(items) => markWeek(w, items)}
                        onComment={(lesson, studentId) => setCommentFor({ lesson, studentId })}
                      />
                    ) : (
                      <WeekTable
                        week={w}
                        students={students}
                        canEditLesson={canEditLesson}
                        canEditWeek={j.canEditAll}
                        onMark={markEntry}
                        onWeek={(items) => markWeek(w, items)}
                        onComment={(lesson, studentId) => setCommentFor({ lesson, studentId })}
                      />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <AnimatePresence>
        {commentFor && (
          <CommentModal
            title={`${students.get(commentFor.studentId)?.fullName ?? ''} · ${shortDate(commentFor.lesson.startsAt)}`}
            initial={commentRow?.entries[commentFor.lesson.id]?.comment ?? ''}
            readOnly={!canEditLesson(commentFor.lesson) || !commentFor.lesson.past}
            onClose={() => setCommentFor(null)}
            onSave={(text) => {
              markEntry(commentFor.lesson, [{ studentId: commentFor.studentId, comment: text.trim() || null }]);
              setCommentFor(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

type WeekProps = {
  week: JournalWeek;
  students: Map<string, Journal['students'][number]>;
  canEditLesson: (l: JournalLesson) => boolean;
  canEditWeek: boolean;
  onMark: (lesson: JournalLesson, items: EntryPatch[]) => void;
  onWeek: (items: WeekPatch[]) => void;
  onComment: (lesson: JournalLesson, studentId: string) => void;
};

function rowName(students: WeekProps['students'], r: JournalRow) {
  return students.get(r.studentId)?.fullName ?? '—';
}

/** Ученики недели по алфавиту; вышедшие — в конце. */
function sortedRows(week: JournalWeek, students: WeekProps['students']) {
  return [...week.rows].sort((a, b) => {
    const sa = students.get(a.studentId);
    const sb = students.get(b.studentId);
    return Number(!!sb?.active) - Number(!!sa?.active) || (sa?.fullName ?? '').localeCompare(sb?.fullName ?? '', 'ru');
  });
}

/** Неделя таблицей (компьютер, планшет). */
function WeekTable({ week, students, canEditLesson, canEditWeek, onMark, onWeek, onComment }: WeekProps) {
  const { t } = useT();
  const rows = sortedRows(week, students);
  return (
    <div className="acad-jt-wrap">
      <table className="acad-jt" data-testid={`week-table-${week.index}`}>
        <thead>
          <tr>
            <th rowSpan={2} className="acad-jt-name">{t('academy.journal.students')}</th>
            {week.lessons.map((l) => {
              const editable = canEditLesson(l) && l.past;
              const unmarked = rows.filter((r) => students.get(r.studentId)?.active && r.entries[l.id]?.present == null);
              return (
                <th key={l.id} colSpan={2} className="acad-jt-lesson" title={l.topic || undefined}>
                  <div className="acad-jt-date">
                    {shortDate(l.startsAt)} <span>{t(`weekday.short.${weekdayKey(tjWeekdayOf(l.startsAt))}`)}</span>
                  </div>
                  <div className="acad-jt-time">{tjFormatTime(l.startsAt)}</div>
                  {editable && unmarked.length > 0 && (
                    <button
                      type="button"
                      className="acad-jt-allbtn"
                      data-testid={`mark-all-${l.id}`}
                      title={t('academy.journal.markAllHint')}
                      onClick={() => onMark(l, unmarked.map((r) => ({ studentId: r.studentId, present: true })))}
                    >
                      <Icon name="done_all" size={14} /> {t('academy.journal.markAll')}
                    </button>
                  )}
                </th>
              );
            })}
            <th colSpan={3} className="acad-jt-end">{t('academy.journal.endOfWeek')}</th>
          </tr>
          <tr className="acad-jt-sub">
            {week.lessons.map((l) => (
              <Fragment key={l.id}>
                <th>{t('academy.journal.att')}</th>
                <th>{t('academy.journal.score')}</th>
              </Fragment>
            ))}
            <th>{t('academy.journal.bonus')}</th>
            <th>{t('academy.journal.exam')}</th>
            <th>{t('academy.journal.total')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const st = students.get(r.studentId);
            return (
              <tr key={r.studentId} className={st?.active ? '' : 'is-left'} data-testid={`jrow-${r.studentId}`}>
                <td className="acad-jt-name">
                  <span className="acad-jt-num">{i + 1}.</span>
                  <span className="acad-jt-student">{rowName(students, r)}</span>
                  {st && st.flags > 0 && <FlagDots count={st.flags} />}
                  {st && !st.active && (
                    <span className="acad-jt-left">{t(st.expelled ? 'academy.left.expelled' : 'academy.left.removed')}</span>
                  )}
                </td>
                {week.lessons.map((l) => {
                  const cell = r.entries[l.id];
                  const editable = canEditLesson(l) && l.past;
                  return (
                    <Fragment key={l.id}>
                      <td className="acad-jt-att">
                        <button
                          type="button"
                          className={`acad-comment-btn${cell?.comment ? ' has-comment' : ''}`}
                          title={cell?.comment || t('academy.journal.comment')}
                          disabled={!l.past || (!editable && !cell?.comment)}
                          data-testid={`comment-${l.id}-${r.studentId}`}
                          onClick={() => onComment(l, r.studentId)}
                        >
                          <Icon name={cell?.comment ? 'chat' : 'chat_bubble'} size={16} />
                        </button>
                        <AttCheck
                          value={cell?.present ?? null}
                          disabled={!editable}
                          title={!l.past ? t('academy.journal.future') : undefined}
                          testId={`att-${l.id}-${r.studentId}`}
                          onChange={(present) => onMark(l, [{ studentId: r.studentId, present }])}
                        />
                      </td>
                      <td className="acad-jt-score">
                        <CrmSelect
                          className="crm-select acad-score-select"
                          value={cell?.score ? String(cell.score) : ''}
                          disabled={!editable}
                          data-testid={`score-${l.id}-${r.studentId}`}
                          onChange={(e) =>
                            onMark(l, [{ studentId: r.studentId, score: e.target.value ? Number(e.target.value) : null }])
                          }
                        >
                          <option value="">—</option>
                          {SCORES.map((s) => (
                            <option key={s} value={String(s)}>{s}</option>
                          ))}
                        </CrmSelect>
                      </td>
                    </Fragment>
                  );
                })}
                <td className="acad-jt-num-cell">
                  <NumberCell
                    value={r.bonus}
                    max={BONUS_MAX}
                    disabled={!canEditWeek}
                    testId={`bonus-${week.key}-${r.studentId}`}
                    onSave={(v) => onWeek([{ studentId: r.studentId, bonus: v }])}
                  />
                </td>
                <td className="acad-jt-num-cell">
                  <NumberCell
                    value={r.exam}
                    max={EXAM_MAX}
                    disabled={!canEditWeek}
                    testId={`exam-${week.key}-${r.studentId}`}
                    onSave={(v) => onWeek([{ studentId: r.studentId, exam: v }])}
                  />
                </td>
                <td className="acad-jt-total">
                  <TotalBadge total={r.total} final={r.final} testId={`total-${week.key}-${r.studentId}`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="acad-jt-legend">
        {t('academy.journal.formula')}
      </div>
    </div>
  );
}

/**
 * Галочка «был» со своим мгновенным состоянием: новые данные журнала
 * приходят в таблицу со следующим тиком, и без него управляемая галочка
 * на миг возвращалась бы назад после клика.
 */
function AttCheck({
  value,
  disabled,
  title,
  testId,
  onChange,
}: {
  value: boolean | null;
  disabled: boolean;
  title?: string;
  testId: string;
  onChange: (present: boolean) => void;
}) {
  const [local, setLocal] = useState<boolean | null | undefined>(undefined);
  useEffect(() => setLocal(undefined), [value]);
  const v = local !== undefined ? local : value;
  return (
    <label className={`acad-check${v ? ' is-on' : ''}${v === false ? ' is-off' : ''}${disabled ? ' is-disabled' : ''}`} title={title}>
      <input
        type="checkbox"
        checked={!!v}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => {
          setLocal(e.target.checked);
          onChange(e.target.checked);
        }}
      />
      <Icon name="check" size={14} />
    </label>
  );
}

/** Число в ячейке (бонус/экзамен): сохраняется по уходу из поля или Enter. */
function NumberCell({
  value,
  max,
  disabled,
  onSave,
  testId,
}: {
  value: number | null;
  max: number;
  disabled?: boolean;
  onSave: (v: number | null) => void;
  testId?: string;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  const commit = () => {
    const trimmed = text.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isInteger(next) || next < 0 || next > max)) {
      toast(t('academy.journal.range').replace('{max}', String(max)), 'error');
      setText(value === null ? '' : String(value));
      return;
    }
    if (next !== value) onSave(next);
  };
  return (
    <input
      className="crm-input acad-num-input"
      inputMode="numeric"
      value={text}
      disabled={disabled}
      placeholder="—"
      data-testid={testId}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(value === null ? '' : String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Неделя на телефоне: выбор урока → список учеников с отметками; ниже — итоги недели. */
function WeekPhone({ week, students, canEditLesson, canEditWeek, onMark, onWeek, onComment }: WeekProps) {
  const { t } = useT();
  const today = tjToday();
  const defaultLesson = () => {
    const todays = week.lessons.find((l) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dushanbe' }).format(new Date(l.startsAt)) === today);
    const past = week.lessons.filter((l) => l.past);
    return (todays ?? past[past.length - 1] ?? week.lessons[0])?.id;
  };
  const [lessonId, setLessonId] = useState<string | undefined>(defaultLesson);
  const [showTotals, setShowTotals] = useState(false);
  const lesson = week.lessons.find((l) => l.id === lessonId) ?? week.lessons[0];
  const rows = sortedRows(week, students);
  const editable = !!lesson && canEditLesson(lesson) && lesson.past;

  return (
    <div className="acad-jp" data-testid={`week-phone-${week.index}`}>
      <div className="acad-jp-lessons">
        {week.lessons.map((l) => (
          <button
            key={l.id}
            type="button"
            className={`acad-jp-lesson${l.id === lesson?.id ? ' is-active' : ''}${l.past ? '' : ' is-future'}`}
            onClick={() => setLessonId(l.id)}
          >
            <b>{t(`weekday.short.${weekdayKey(tjWeekdayOf(l.startsAt))}`)}</b>
            <span>{shortDate(l.startsAt)}</span>
          </button>
        ))}
      </div>
      {lesson && (
        <>
          <div className="acad-jp-head">
            <span>{lesson.topic || t('classes.noTopic')}</span>
            {!lesson.past && <span className="acad-jp-future">{t('academy.journal.future')}</span>}
          </div>
          <div className="acad-jp-list">
            {rows.map((r, i) => {
              const cell = r.entries[lesson.id];
              const st = students.get(r.studentId);
              return (
                <div key={r.studentId} className={`acad-jp-row${st?.active ? '' : ' is-left'}`} data-testid={`jp-row-${r.studentId}`}>
                  <div className="acad-jp-name">
                    <span>{i + 1}. {rowName(students, r)}</span>
                    <button
                      type="button"
                      className={`acad-comment-btn${cell?.comment ? ' has-comment' : ''}`}
                      disabled={!lesson.past || (!editable && !cell?.comment)}
                      onClick={() => onComment(lesson, r.studentId)}
                      aria-label={t('academy.journal.comment')}
                    >
                      <Icon name={cell?.comment ? 'chat' : 'chat_bubble'} size={18} />
                    </button>
                  </div>
                  <div className="acad-jp-controls">
                    <div className="acad-jp-att">
                      <button
                        type="button"
                        disabled={!editable}
                        className={`acad-jp-attbtn is-yes${cell?.present === true ? ' is-active' : ''}`}
                        data-testid={`jp-yes-${r.studentId}`}
                        onClick={() => onMark(lesson, [{ studentId: r.studentId, present: true }])}
                      >
                        <Icon name="check" size={16} /> {t('academy.journal.present')}
                      </button>
                      <button
                        type="button"
                        disabled={!editable}
                        className={`acad-jp-attbtn is-no${cell?.present === false ? ' is-active' : ''}`}
                        data-testid={`jp-no-${r.studentId}`}
                        onClick={() => onMark(lesson, [{ studentId: r.studentId, present: false }])}
                      >
                        <Icon name="close" size={16} /> {t('academy.journal.absent')}
                      </button>
                    </div>
                    <div className="acad-jp-scores">
                      {SCORES.map((s) => (
                        <button
                          key={s}
                          type="button"
                          disabled={!editable}
                          className={`acad-jp-score${cell?.score === s ? ' is-active' : ''}`}
                          data-testid={`jp-score-${s}-${r.studentId}`}
                          onClick={() =>
                            onMark(lesson, [{ studentId: r.studentId, score: cell?.score === s ? null : s }])
                          }
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <button type="button" className="acad-jp-totals-toggle" onClick={() => setShowTotals((v) => !v)}>
        {t('academy.journal.endOfWeek')}
        <Icon name={showTotals ? 'expand_less' : 'expand_more'} size={20} />
      </button>
      {showTotals && (
        <div className="acad-jp-totals">
          {rows.map((r) => (
            <div key={r.studentId} className="acad-jp-total-row">
              <span className="acad-jp-total-name">{rowName(students, r)}</span>
              <label>
                {t('academy.journal.bonus')}
                <NumberCell value={r.bonus} max={BONUS_MAX} disabled={!canEditWeek} onSave={(v) => onWeek([{ studentId: r.studentId, bonus: v }])} />
              </label>
              <label>
                {t('academy.journal.exam')}
                <NumberCell value={r.exam} max={EXAM_MAX} disabled={!canEditWeek} onSave={(v) => onWeek([{ studentId: r.studentId, exam: v }])} />
              </label>
              <TotalBadge total={r.total} final={r.final} />
            </div>
          ))}
          <div className="acad-jt-legend">{t('academy.journal.formula')}</div>
        </div>
      )}
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
