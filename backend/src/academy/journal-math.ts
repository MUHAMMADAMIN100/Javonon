import { tjLocalDay, tjWeekday } from '../common/tj-time';

/**
 * Журнал академии: недели, засчитанные уроки и итог недели. Чистые функции —
 * одна формула для журнала группы, карточки ученика, списка учеников и
 * кабинета студента, чтобы цифры нигде не разошлись.
 *
 * Итог недели (как в журнале с образца заказчика):
 *   уроки   — до 30 баллов: за каждый засчитанный урок 1 балл за посещение
 *             и оценка 1–5; сумма пересчитывается к 30, поэтому неделя из 3
 *             уроков весит столько же, сколько неделя из 5;
 *   экзамен — 0–70;
 *   бонус   — 0–10;
 *   итог    — min(100, round(уроки + экзамен + бонус)).
 * Пока экзамен не выставлен, итог «не окончательный» (final = false): в
 * журнале он серый, в график и среднее не идёт — иначе середина недели
 * выглядела бы провалом.
 */
export const LESSON_POINTS_MAX = 30;
export const EXAM_MAX = 70;
export const BONUS_MAX = 10;
export const TOTAL_MAX = 100;
export const SCORE_MIN = 1;
export const SCORE_MAX = 5;
/** Максимум за урок: посещение (1) + оценка (до 5). */
const PER_LESSON_MAX = 1 + SCORE_MAX;

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

/** Корректный ли ключ недели: дата 'YYYY-MM-DD', и это понедельник. */
export function isWeekKey(key: unknown): key is string {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const t = new Date(`${key}T00:00:00.000Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === key && t.getUTCDay() === 1;
}

export interface JSession {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  topic: string | null;
  teacherId: string | null;
}
export interface JMember {
  studentId: string;
  joinedAt: Date;
  leftAt: Date | null;
}
export interface JEntry {
  sessionId: string;
  studentId: string;
  present: boolean | null;
  score: number | null;
  comment: string | null;
}
export interface JWeekData {
  studentId: string;
  weekStart: string;
  bonus: number | null;
  exam: number | null;
}

export interface WeekCell {
  present: boolean | null;
  score: number | null;
  comment: string | null;
}

export interface WeekStudentResult {
  studentId: string;
  /** sessionId → отметка. Пустые уроки сюда не попадают. */
  entries: Record<string, WeekCell>;
  bonus: number | null;
  exam: number | null;
  /** Засчитанных уроков (прошли и относятся к ученику). */
  held: number;
  attended: number;
  lessonPoints: number;
  total: number;
  final: boolean;
}

export interface JournalLesson {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  topic: string | null;
  teacherId: string | null;
  /** Урок уже начался — его можно отмечать и он идёт в итог. */
  past: boolean;
}

export interface JournalWeek {
  key: string;
  index: number;
  from: string;
  to: string;
  lessons: JournalLesson[];
  rows: WeekStudentResult[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Недели журнала группы. Неделя есть, если в ней есть хоть одно
 * неотменённое занятие; номер — по порядку таких недель, с 1.
 *
 * Строки недели: действующие ученики группы (во всех неделях — учитель
 * может заполнить и прошлые) и вышедшие — до недели выхода включительно
 * или если у них есть отметки в этой неделе.
 *
 * Урок засчитывается ученику, если он уже начался и либо по нему есть
 * отметка о посещении, либо ученик в этот день состоял в группе.
 * Поэтому позже добавленный ученик не получает нули за уроки до него,
 * а отметки «задним числом» всё равно учитываются.
 */
export function buildJournal(input: {
  sessions: JSession[];
  members: JMember[];
  entries: JEntry[];
  weeks: JWeekData[];
  now?: Date;
}): JournalWeek[] {
  const now = input.now ?? new Date();
  const live = input.sessions
    .filter((s) => s.status !== 'CANCELLED')
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const byWeek = new Map<string, JSession[]>();
  for (const s of live) {
    const key = weekKeyOf(s.startsAt);
    const list = byWeek.get(key);
    if (list) list.push(s);
    else byWeek.set(key, [s]);
  }

  const entryMap = new Map<string, JEntry>();
  for (const e of input.entries) entryMap.set(`${e.sessionId}:${e.studentId}`, e);
  const weekMap = new Map<string, JWeekData>();
  for (const w of input.weeks) weekMap.set(`${w.studentId}:${w.weekStart}`, w);

  const keys = [...byWeek.keys()].sort();
  return keys.map((key, i) => {
    const lessons = byWeek.get(key)!;
    const weekEnd = addDaysToKey(key, 6);
    const rows: WeekStudentResult[] = [];
    for (const m of input.members) {
      const leftDay = m.leftAt ? tjLocalDay(m.leftAt) : null;
      const hasData =
        weekMap.has(`${m.studentId}:${key}`) ||
        lessons.some((l) => entryMap.has(`${l.id}:${m.studentId}`));
      if (leftDay && leftDay < key && !hasData) continue;
      rows.push(scoreWeek(m, lessons, entryMap, weekMap.get(`${m.studentId}:${key}`), now));
    }
    return {
      key,
      index: i + 1,
      from: key,
      to: weekEnd,
      lessons: lessons.map((l) => ({
        id: l.id,
        startsAt: l.startsAt,
        endsAt: l.endsAt,
        status: l.status,
        topic: l.topic,
        teacherId: l.teacherId,
        past: l.startsAt.getTime() <= now.getTime(),
      })),
      rows,
    };
  });
}

function scoreWeek(
  m: JMember,
  lessons: JSession[],
  entryMap: Map<string, JEntry>,
  week: JWeekData | undefined,
  now: Date,
): WeekStudentResult {
  const joinedDay = tjLocalDay(m.joinedAt);
  const entries: Record<string, WeekCell> = {};
  let held = 0;
  let attended = 0;
  let scoreSum = 0;
  for (const l of lessons) {
    const e = entryMap.get(`${l.id}:${m.studentId}`);
    if (e && (e.present !== null || e.score !== null || e.comment)) {
      entries[l.id] = { present: e.present, score: e.score, comment: e.comment };
    }
    if (l.startsAt.getTime() > now.getTime()) continue;
    const marked = !!e && e.present !== null;
    const inGroup =
      tjLocalDay(l.startsAt) >= joinedDay && (!m.leftAt || l.startsAt.getTime() <= m.leftAt.getTime());
    if (!marked && !inGroup) continue;
    held++;
    if (e?.present === true) {
      attended++;
      scoreSum += e.score ?? 0;
    }
  }
  const lessonPoints = held > 0 ? round1(((attended + scoreSum) / (held * PER_LESSON_MAX)) * LESSON_POINTS_MAX) : 0;
  const bonus = week?.bonus ?? null;
  const exam = week?.exam ?? null;
  const total = Math.min(TOTAL_MAX, Math.round(lessonPoints + (exam ?? 0) + (bonus ?? 0)));
  return {
    studentId: m.studentId,
    entries,
    bonus,
    exam,
    held,
    attended,
    lessonPoints,
    total,
    final: exam !== null,
  };
}

export interface StudentSummary {
  /** Среднее окончательных итогов недель (целое), null — таких недель нет. */
  avg: number | null;
  /** Посещаемость, % засчитанных уроков; null — уроков ещё не было. */
  attendancePct: number | null;
  finalWeeks: number;
  held: number;
  attended: number;
}

export function summarize(rows: WeekStudentResult[]): StudentSummary {
  let held = 0;
  let attended = 0;
  const finals: number[] = [];
  for (const r of rows) {
    held += r.held;
    attended += r.attended;
    if (r.final) finals.push(r.total);
  }
  return {
    avg: finals.length ? Math.round(finals.reduce((a, b) => a + b, 0) / finals.length) : null,
    attendancePct: held > 0 ? Math.round((attended / held) * 100) : null,
    finalWeeks: finals.length,
    held,
    attended,
  };
}

/** Строки одного ученика по всем неделям журнала. */
export function rowsOf(weeks: JournalWeek[], studentId: string): WeekStudentResult[] {
  const out: WeekStudentResult[] = [];
  for (const w of weeks) {
    const r = w.rows.find((x) => x.studentId === studentId);
    if (r) out.push(r);
  }
  return out;
}

export type AcademyStatus = 'ACTIVE' | 'PENDING' | 'EXPELLED' | 'NO_GROUP';

/**
 * Статус ученика академии:
 *   EXPELLED — отчислен решением руководства;
 *   PENDING  — 3+ действующих флага и среди них есть поставленный после
 *              последнего решения «Оставить» — ждёт решения;
 *   ACTIVE   — состоит хотя бы в одной группе;
 *   NO_GROUP — ни в одной группе сейчас.
 */
export const FLAGS_FOR_DECISION = 3;

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
