import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../store/auth';
import { useT } from '../../lib/i18n';
import { buildNavCtx, visibleGroups } from '../navGroups';

/**
 * Разделы «Финансов» чипами — только на телефоне (≤ 900px, правило в
 * theme.css): на компьютере их показывает панель меню. Пункты и права —
 * из navGroups.ts, как в меню.
 */
export default function FinanceSubnav() {
  const user = useAuth((s) => s.user);
  const { t } = useT();
  const loc = useLocation();
  const group = visibleGroups(buildNavCtx(user)).find((g) => g.key === 'finance');
  if (!group || group.items.length < 2) return null;
  // Активный — самый длинный подходящий адрес (/finance не горит на /finance/settings).
  const active = [...group.items]
    .filter((it) => loc.pathname === it.to || loc.pathname.startsWith(it.to + '/'))
    .sort((a, b) => b.to.length - a.to.length)[0]?.to;
  return (
    <nav className="fin-subnav" aria-label={t(group.labelKey)} data-testid="fin-subnav">
      {group.items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end
          className={`fin-subnav-chip${it.to === active ? ' is-active' : ''}`}
          aria-current={it.to === active ? 'page' : undefined}
        >
          {t(it.labelKey)}
        </NavLink>
      ))}
    </nav>
  );
}
