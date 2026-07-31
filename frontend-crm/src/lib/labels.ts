import { useT } from './i18n';
import { STATUS_LABEL } from '../api/types';

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

export function useDirectionLabel(): (dir: string | null | undefined) => string {
  const { t } = useT();
  return (dir) => {
    if (!dir) return '—';
    const key = `direction.${dir}`;
    const val = t(key);
    return val === key ? String(dir) : val;
  };
}

/**
 * Страна заявки («Кишвар» из формы лендинга). Возвращает «—» для заявок
 * без страны — их много: всё, что создано до релиза новой формы, плюс
 * заявки, заведённые в обход формы (ручное создание в CRM, самозапись
 * студента, approve заявки партнёра).
 */
export function useCountryLabel(): (country: string | null | undefined) => string {
  const { t } = useT();
  return (c) => {
    if (!c) return '—';
    const key = `country.${c}`;
    const val = t(key);
    return val === key ? String(c) : val;
  };
}

/**
 * Метка статуса заявки. Резолвит и 10 актуальных статусов, и legacy-значения:
 * пока перенос строк не прогнали, API реально отдаёт ENROLLED/DOCS_REVIEW
 * и т.д., и показать менеджеру сырой ключ enum — хуже, чем показать русскую
 * метку в TJ-локали. Поэтому порядок: i18n → RU-фоллбэк STATUS_LABEL → ключ.
 *
 * Перенос строк на бэкенде — ЯВНО ОПТ-ИН (MIGRATE_LEAD_STATUSES, см.
 * backend/src/common/application-status.ts), то есть «пока» тут может длиться
 * сколько угодно; это не временный костыль на пару минут деплоя.
 */
export function useApplicationStatusLabel(): (status: string | null | undefined) => string {
  const { t } = useT();
  return (s) => {
    if (!s) return '—';
    const key = `app.status.${s}`;
    const val = t(key);
    if (val !== key) return val;
    return STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? String(s);
  };
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
