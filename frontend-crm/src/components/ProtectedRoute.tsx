import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store/auth';

type Role = 'ADMIN' | 'EMPLOYEE' | 'ACCOUNTANT';

// Карта роут → разрешённые роли. Если роута нет в карте — доступ всем
// залогиненным. Backend всё равно перепроверяет, но это улучшает UX:
// не показываем UI который потом упадёт 403.
const ROUTE_ROLES: Array<{ prefix: string; roles: Role[] }> = [
  { prefix: '/finance', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/salary', roles: ['ADMIN', 'ACCOUNTANT'] },
  { prefix: '/users', roles: ['ADMIN'] },
  { prefix: '/activity', roles: ['ADMIN'] },
  { prefix: '/lms', roles: ['ADMIN'] },
  { prefix: '/partners', roles: ['ADMIN'] },
];

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace />;

  const match = ROUTE_ROLES.find((r) => location.pathname.startsWith(r.prefix));
  if (match && !match.roles.includes(user.role as Role)) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
