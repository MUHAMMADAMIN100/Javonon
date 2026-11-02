/**
 * Загрузить длинный список ЦЕЛИКОМ: журнал «Финансов», окна у карточек
 * денег, «Посещаемость команды», «Сделки» (все и одобренные).
 *
 * Сервер отдаёт за запрос не больше LIST_PAGE строк (backend
 * common/paging.ts), поэтому идём порциями ?skip=0, 1000, 2000… пока порция
 * не придёт неполной. Раньше страницы просили 200 строк и молча показывали
 * только их: журнал писал «Всего операций: 200», хотя операций за период
 * было больше, — а фильтры, сортировка и страницы работали внутри этих 200.
 *
 * Строки без повторов по id: если между запросами кто-то добавил запись,
 * список сдвинется на строку и на стыке порций появился бы дубль. Порция
 * без новых id — стоп: так отвечает сервер, который ?skip ещё не знает
 * (фронт выкатывается раньше API), — иначе цикл крутился бы вечно.
 */
export const LIST_PAGE = 1000;

export async function loadAllPages<T extends { id: string }>(
  fetchPage: (page: { skip: number; take: number }) => Promise<T[]>,
): Promise<T[]> {
  const seen = new Set<string>();
  const all: T[] = [];
  for (let skip = 0; ; skip += LIST_PAGE) {
    const rows = await fetchPage({ skip, take: LIST_PAGE });
    let added = 0;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      all.push(row);
      added += 1;
    }
    if (rows.length < LIST_PAGE || added === 0) return all;
  }
}
