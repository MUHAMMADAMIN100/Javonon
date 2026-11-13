import { useT } from './i18n';
import { useLookups } from './lookups';

/**
 * Helpers для перевода динамических enum-меток (ROLE_LABEL,
 * STATUS_LABEL, DIRECTION_LABEL и т.д.) через i18n.
 *
 * Раньше эти константы лежали в api/types.ts как Record<X, string>
 * с захардкоженным русским. После ТЗ-доработки п.11 нужно чтобы
 * они переключались на TJ. Импортируем хук, возвращаем функцию-
 * lookup которую можно использовать вместо ROLE_LABEL[r].
 */

export function useRoleLabel(): (role: string | null | undefined) => string {
  const { t } = useT();
  return (role) => {
    if (!role) return '—';
    const key = `role.${role}`;
    const val = t(key);
    return val === key ? String(role) : val;
  };
}

/**
 * Направление, страна, статус лида, источник — значения справочников
 * «Лиды → Настройки» (13.11.2026): подпись берётся оттуда на текущем языке,
 * а до загрузки справочника — из словаря i18n (см. lib/lookups.tsx).
 * Для пустого значения — «—» (у старых заявок страны нет).
 */
export function useDirectionLabel(): (dir: string | null | undefined) => string {
  const L = useLookups();
  return (dir) => L.label('DIRECTION', dir);
}

export function useCountryLabel(): (country: string | null | undefined) => string {
  const L = useLookups();
  return (c) => L.label('COUNTRY', c);
}

/** Статус лида; легаси-значения старой воронки — русской подписью (STATUS_LABEL). */
export function useApplicationStatusLabel(): (status: string | null | undefined) => string {
  const L = useLookups();
  return (s) => L.label('LEAD_STATUS', s);
}

export function useSourceLabel(): (source: string | null | undefined) => string {
  const L = useLookups();
  return (s) => L.label('LEAD_SOURCE', s);
}

export function useTaskStatusLabel(): (value: string | null | undefined) => string {
  const L = useLookups();
  return (v) => L.label('TASK_STATUS', v);
}

export function useStudentStatusLabel(): (value: string | null | undefined) => string {
  const L = useLookups();
  return (v) => L.label('STUDENT_STATUS', v);
}

export function useOnboardingLabel(): (value: string | null | undefined) => string {
  const L = useLookups();
  return (v) => L.label('ONBOARDING_STAGE', v);
}

export function useChannelLabel(): (value: string | null | undefined) => string {
  const L = useLookups();
  return (v) => L.label('CONTACT_CHANNEL', v);
}

/** Тип записи истории общения, итог звонка, способ оплаты сделки — справочник «Настройки». */
export function useLookupLabel(kind: import('../api/lookups').LookupKind): (value: string | null | undefined) => string {
  const L = useLookups();
  return (v) => L.label(kind, v);
}
