import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { hasRole } from '../lib/roles';
import type { Role } from '../api/types';

// Карта роут → разрешённые роли. FOUNDER неявно имеет доступ ко всему
// (см. hasRole — он трактует FOUNDER как любую роль). Если роута нет в
// карте — доступ всем залогиненным. Backend всё равно перепроверяет, но
// это улучшает UX: не показываем UI который потом упадёт 403.
const ROUTE_ROLES: Array<{ prefix: string; roles: Role[] }> = [
  { prefix: '/finance', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/salary', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/users', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/activity', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/lms', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/partners', roles: ['ADMIN', 'ACCOUNTANT'] },
  // Новые admin/founder-страницы — раньше component-level guard был
  // только в Settings.tsx; остальные могли отображать UI до 403 от API.
  { prefix: '/settings', roles: ['FOUNDER'] },
  { prefix: '/pipelines', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/massmail', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/offers', roles: ['ADMIN', 'ACCOUNTANT'] },
  // По ТЗ §5 — причины опозданий рассматривает только основатель.
  { prefix: '/excuses', roles: ['FOUNDER'] },
  // Посещаемость по ТЗ §3 — тоже FOUNDER.
  { prefix: '/attendance', roles: ['FOUNDER'] },
];

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace />;

  const match = ROUTE_ROLES.find((r) => location.pathname.startsWith(r.prefix));
  // FOUNDER пропускаем всегда (hasRole(user, 'FOUNDER') не проверяет required —
  // отдельный кейс). Иначе проверяем пересечение ролей.
  if (match && !hasRole(user, 'FOUNDER', ...match.roles)) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
