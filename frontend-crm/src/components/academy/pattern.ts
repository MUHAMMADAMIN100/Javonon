import type { ClassSession, WeeklySlot } from '../../api/studyGroups';
import { tjFormatTime } from '../../lib/tjTime';
import { tjWeekdayOf } from './academyUi';

const DAY = 24 * 60 * 60 * 1000;

/**
 * «По каким дням» группа занимается — по занятиям ближайших 4 недель (если
 * их нет — по последним 4 неделям). Та же логика, что weeklyPattern на
 * сервере (academy/journal-math.ts), для карточки группы.
 */
export function weeklyPatternOf(sessions: ClassSession[]): WeeklySlot[] {
  const now = Date.now();
  const live = sessions.filter((s) => s.status !== 'CANCELLED');
  let pick = live.filter((s) => new Date(s.endsAt).getTime() >= now && new Date(s.startsAt).getTime() <= now + 28 * DAY);
  if (!pick.length) pick = live.filter((s) => new Date(s.startsAt).getTime() >= now - 28 * DAY && new Date(s.startsAt).getTime() < now);
  const seen = new Map<string, WeeklySlot>();
  for (const s of pick) {
    const slot = { weekday: tjWeekdayOf(s.startsAt), from: tjFormatTime(s.startsAt), to: tjFormatTime(s.endsAt) };
    const key = `${slot.weekday}|${slot.from}|${slot.to}`;
    if (!seen.has(key)) seen.set(key, slot);
  }
  return [...seen.values()].sort((a, b) => a.weekday - b.weekday || a.from.localeCompare(b.from));
}
