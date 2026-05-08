import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listActivity, ACTIVITY_LABEL, type ActivityAction, type ActivityEntry } from '../api/activity';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import Loading from '../components/Loading';

const ACTION_BADGE: Record<ActivityAction, string> = {
  STATUS_CHANGE: 'badge-info',
  STUDENT_UPDATE: 'badge-warning',
  STUDENT_CREATE: 'badge-success',
  STUDENT_DELETE: 'badge-danger',
  MANAGER_CHANGE: 'badge-warning',
  PROGRAM_CHANGE: 'badge-info',
};

export default function Activity() {
  const qc = useQueryClient();
  const [action, setAction] = useState<ActivityAction | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [debounced, setDebounced] = useState({ action: '' as ActivityAction | '', from: '', to: '' });

  useEffect(() => {
    const t = setTimeout(() => setDebounced({ action, from, to }), 250);
    return () => clearTimeout(t);
  }, [action, from, to]);

  const filters = {
    action: debounced.action || undefined,
    from: debounced.from ? new Date(debounced.from).toISOString() : undefined,
    to: debounced.to ? new Date(debounced.to + 'T23:59:59').toISOString() : undefined,
  };
  const activityQuery = useQuery<ActivityEntry[]>({
    queryKey: ['activity', filters],
    queryFn: () => listActivity(filters),
  });
  const items = activityQuery.data ?? [];
  const loading = activityQuery.isLoading;

  useRealtime({
    'activity:new': () => qc.invalidateQueries({ queryKey: ['activity'] }),
  });

  const reset = () => {
    setAction('');
    setFrom('');
    setTo('');
  };

  return (
    <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="card-header">
        <h2 className="card-title">Активность менеджеров</h2>
        <button className="btn btn-secondary btn-sm" onClick={reset}>
          <Icon name="filter_alt_off" size={16} style={{ marginRight: 4 }} /> Сброс
        </button>
      </div>
      <div className="card-body">
        <div className="filters">
          <select value={action} onChange={(e) => setAction(e.target.value as any)}>
            <option value="">Все действия</option>
            {Object.entries(ACTIVITY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="От"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="До"
          />
        </div>

        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Icon name="history" size={48} /></div>
            Ничего не найдено
          </div>
        ) : (
          <div className="activity-list">
            {items.map((e) => (
              <motion.div
                key={e.id}
                className="activity-item"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="activity-item-head">
                  <span className={`badge ${ACTION_BADGE[e.action]}`}>{ACTIVITY_LABEL[e.action]}</span>
                  <span className="activity-time">{new Date(e.createdAt).toLocaleString('ru-RU')}</span>
                </div>
                <div className="activity-actor">
                  <Icon name="person" size={14} /> {e.actorName} <span className="activity-role">({e.actorRole === 'ADMIN' ? 'Админ' : 'Сотрудник'})</span>
                </div>
                {e.studentName && (
                  <div className="activity-student">
                    <Icon name="school" size={14} /> {e.studentName}
                  </div>
                )}
                <div className="activity-details">{e.details}</div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
