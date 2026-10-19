import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { hasActiveRole, hasPermission } from '../lib/permissions';
import { useT } from '../lib/i18n';
import TimeTracker from './TimeTracker';
import Attendance from './Attendance';
import Excuses from './Excuses';

/**
 * Объединённая страница «Рабочий день» (ТЗ-доработка).
 * Раньше было 3 отдельных пункта в Sidebar — теперь один с тремя
 * вкладками. Видимость табов зависит от роли:
 *   - «Моё время» — для всех залогиненных (кроме основателя)
 *   - «Посещаемость» — FOUNDER и роль с «Посещаемость»
 *   - «Причины опозданий» — FOUNDER и роль с «Причины опозданий»
 *
 * Старые роуты /time, /attendance, /excuses перенаправляются сюда
 * на нужный таб (см. App.tsx).
 */
type Tab = 'time' | 'attendance' | 'excuses';

export default function Workday() {
  const me = useAuth((s) => s.user);
  const { t } = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const founder = isFounder(me as any);
  // Табель и опоздания команды: основатель; сотрудник с ролью — по её галочкам.
  const viewerRole = hasActiveRole(me) && !founder;
  const seeAttendance = founder || (viewerRole && hasPermission(me, 'attendance:read'));
  const seeExcuses = founder || (viewerRole && hasPermission(me, 'excuses:read', 'excuses:approve'));

  // Таб из URL ?tab=… или из path (legacy). По умолчанию time.
  const search = new URLSearchParams(location.search);
  const fromQuery = (search.get('tab') as Tab) || null;
  const fromPath: Tab | null =
    location.pathname.startsWith('/attendance') ? 'attendance' :
    location.pathname.startsWith('/excuses') ? 'excuses' :
    location.pathname.startsWith('/time') ? 'time' : null;
  // Основатель не отмечает приход — его страница начинается с посещаемости команды.
  const fallback: Tab = founder ? 'attendance' : 'time';
  const requested = fromQuery || fromPath || fallback;
  const allowed = (tb: Tab) =>
    tb === 'time' ? !founder : tb === 'attendance' ? seeAttendance : seeExcuses;
  const initial: Tab = allowed(requested) ? requested : fallback;
  const [tab, setTab] = useState<Tab>(initial);

  // Когда юзер кликает таб — обновляем URL чтобы можно было поделиться.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('tab') !== tab) {
      params.set('tab', tab);
      navigate({ pathname: '/workday', search: params.toString() }, { replace: true });
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Своё время — все, кроме основателя; табель и опоздания — см. выше.
  const tabs: Array<{ key: Tab; label: string; visible: boolean }> = [
    { key: 'time', label: t('workday.tab.time'), visible: allowed('time') },
    { key: 'attendance', label: t('workday.tab.attendance'), visible: allowed('attendance') },
    { key: 'excuses', label: t('workday.tab.excuses'), visible: allowed('excuses') },
  ];
  const visibleTabs = tabs.filter((tb) => tb.visible);

  return (
    <>
      {visibleTabs.length > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            marginBottom: 18,
            borderBottom: '1px solid var(--border)',
            paddingBottom: 12,
          }}
        >
          {visibleTabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              data-testid={`workday-tab-${tb.key}`}
              style={{
                padding: '10px 18px',
                borderRadius: 10,
                border: '1.5px solid',
                borderColor: tab === tb.key ? 'var(--primary)' : 'var(--border)',
                // Активная — синяя со светлым текстом (тёмный на синем не читался).
                background: tab === tb.key ? 'var(--primary)' : 'white',
                color: tab === tb.key ? '#fff' : 'var(--text-soft)',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              {tb.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'time' && allowed('time') && <TimeTracker />}
      {tab === 'attendance' && allowed('attendance') && <Attendance />}
      {tab === 'excuses' && allowed('excuses') && <Excuses />}
    </>
  );
}
