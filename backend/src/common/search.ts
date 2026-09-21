import { BadRequestException } from '@nestjs/common';

/**
 * Разбор строки поиска списков CRM (лиды/заявки, сделки) — один на все
 * списки, чтобы поиск везде вёл себя одинаково.
 *
 * Это НЕ сравнение телефонов для сопоставления клиентов (см. phone.ts) —
 * здесь человек ищет глазами, и лишнее совпадение ничего не ломает.
 */

/**
 * Prisma кладёт `contains` в ILIKE как есть: «%» и «_» там — маски, и поиск
 * «%» выдавал весь список. Экранируем, ищем буквально.
 */
export function likeLiteral(search: string): string {
  return search.replace(/[\\%_]/g, '\\$&');
}

/**
 * LIKE-шаблон для поиска номера по ОДНИМ цифрам: человек набирает
 * «91 899 99 16» или «918-99-99-16», а в базе «+992918999916» (или с
 * пробелами — DTO их пропускает). Сравнивать надо цифры с цифрами, поэтому
 * колонку в SQL тоже прогоняют через regexp_replace(…, '[^0-9]', '', 'g').
 *
 * Только если строка похожа на номер: у «Али 2» цифра «2» совпала бы с
 * половиной базы. null — искать по номеру не нужно.
 */
export function phoneDigitsPattern(search: string): string | null {
  const digits = search.replace(/\D/g, '');
  if (!digits || !/^[\d\s+\-().]+$/.test(search)) return null;
  return `%${digits}%`;
}

/**
 * Строка поиска из query. Потолок — 200 символов: без него ?search=AAA…×100k
 * гонял бы ILIKE %…% с гигантским шаблоном по всей таблице. Пустое → undefined.
 */
export function checkSearch(raw?: string): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  if (s.length > 200) throw new BadRequestException('Поисковая строка слишком длинная');
  return s;
}
