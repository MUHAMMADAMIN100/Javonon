import { tjLocalDay, tjWeekday } from '../common/tj-time';

/**
 * Журнал академии: уроки, отметки, «Итого» урока и сводки ученика. Чистые
 * функции — одна формула для журнала группы, карточки ученика, списка
 * учеников и кабинета студента, чтобы цифры нигде не разошлись.
 *
 * Журнал — как бумажный лист заказчика: за урок у ученика
 *   Attendance        — был / не был / опоздал;
 *   Homework          — 0–100 %;
 *   Vocabulary        — 0–100 %;
 *   Class Performance — 0–100 %;
 *   Итого             — среднее заполненных процентов (80, 90, 70 → 80).
 * «Не был» — итог урока 0 %: пропуск снижает успеваемость. «Опоздал» —
 * присутствие. Отметки без процентов (только посещение) в средний не идут.
 *
 * Успеваемость ученика — средний «Итого» его уроков; посещаемость — доля
 * «был» и «опоздал» среди отмеченных уроков.
 */
export const PCT_MAX = 100;

export type Attendance = 'PRESENT' | 'ABSENT' | 'LATE';

/** Понедельник недели (Душанбе) для момента — 'YYYY-MM-DD'. */
export function weekKeyOf(d: Date): string {
  const offset = (tjWeekday(d) + 6) % 7; // дней с понедельника
  return addDaysToKey(tjLocalDay(d), -offset);
}

/** Сдвиг календарного дня 'YYYY-MM-DD' на N дней (без часовых поясов). */
export function addDaysToKey(key: string, days: number): string {
  const t = new Date(`${key}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** Сколько календарных дней от a до b ('YYYY-MM-DD'). */
export function daysBetweenKeys(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

export interface JSession {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  topic: string | null;
  teacherId: string | null;
  homework?: string | null;
}
export interface JMember {
  studentId: string;
  joinedAt: Date;
  leftAt: Date | null;
}
export interface JEntry {
  sessionId: string;
  studentId: string;
  /** Старые отметки (до листа с процентами) — только «был / не был». */
  present: boolean | null;
  attendance: Attendance | null;
  homeworkPct: number | null;
  vocabularyPct: number | null;
  performancePct: number | null;
  comment: string | null;
}

export interface LessonMark {
  attendance: Attendance | null;
  homeworkPct: number | null;
  vocabularyPct: number | null;
  performancePct: number | null;
  comment: string | null;
  /** Итого урока; null — процентов ещё нет. */
  total: number | null;
}

/** Посещение с учётом старых отметок: attendance, иначе present. */
export function attendanceOf(e: { attendance: Attendance | null; present: boolean | null }): Attendance | null {
  if (e.attendance) return e.attendance;
  if (e.present === true) return 'PRESENT';
  if (e.present === false) return 'ABSENT';
  return null;
}

/** Итого урока: «не был» — 0; иначе среднее заполненных процентов. */
export function lessonTotal(m: {
  attendance: Attendance | null;
  homeworkPct: number | null;
  vocabularyPct: number | null;
  performancePct: number | null;
}): number | null {
  if (m.attendance === 'ABSENT') return 0;
  const pcts = [m.homeworkPct, m.vocabularyPct, m.performancePct].filter((v): v is number => v !== null);
  if (!pcts.length) return null;
  return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
}

export function markOf(e: JEntry): LessonMark {
  const attendance = attendanceOf(e);
  const absent = attendance === 'ABSENT';
  const base = {
    attendance,
    // У «не был» процентов нет — даже если в старой строке что-то осталось.
    homeworkPct: absent ? null : e.homeworkPct,
    vocabularyPct: absent ? null : e.vocabularyPct,
    performancePct: absent ? null : e.performancePct,
  };
  return { ...base, comment: e.comment, total: lessonTotal(base) };
}

const isEmptyMark = (m: LessonMark) =>
  m.attendance === null && m.homeworkPct === null && m.vocabularyPct === null && m.performancePct === null && !m.comment;

export interface JournalLesson {
  id: string;
  /** Номер урока в журнале группы (отменённые не считаются), с 1. */
  number: number;
  startsAt: Date;
  endsAt: Date;
  status: string;
  topic: string | null;
  teacherId: string | null;
  /** Календарный день урока по Душанбе. */
  day: string;
  weekKey: string;
  /** Урок уже начался. */
  past: boolean;
  /** Отмечать можно с дня урока (как на сервере). */
  markable: boolean;
  hasHomework: boolean;
}

export interface JournalWeekRef {
  key: string;
  index: number;
  from: string;
  to: string;
}

export interface GroupJournal {
  lessons: JournalLesson[];
  weeks: JournalWeekRef[];
  /** lessonId → studentId → отметка (только непустые). */
  marks: Map<string, Map<string, LessonMark>>;
  /** lessonId → ученики листа урока. */
  sheet: Map<string, string[]>;
}

/**
 * Журнал группы. Уроки — неотменённые, по времени. На листе урока —
 * действующие ученики (учитель может заполнить и прошлые уроки за ученика,
 * которого добавили позже), вышедшие — на уроках до своего выхода, и все,
 * у кого по уроку есть отметка.
 */
export function buildGroupJournal(input: {
  sessions: JSession[];
  members: JMember[];
  entries: JEntry[];
  now?: Date;
}): GroupJournal {
  const now = input.now ?? new Date();
  const today = tjLocalDay(now);
  const live = input.sessions
    .filter((s) => s.status !== 'CANCELLED')
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const lessons: JournalLesson[] = live.map((s, i) => {
    const day = tjLocalDay(s.startsAt);
    return {
      id: s.id,
      number: i + 1,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      status: s.status,
      topic: s.topic,
      teacherId: s.teacherId,
      day,
      weekKey: weekKeyOf(s.startsAt),
      past: s.startsAt.getTime() <= now.getTime(),
      markable: day <= today,
      hasHomework: !!s.homework,
    };
  });

  const weekKeys = Array.from(new Set(lessons.map((l) => l.weekKey))).sort();
  const weeks = weekKeys.map((key, i) => ({ key, index: i + 1, from: key, to: addDaysToKey(key, 6) }));

  const liveIds = new Set(lessons.map((l) => l.id));
  const marks = new Map<string, Map<string, LessonMark>>();
  for (const e of input.entries) {
    if (!liveIds.has(e.sessionId)) continue;
    const m = markOf(e);
    if (isEmptyMark(m)) continue;
    let byStudent = marks.get(e.sessionId);
    if (!byStudent) marks.set(e.sessionId, (byStudent = new Map()));
    byStudent.set(e.studentId, m);
  }

  const sheet = new Map<string, string[]>();
  for (const l of lessons) {
    const marked = marks.get(l.id);
    const ids: string[] = [];
    for (const m of input.members) {
      const onSheet = !m.leftAt || l.startsAt.getTime() <= m.leftAt.getTime() || !!marked?.has(m.studentId);
      if (onSheet) ids.push(m.studentId);
    }
    sheet.set(l.id, ids);
  }

  return { lessons, weeks, marks, sheet };
}

/** Уроки одного ученика с его отметками (уроки, где он на листе). */
export function studentLessons(j: GroupJournal, studentId: string): Array<{ lesson: JournalLesson; mark: LessonMark | null }> {
  const out: Array<{ lesson: JournalLesson; mark: LessonMark | null }> = [];
  for (const l of j.lessons) {
    if (!j.sheet.get(l.id)?.includes(studentId)) continue;
    out.push({ lesson: l, mark: j.marks.get(l.id)?.get(studentId) ?? null });
  }
  return out;
}

export interface StudentSummary {
  /** Средний «Итого» уроков (целое); null — итогов ещё нет. */
  avg: number | null;
  /** Посещаемость, % «был» и «опоздал» среди отмеченных уроков. */
  attendancePct: number | null;
  /** Отмеченных уроков. */
  held: number;
  /** Был + опоздал. */
  attended: number;
  late: number;
  absent: number;
  /** Уроков с итогом (вошли в средний). */
  graded: number;
  homeworkAvg: number | null;
  vocabularyAvg: number | null;
  performanceAvg: number | null;
}

const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

export function summarize(marks: Array<LessonMark | null>): StudentSummary {
  let held = 0;
  let attended = 0;
  let late = 0;
  let absent = 0;
  const totals: number[] = [];
  const hw: number[] = [];
  const vocab: number[] = [];
  const perf: number[] = [];
  for (const m of marks) {
    if (!m) continue;
    if (m.attendance) {
      held++;
      if (m.attendance === 'ABSENT') absent++;
      else attended++;
      if (m.attendance === 'LATE') late++;
    }
    if (m.total !== null) totals.push(m.total);
    if (m.homeworkPct !== null) hw.push(m.homeworkPct);
    if (m.vocabularyPct !== null) vocab.push(m.vocabularyPct);
    if (m.performancePct !== null) perf.push(m.performancePct);
  }
  return {
    avg: mean(totals),
    attendancePct: held > 0 ? Math.round((attended / held) * 100) : null,
    held,
    attended,
    late,
    absent,
    graded: totals.length,
    homeworkAvg: mean(hw),
    vocabularyAvg: mean(vocab),
    performanceAvg: mean(perf),
  };
}

/** Средний «Итого» ученика по неделям — точки графика (недели без итогов пропускаются). */
export function weekAverages(j: GroupJournal, studentId: string): Map<string, number> {
  const byWeek = new Map<string, number[]>();
  for (const l of j.lessons) {
    const total = j.marks.get(l.id)?.get(studentId)?.total;
    if (total === null || total === undefined) continue;
    const list = byWeek.get(l.weekKey);
    if (list) list.push(total);
    else byWeek.set(l.weekKey, [total]);
  }
  const out = new Map<string, number>();
  for (const [key, list] of byWeek) out.set(key, mean(list)!);
  return out;
}

/** Среднее по группе за неделю — среднее недельных итогов учеников. */
export function groupWeekAverages(j: GroupJournal, studentIds: string[]): Map<string, number> {
  const acc = new Map<string, number[]>();
  for (const id of studentIds) {
    for (const [key, v] of weekAverages(j, id)) {
      const list = acc.get(key);
      if (list) list.push(v);
      else acc.set(key, [v]);
    }
  }
  const out = new Map<string, number>();
  for (const [key, list] of acc) out.set(key, mean(list)!);
  return out;
}

export type AcademyStatus = 'ACTIVE' | 'PENDING' | 'EXPELLED' | 'NO_GROUP';

/**
 * Статус ученика академии:
 *   EXPELLED — отчислен решением руководства;
 *   PENDING  — 4+ действующих флага и среди них есть поставленный после
 *              последнего решения «Оставить» — ждёт решения;
 *   ACTIVE   — состоит хотя бы в одной группе;
 *   NO_GROUP — ни в одной группе сейчас.
 */
export const FLAGS_FOR_DECISION = 4;

export function academyStatusOf(s: {
  academyExpelledAt: Date | null;
  academyFlagsReviewedAt: Date | null;
  activeFlagDates: Date[];
  activeGroups: number;
}): AcademyStatus {
  if (s.academyExpelledAt) return 'EXPELLED';
  if (needsDecision(s)) return 'PENDING';
  return s.activeGroups > 0 ? 'ACTIVE' : 'NO_GROUP';
}

export function needsDecision(s: {
  academyExpelledAt: Date | null;
  academyFlagsReviewedAt: Date | null;
  activeFlagDates: Date[];
}): boolean {
  if (s.academyExpelledAt) return false;
  if (s.activeFlagDates.length < FLAGS_FOR_DECISION) return false;
  const reviewed = s.academyFlagsReviewedAt?.getTime() ?? -Infinity;
  return s.activeFlagDates.some((d) => d.getTime() > reviewed);
}

/**
 * «По каким дням» группа занимается — из ближайших занятий: уникальные
 * пары «день недели + время», по порядку дней. weekday: 1 = Пн … 7 = Вс.
 */
export function weeklyPattern(sessions: Array<{ startsAt: Date; endsAt: Date }>) {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dushanbe', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const seen = new Map<string, { weekday: number; from: string; to: string }>();
  for (const s of sessions) {
    const wdName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dushanbe', weekday: 'short' }).format(s.startsAt);
    const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wdName) + 1;
    const from = fmt(s.startsAt);
    const to = fmt(s.endsAt);
    const key = `${weekday}|${from}|${to}`;
    if (!seen.has(key)) seen.set(key, { weekday, from, to });
  }
  return [...seen.values()].sort((a, b) => a.weekday - b.weekday || a.from.localeCompare(b.from));
}

/**
 * Первый день дневника ДЗ: день урока, а если задание выдали позже (внесли
 * задним числом) — день выдачи.
 */
export function diaryStart(startsAt: Date, homeworkSetAt: Date | null): string {
  const lessonDay = tjLocalDay(startsAt);
  const setDay = homeworkSetAt ? tjLocalDay(homeworkSetAt) : lessonDay;
  return setDay > lessonDay ? setDay : lessonDay;
}

/** Дни дневника ДЗ: с первого дня по срок сдачи включительно. */
export function diaryDays(lessonDay: string, dueDay: string): string[] {
  const n = daysBetweenKeys(lessonDay, dueDay);
  if (n < 0) return [lessonDay];
  return Array.from({ length: n + 1 }, (_, i) => addDaysToKey(lessonDay, i));
}
