import { useT } from '../lib/i18n';

/** Любой объект сотрудника из ответа сервера; смотрим только на isActive. */
type Person = object | null | undefined;
const isDismissed = (person: Person) => !!person && (person as { isActive?: boolean | null }).isActive === false;

/**
 * Пометка «уволен» рядом с именем сотрудника в ИСТОРИИ: старые сообщения,
 * закрытые заявки и сделки, записи журнала. Из списков, рейтингов и выбора
 * уволенный убран на сервере; там, где его имя осталось в прошлых записях,
 * пометка объясняет, почему его больше нет в команде.
 *
 * Сервер отдаёт isActive вместе с именем; у старого ответа поля нет —
 * тогда ничего не рисуем.
 */
export default function DismissedMark({ person }: { person?: Person }) {
  const { t } = useT();
  if (!isDismissed(person)) return null;
  return (
    <span className="dismissed-mark" data-testid="dismissed-mark">
      {t('users.dismissed')}
    </span>
  );
}

/** То же для текста (подписи групп, пункты выпадающих списков). */
export function withDismissed(name: string, person: Person, dismissedWord: string) {
  return isDismissed(person) ? `${name} (${dismissedWord.toLowerCase()})` : name;
}
