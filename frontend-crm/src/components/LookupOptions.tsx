import type { LookupKind } from '../api/lookups';
import { useLookups } from '../lib/lookups';

/**
 * <option>-ы значения справочника в порядке «Лиды → Настройки».
 * `current` — значение, которое уже стоит в записи: если его нет в списке
 * (старое значение, источник, который ставит система), оно добавляется
 * первым, чтобы <select> не показывал чужой пункт.
 * `only` — сузить список (например, источники, которые сотрудник ставит руками).
 */
export default function LookupOptions({
  kind,
  current,
  only,
}: {
  kind: LookupKind;
  current?: string | null;
  only?: string[];
}) {
  const L = useLookups();
  const keys = only ?? L.keys(kind);
  const extra = current && !keys.includes(current) ? [current] : [];
  return (
    <>
      {[...extra, ...keys].map((k) => (
        <option key={k} value={k}>
          {L.label(kind, k)}
        </option>
      ))}
    </>
  );
}
