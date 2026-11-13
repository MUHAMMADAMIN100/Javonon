import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { hasActiveRole, hasPermission } from '../lib/permissions';
import { useT } from '../lib/i18n';
import Icon from '../Icon';
import TimeTracker from './TimeTracker';
import Excuses from './Excuses';
import Activity from './Activity';
import ScheduleEditor from '../components/ScheduleEditor';
import { MyMonth, TeamToday, Timesheet } from '../components/ShiftsBoard';

/**
 * «Активность и смены» (13.11.2026, как в Sabt) — бывший «Рабочий день».
 * Руководитель: табель месяца, смены сегодня (просьбы, отгулы), график
 * работы, лента событий и причины опозданий. Сотрудник: свой месяц и своё
 * время (приход с подтверждением, обед, причины опозданий).
 * Старые адреса /time, /attendance, /excuses ведут сюда на нужную вкладку.
 */
type Tab = 'timesheet' | 'today' | 'schedule' | 'feed' | 'excuses' | 'month' | 'time';

export default function Workday() {
  const me = useAuth((s) => s.user);
  const { t } = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const founder = isFounder(me as any);
  const viewerRole = hasActiveRole(me) && !founder;
  const seeTeam = founder || (viewerRole && hasPermission(me, 'attendance:read'));
  const seeExcuses = founder || (viewerRole && hasPermission(me, 'excuses:read', 'excuses:approve'));
  const seeFeed = founder || (viewerRole && hasPermission(me, 'activity:read'));
  const ownTime = !founder;

  const tabs: Array<{ key: Tab; label: string; visible: boolean }> = [
    { key: 'timesheet', label: t('wd.tab.timesheet'), visible: seeTeam },
    { key: 'today', label: t('wd.tab.today'), visible: seeTeam },
    { key: 'schedule', label: t('wd.tab.schedule'), visible: seeTeam },
    { key: 'feed', label: t('wd.tab.feed'), visible: seeFeed },
    { key: 'excuses', label: t('workday.tab.excuses'), visible: seeExcuses },
    { key: 'month', label: t('wd.tab.month'), visible: ownTime && !seeTeam },
    { key: 'time', label: t('workday.tab.time'), visible: ownTime },
  ];
  const visible = tabs.filter((x) => x.visible);
  const allowed = (k: Tab) => visible.some((x) => x.key === k);

  const search = new URLSearchParams(location.search);
  const raw = search.get('tab');
  const legacy: Record<string, Tab> = { attendance: 'timesheet' };
  const fromQuery = (raw && (legacy[raw] ?? raw)) as Tab | null;
  const fromPath: Tab | null =
    location.pathname.startsWith('/attendance') ? 'timesheet' :
    location.pathname.startsWith('/excuses') ? 'excuses' :
    location.pathname.startsWith('/time') ? 'time' : null;
  const fallback: Tab = seeTeam ? 'timesheet' : 'month';
  const requested = fromQuery || fromPath || fallback;
  const [tab, setTab] = useState<Tab>(allowed(requested) ? requested : allowed(fallback) ? fallback : (visible[0]?.key ?? 'time'));

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('tab') !== tab) {
      params.set('tab', tab);
      navigate({ pathname: '/workday', search: params.toString() }, { replace: true });
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="wd-page">
      <div className="client-tabs wd-tabs" role="tablist" data-testid="wd-tabs">
        {visible.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            className={`client-tab${tab === x.key ? ' active' : ''}`}
            onClick={() => setTab(x.key)}
            data-testid={`workday-tab-${x.key}`}
          >
            {x.label}
          </button>
        ))}
        <span className="wd-live"><Icon name="sensors" size={14} />{t('wd.live')}</span>
      </div>
      {tab === 'timesheet' && <Timesheet />}
      {tab === 'today' && <TeamToday />}
      {tab === 'schedule' && <div className="card wd-schedule"><ScheduleEditor userId={null} /></div>}
      {tab === 'feed' && <Activity />}
      {tab === 'excuses' && <Excuses />}
      {tab === 'month' && <MyMonth />}
      {tab === 'time' && <TimeTracker />}
    </div>
  );
}
