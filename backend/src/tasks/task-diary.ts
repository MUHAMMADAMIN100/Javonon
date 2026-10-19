import { Weekday } from '@prisma/client';
import { addDaysToKey } from '../academy/journal-math';
import { tjLocalDay } from '../common/tj-time';

/**
 * Дневник задачи — как дневник ДЗ ученика (19.10.2026). У задачи с
 * дедлайном каждый исполнитель за каждый рабочий день пишет, что сделал.
 *
 *  - Дни дневника — рабочие дни по «Графику работы» компании (Настройки),
 *    с первого дня дневника по день дедлайна включительно; выходные не дни
 *    дневника и пропуском не считаются.
 *  - Писать можно только за сегодня и только до конца рабочего дня по
 *    графику — потом день закрыт. Прошедшие дни задним числом не пишутся.
 *  - В день дедлайна дневник закрывается (как ДЗ). «Готово» закрывает его
 *    сразу: дни после этого не дни дневника.
 *  - Первый день — день постановки, если задачу поставили до конца рабочего
 *    дня; иначе следующий рабочий день. У задач, поставленных до появления
 *    дневника, дни считаются с TASK_DIARY_SINCE — задним числом никто не
 *    «пропускал».
 */
export const TASK_DIARY_SINCE = '2026-10-20';

/** Сколько дней вперёд искать рабочий день (график без единого рабочего дня — защита от цикла). */
const MAX_SCAN_DAYS = 14;
/** Дневник длиннее года не строим (дедлайн через годы — ошибка ввода, не повод для 10 000 колонок). */
const MAX_DIARY_DAYS = 370;

export type DaySchedule = { isWorkday: boolean; endMinute: number };
export type WeekSchedule = Record<Weekday, DaySchedule>;

const WEEKDAY_BY_UTC_DAY: Weekday[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** День недели календарного дня 'YYYY-MM-DD'. */
export function weekdayOfKey(day: string): Weekday {
  return WEEKDAY_BY_UTC_DAY[new Date(`${day}T00:00:00.000Z`).getUTCDay()];
}

export function isWorkdayKey(day: string, sched: WeekSchedule): boolean {
  return !!sched[weekdayOfKey(day)]?.isWorkday;
}

/** Конец рабочего дня 'YYYY-MM-DD' по графику — момент по Душанбе (UTC+5). */
export function workdayEnd(day: string, sched: WeekSchedule): Date {
  const end = sched[weekdayOfKey(day)]?.endMinute ?? 1080;
  return new Date(Date.parse(`${day}T00:00:00+05:00`) + end * 60_000);
}

/** Ближайший рабочий день начиная с day (включительно). */
export function workdayOnOrAfter(day: string, sched: WeekSchedule): string {
  let d = day;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (isWorkdayKey(d, sched)) return d;
    d = addDaysToKey(d, 1);
  }
  return day;
}

/**
 * Первый день дневника для задачи, которой дедлайн ставят сейчас: сегодня,
 * если рабочий день ещё не кончился; иначе следующий рабочий день.
 */
export function diaryFromFor(now: Date, sched: WeekSchedule): string {
  const today = tjLocalDay(now);
  if (isWorkdayKey(today, sched) && now.getTime() < workdayEnd(today, sched).getTime()) return today;
  return workdayOnOrAfter(addDaysToKey(today, 1), sched);
}

export type DiaryTask = {
  deadline: Date | null;
  diaryFrom: string | null;
  doneAt: Date | null;
  status: string;
};

/** Первый день дневника задачи; поставленной до появления дневника — TASK_DIARY_SINCE. */
export function diaryFirstDay(task: DiaryTask): string {
  return task.diaryFrom ?? TASK_DIARY_SINCE;
}

/**
 * Последний день дневника: день дедлайна, а у выполненной задачи — день
 * «Готово», если он раньше. Выполненная без отметки времени (старые
 * задачи) — дневника за ней уже не ведут: последний день = до первого.
 */
export function diaryLastDay(task: DiaryTask): string | null {
  if (!task.deadline) return null;
  let last = tjLocalDay(task.deadline);
  if (task.status === 'DONE') {
    if (!task.doneAt) return addDaysToKey(diaryFirstDay(task), -1);
    const doneDay = tjLocalDay(task.doneAt);
    if (doneDay < last) last = doneDay;
  }
  return last;
}

/** Дни дневника — рабочие дни с первого по последний. Без дедлайна — пусто. */
export function taskDiaryDays(task: DiaryTask, sched: WeekSchedule): string[] {
  const last = diaryLastDay(task);
  if (!last) return [];
  const out: string[] = [];
  let d = diaryFirstDay(task);
  for (let i = 0; i < MAX_DIARY_DAYS && d <= last; i++) {
    if (isWorkdayKey(d, sched)) out.push(d);
    d = addDaysToKey(d, 1);
  }
  return out;
}

export type WriteBlock =
  | 'no-deadline'
  | 'done'
  | 'not-started'
  | 'after-deadline'
  | 'day-off'
  | 'day-closed';

/**
 * Можно ли сейчас писать запись за сегодня; если можно — до какого момента
 * (closesAt — конец рабочего дня). Иначе — почему нельзя.
 */
export function diaryWindow(
  task: DiaryTask,
  sched: WeekSchedule,
  now: Date = new Date(),
): { today: string; open: boolean; closesAt: Date | null; block: WriteBlock | null } {
  const today = tjLocalDay(now);
  const blocked = (block: WriteBlock) => ({ today, open: false, closesAt: null, block });
  if (!task.deadline) return blocked('no-deadline');
  if (task.status === 'DONE') return blocked('done');
  const first = diaryFirstDay(task);
  const last = tjLocalDay(task.deadline);
  // Дедлайн раньше первого дня (поставили вечером «на сегодня») — дней у дневника нет.
  if (today > last || first > last) return blocked('after-deadline');
  if (today < first) return blocked('not-started');
  if (!isWorkdayKey(today, sched)) return blocked('day-off');
  const closesAt = workdayEnd(today, sched);
  if (now.getTime() >= closesAt.getTime()) return blocked('day-closed');
  return { today, open: true, closesAt, block: null };
}
