import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { isTeacherOnly } from '../lib/roles';
import { buildNavCtx, NAV_GROUPS, type NavCtx } from './navGroups';

/**
 * Раздел открывается по прямой ссылке ровно тем, кому его показывает меню
 * (navGroups: роль — галочками, должность — как раньше). Раньше здесь была
 * своя карта «роут → должности», и сотрудник с ролью проходил по должности
 * в разделы, которых у него в меню нет. Backend всё равно перепроверяет —
 * это слой интерфейса.
 *
 * Исключения — карточки, которые открываются не только из своего раздела:
 *  - /applications/:id — и лид, и заявка: хватит «Лиды — просмотр»;
 *  - /profile/:id — профиль коллеги (доступ решает сервер);
 *  - /time, /attendance, /excuses — старые адреса вкладок «Рабочего дня».
 */
const DETAIL_RULES: Array<{ prefix: string; visible: (c: NavCtx) => boolean }> = [
  { prefix: '/applications/', visible: (c) => c.show(['applications:read', 'leads:read'], c.isWorkforce) },
  { prefix: '/students/new', visible: (c) => c.show('students:create', c.isWorkforce) },
  { prefix: '/submissions/new', visible: (c) => !c.isTeacherOnly && c.show('submissions:create', true) },
  { prefix: '/profile', visible: () => true },
  // «Подробный расчёт» зарплаты: в меню пункта нет (ведомость — «Расход → Зарплата»,
  // 01047dd), но страница открыта всем, у кого есть право на зарплату (QA-2:
  // ссылка из ведомости уводила основателя на дашборд).
  { prefix: '/salary', visible: (c) => c.show('salary:read', c.elevated) },
  { prefix: '/time', visible: (c) => !c.isTeacherOnly },
  { prefix: '/attendance', visible: (c) => c.isFounder || (c.hasCustomRole && c.can('attendance:read')) },
  { prefix: '/excuses', visible: (c) => c.isFounder || (c.hasCustomRole && c.can('excuses:read', 'excuses:approve')) },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items).sort((a, b) => b.to.length - a.to.length);

/**
 * Учителю академии (isTeacherOnly) открыты только эти разделы — тот же
 * белый список, что на сервере (auth/teacher-scope.ts). Всё остальное, в
 * том числе «/» и дашборд, ведёт в его группы.
 */
const TEACHER_PREFIXES = ['/groups', '/academy', '/schedule', '/me'];
export const TEACHER_HOME = '/groups';

const under = (pathname: string, prefix: string) =>
  prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(prefix + '/');

/** Домашние адреса: с них учителя ведём в его группы (это его «главная»), а не пишем «нет доступа». */
const HOME_PATHS = ['/', '/dashboard'];

/**
 * Закрыт ли раздел этому человеку. QA-3 (BUG-28): раньше запрещённая страница
 * по прямой ссылке МОЛЧА открывала дашборд (учителю — «Учебные группы»), и
 * человек думал, что ссылка сломана. Теперь внутри обычной рамки CRM (меню на
 * месте) показывается «Нет доступа к разделу» — см. Layout. Сама страница при
 * этом не монтируется и запросов к серверу не шлёт.
 */
export function routeDenied(user: any, pathname: string): boolean {
  if (!user) return false;
  if (isTeacherOnly(user)) {
    if (HOME_PATHS.includes(pathname)) return false; // уйдёт редиректом в группы
    return !TEACHER_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
  }
  const ctx = buildNavCtx(user);
  const detail = DETAIL_RULES.find((r) => under(pathname, r.prefix));
  if (detail) return !detail.visible(ctx);
  const item = NAV_ITEMS.find((i) => under(pathname, i.to));
  if (!item || item.to === '/dashboard') return false;
  return !item.visible(ctx);
}

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  // Учитель на «главной» — в свои группы: дашборда у него нет.
  if (isTeacherOnly(user as any) && HOME_PATHS.includes(location.pathname)) {
    return <Navigate to={TEACHER_HOME} replace />;
  }
  return <>{children}</>;
}
