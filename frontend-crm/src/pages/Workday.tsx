import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useT } from '../lib/i18n';
import TimeTracker from './TimeTracker';
import Attendance from './Attendance';
import Excuses from './Excuses';

/**
 * Объединённая страница «Рабочий день» (ТЗ-доработка).
 * Раньше было 3 отдельных пункта в Sidebar — теперь один с тремя
 * вкладками. Видимость табов зависит от роли:
 *   - «Моё время» — для всех залогиненных
 *   - «Посещаемость» — только FOUNDER
 *   - «Причины опозданий» — только FOUNDER
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

  // Таб из URL ?tab=… или из path (legacy). По умолчанию time.
  const search = new URLSearchParams(location.search);
  const fromQuery = (search.get('tab') as Tab) || null;
  const fromPath: Tab | null =
    location.pathname.startsWith('/attendance') ? 'attendance' :
    location.pathname.startsWith('/excuses') ? 'excuses' :
    location.pathname.startsWith('/time') ? 'time' : null;
  const initial: Tab = fromQuery || fromPath || 'time';
  const [tab, setTab] = useState<Tab>(initial);

  // Когда юзер кликает таб — обновляем URL чтобы можно было поделиться.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('tab') !== tab) {
      params.set('tab', tab);
      navigate({ pathname: '/workday', search: params.toString() }, { replace: true });
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Не-FOUNDER может смотреть только своё время.
  const tabs: Array<{ key: Tab; label: string; visible: boolean }> = [
    { key: 'time', label: t('workday.tab.time'), visible: true },
    { key: 'attendance', label: t('workday.tab.attendance'), visible: founder },
    { key: 'excuses', label: t('workday.tab.excuses'), visible: founder },
  ];
  const visibleTabs = tabs.filter((tb) => tb.visible);

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.hr')} · {t('workday.title').toUpperCase()}</span>
        <h2 className="crm-section-title">{t('workday.title')}</h2>
      </div>

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
              style={{
                padding: '10px 18px',
                borderRadius: 10,
                border: '1.5px solid',
                borderColor: tab === tb.key ? 'var(--primary)' : 'var(--border)',
                background: tab === tb.key ? 'var(--primary-light, #e0e7ff)' : 'white',
                color: tab === tb.key ? 'var(--primary-dark, #4338ca)' : 'var(--text-soft)',
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

      {tab === 'time' && <TimeTracker />}
      {tab === 'attendance' && founder && <Attendance />}
      {tab === 'excuses' && founder && <Excuses />}
    </>
  );
}
