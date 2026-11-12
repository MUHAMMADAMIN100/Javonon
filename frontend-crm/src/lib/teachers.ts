import type { User } from '../api/types';

/**
 * Кого показывать в списке «Учитель» (QA-3, набл. 21): только тех, кто может
 * вести группы (признак canTeach считает сервер), плюс уже назначенного —
 * чтобы форма не «теряла» текущего учителя. Если учителей в системе нет вовсе,
 * показываем всех: иначе группу было бы некому назначить.
 */
export function teacherOptions<T extends Pick<User, 'id' | 'fullName'> & { canTeach?: boolean }>(
  users: T[] | undefined,
  keepId?: string | null,
): T[] {
  const all = users ?? [];
  const teachers = all.filter((u) => u.canTeach || (!!keepId && u.id === keepId));
  const list = all.some((u) => u.canTeach) ? teachers : all;
  return [...list].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
}
