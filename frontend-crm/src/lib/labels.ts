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

export function useTaskStatusLabel(): (status: string | null | undefined) => string {
  const { t } = useT();
  return (s) => {
    if (!s) return '—';
    const key = `task.status.${s}`;
    const val = t(key);
    return val === key ? String(s) : val;
  };
}

export function useStudentStatusLabel(): (status: string | null | undefined) => string {
  const { t } = useT();
  return (s) => {
    if (!s) return '—';
    const key = `student.status.${s}`;
    const val = t(key);
    return val === key ? String(s) : val;
  };
}

export function useOnboardingLabel(): (stage: string | null | undefined) => string {
  const { t } = useT();
  return (s) => {
    if (!s) return '—';
    const key = `onboarding.${s}`;
    const val = t(key);
    return val === key ? String(s) : val;
  };
}

export function useChannelLabel(): (channel: string | null | undefined) => string {
  const { t } = useT();
  return (c) => {
    if (!c) return '—';
    const key = `channel.${c}`;
    const val = t(key);
    return val === key ? String(c) : val;
  };
}
