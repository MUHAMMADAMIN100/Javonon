/**
 * Поиск по списку, который уже целиком загружен в браузер (партнёры,
 * комиссии, выплаты). Правила те же, что у серверного поиска
 * (backend/src/common/search.ts): текст — вхождение без учёта регистра,
 * номер — по одним цифрам, если строка похожа на номер («91 899 99 16»
 * найдёт «+992918999916»; у «Али 2» цифру «2» номером не считаем).
 */
export function matchesSearch(
  search: string,
  texts: (string | null | undefined)[],
  phones: (string | null | undefined)[] = [],
): boolean {
  const q = search.trim().toLocaleLowerCase('ru');
  if (!q) return true;
  if (texts.some((t) => !!t && t.toLocaleLowerCase('ru').includes(q))) return true;
  const digits = q.replace(/\D/g, '');
  if (digits && /^[\d\s+\-().]+$/.test(q)) {
    return phones.some((p) => !!p && p.replace(/\D/g, '').includes(digits));
  }
  return false;
}
