import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { hasRole } from '../lib/roles';
import { hasPermission } from '../lib/permissions';
import type { Role } from '../api/types';

// Карта роут → разрешённые роли + опциональные permissions. FOUNDER неявно
// имеет доступ ко всему. Если route есть в карте и у юзера нет ни роли,
// ни permission (OR) — редиректим на /dashboard. Backend всё равно
// перепроверяет, это UX-слой.
const ROUTE_ROLES: Array<{ prefix: string; roles: Role[]; perms?: string[] }> = [
  { prefix: '/finance',     roles: ['ADMIN', 'ACCOUNTANT'], perms: ['finance:read', 'finance:write'] },
  { prefix: '/salary',      roles: ['ADMIN', 'ACCOUNTANT'], perms: ['salary:read', 'salary:write'] },
  { prefix: '/users',       roles: ['ADMIN', 'ACCOUNTANT'], perms: ['users:read', 'users:write'] },
  { prefix: '/activity',    roles: ['ADMIN', 'ACCOUNTANT'], perms: ['activity:read'] },
  { prefix: '/lms',         roles: ['ADMIN', 'ACCOUNTANT'], perms: ['lms:read', 'lms:write'] },
  { prefix: '/partners',    roles: ['ADMIN', 'ACCOUNTANT'], perms: ['partners:read'] },
  { prefix: '/settings',    roles: ['FOUNDER'] },
  { prefix: '/pipelines',   roles: ['ADMIN', 'ACCOUNTANT'], perms: ['pipelines:write'] },
  // Оба ключа рассылок: канонический massmail:write и legacy mass-mail:write
  // — hasPermission вариадичен и ORит их (см. PERMISSION_CATALOG на бэке).
  { prefix: '/massmail',    roles: ['ADMIN', 'ACCOUNTANT'], perms: ['massmail:write', 'mass-mail:write'] },
  { prefix: '/offers',      roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/excuses',     roles: ['FOUNDER'] },
  { prefix: '/attendance',  roles: ['FOUNDER'] },
];

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace />;

  const match = ROUTE_ROLES.find((r) => location.pathname.startsWith(r.prefix));
  if (!match) return <>{children}</>;

  // FOUNDER пропускаем неявно — повторим тут (на случай если в match.roles
  // его забыли).
  if (hasRole(user, 'FOUNDER', ...match.roles)) return <>{children}</>;
  // Custom-role-юзер: достаточно одного permission из match.perms.
  if (match.perms && hasPermission(user as any, ...match.perms)) return <>{children}</>;

  return <Navigate to="/dashboard" replace />;
}
