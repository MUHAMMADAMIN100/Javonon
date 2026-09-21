import { useT } from '../lib/i18n';

export type ListNoun = 'leads' | 'applications' | 'students' | 'deals' | 'payments';

/**
 * Счётчик списка в левом углу шапки: «Всего лидов: 93», а под фильтром или
 * поиском — «Найдено: 12 из 93». Одинаковый во всех списках.
 *
 * found — сколько строк в списке сейчас; total — сколько всего без фильтров
 * (в пределах того, что человеку видно). Без фильтров они совпадают, и total
 * не нужен. Пока общее число под фильтром не пришло — просто «Найдено: 12».
 */
export default function ListTotal({
  noun,
  found,
  total,
  filtered,
  testId,
}: {
  noun: ListNoun;
  found: number;
  total?: number;
  filtered: boolean;
  testId?: string;
}) {
  const { t } = useT();
  const text = !filtered
    ? t(`list.total.${noun}`).replace('{n}', String(found))
    : total !== undefined
      ? t('list.found').replace('{n}', String(found)).replace('{total}', String(total))
      : t('list.foundShort').replace('{n}', String(found));
  return (
    <span className="list-total" data-testid={testId}>
      {text}
    </span>
  );
}
