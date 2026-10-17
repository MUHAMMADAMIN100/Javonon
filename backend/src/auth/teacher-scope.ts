/**
 * Что учителю академии (isTeacherOnly) можно запрашивать у API.
 *
 * Белый список, а не запреты по контроллерам: у части эндпоинтов нет
 * @Roles (RolesGuard их пропускает любому сотруднику), и новый такой
 * эндпоинт тихо открылся бы учителю. Здесь — наоборот: всё, чего нет в
 * списке, учителю закрыто (JwtAuthGuard отвечает 403).
 *
 * Пути — с глобальным префиксом /api (main.ts), без query-строки.
 */
const TEACHER_ALLOWED: Array<{ method?: string; re: RegExp }> = [
  // Вход, /auth/me, выход, смена пароля, файловый токен.
  { re: /^\/api\/auth(\/|$)/ },
  // Свой профиль (/me/full, документы). Чужие профили сервер проверяет сам.
  { re: /^\/api\/me(\/|$)/ },
  { re: /^\/api\/notifications(\/|$)/ },
  // Чата у учителя нет (17.10.2026): общение с учениками — вне CRM.
  // Группы, расписание, журнал, материалы, ученики, флаги.
  { re: /^\/api\/study-groups(\/|$)/ },
  { re: /^\/api\/academy(\/|$)/ },
  // Своя оферта сотрудника: посмотреть и подписать.
  { method: 'GET', re: /^\/api\/offers\/current$/ },
  { method: 'POST', re: /^\/api\/offers\/[^/]+\/sign$/ },
];

export function teacherMayRequest(method: string, rawUrl: string): boolean {
  const url = (rawUrl || '').split('?')[0].replace(/\/+$/, '') || '/';
  const m = (method || 'GET').toUpperCase();
  return TEACHER_ALLOWED.some((r) => (!r.method || r.method === m) && r.re.test(url));
}
