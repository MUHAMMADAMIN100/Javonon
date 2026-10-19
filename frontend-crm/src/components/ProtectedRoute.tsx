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

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace />;

  if (isTeacherOnly(user as any)) {
    const allowed = TEACHER_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'));
    return allowed ? <>{children}</> : <Navigate to={TEACHER_HOME} replace />;
  }

  const path = location.pathname;
  const ctx = buildNavCtx(user);
  const detail = DETAIL_RULES.find((r) => under(path, r.prefix));
  if (detail) return detail.visible(ctx) ? <>{children}</> : <Navigate to="/dashboard" replace />;

  const item = NAV_ITEMS.find((i) => under(path, i.to));
  if (!item || item.to === '/dashboard') return <>{children}</>;
  return item.visible(ctx) ? <>{children}</> : <Navigate to="/dashboard" replace />;
}
