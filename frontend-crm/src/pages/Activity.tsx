import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listActivity, ACTIVITY_LABEL, type ActivityAction, type ActivityEntry } from '../api/activity';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import Loading from '../components/Loading';
import { useT } from '../lib/i18n';

// Каждое действие — своя иконка + цвет (для визуального timeline'а).
const ACTION_VISUAL: Record<ActivityAction, { icon: string; color: string; bg: string }> = {
  STATUS_CHANGE:  { icon: 'sync_alt',       color: '#1e5bb8', bg: '#e8f0fb' },
  STUDENT_UPDATE: { icon: 'edit',           color: '#b45309', bg: '#fef3c7' },
  STUDENT_CREATE: { icon: 'person_add',     color: '#15803d', bg: '#dcfce7' },
  STUDENT_DELETE: { icon: 'person_remove',  color: '#b91c1c', bg: '#fee2e2' },
  MANAGER_CHANGE: { icon: 'manage_accounts',color: '#7c3aed', bg: '#ede9fe' },
  PROGRAM_CHANGE: { icon: 'menu_book',      color: '#0891b2', bg: '#cffafe' },
};
const FALLBACK_VISUAL = { icon: 'bolt', color: '#64748b', bg: '#f1f5f9' };

/** Группирует записи по дням: "Сегодня", "Вчера", или дата. */
function groupByDay(items: ActivityEntry[]) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

  const groups: { label: string; items: ActivityEntry[] }[] = [];
  const map = new Map<string, ActivityEntry[]>();

  for (const e of items) {
    const d = new Date(e.createdAt); d.setHours(0, 0, 0, 0);
    let label: string;
    if (d.getTime() === today.getTime()) label = 'Сегодня';
    else if (d.getTime() === yesterday.getTime()) label = 'Вчера';
    else label = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    if (!map.has(label)) { map.set(label, []); groups.push({ label, items: map.get(label)! }); }
    map.get(label)!.push(e);
  }
  return groups;
}

export default function Activity() {
  const { t } = useT();
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

  const reset = () => { setAction(''); setFrom(''); setTo(''); };

  // Сводка по типам действий (для верхних чипов)
  const counts = items.reduce((acc, e) => {
    acc[e.action] = (acc[e.action] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const groups = groupByDay(items);

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.audit06')}</span>
        <h2 className="crm-section-title">
          Хронология <em>действий.</em>
        </h2>
      </div>

      {/* Сводка-чипы */}
      {!loading && items.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {(Object.keys(ACTION_VISUAL) as ActivityAction[]).map((a) => {
            if (!counts[a]) return null;
            const v = ACTION_VISUAL[a];
            return (
              <button
                key={a}
                onClick={() => setAction(action === a ? '' : a)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 500,
                  background: v.bg, color: v.color,
                  border: `1.5px solid ${action === a ? v.color : 'transparent'}`,
                  cursor: 'pointer',
                }}
              >
                <Icon name={v.icon} size={15} />
                {ACTIVITY_LABEL[a]}
                <b>{counts[a]}</b>
              </button>
            );
          })}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">{t('activity.title')}</h2>
          <button className="btn btn-secondary btn-sm" onClick={reset}>
            <Icon name="filter_alt_off" size={16} style={{ marginRight: 4 }} /> {t('filter.reset')}
          </button>
        </div>
        <div className="card-body">
          <div className="filters">
            <select value={action} onChange={(e) => setAction(e.target.value as any)}>
              <option value="">{t('activity.filter.allActions')}</option>
              {Object.entries(ACTIVITY_LABEL).map(([k, v]) => {
                const key = `activity.action.${k}`;
                const translated = t(key);
                return (
                  <option key={k} value={k}>{translated === key ? v : translated}</option>
                );
              })}
            </select>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>

          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Icon name="history" size={48} /></div>
              {t('common.empty')}
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              {groups.map((g) => (
                <div key={g.label} style={{ marginBottom: 24 }}>
                  {/* Заголовок дня */}
                  <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
                    color: 'var(--text-soft)', textTransform: 'uppercase', marginBottom: 12,
                    paddingLeft: 4,
                  }}>{g.label} · {g.items.length}</div>

                  {/* Timeline */}
                  <div style={{ position: 'relative', paddingLeft: 36 }}>
                    {/* вертикальная линия */}
                    <div style={{
                      position: 'absolute', left: 17, top: 8, bottom: 8,
                      width: 2, background: 'var(--border)',
                    }} />
                    {g.items.map((e, i) => {
                      const v = ACTION_VISUAL[e.action] || FALLBACK_VISUAL;
                      return (
                        <motion.div
                          key={e.id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: Math.min(i * 0.02, 0.3) }}
                          style={{ position: 'relative', marginBottom: 10 }}
                        >
                          {/* иконка-узел на линии */}
                          <div style={{
                            position: 'absolute', left: -36, top: 2,
                            width: 36, height: 36, borderRadius: '50%',
                            background: v.bg, color: v.color,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: '3px solid white',
                            boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                          }}>
                            <Icon name={v.icon} size={18} />
                          </div>

                          {/* карточка события */}
                          <div style={{
                            background: 'white', border: '1px solid var(--border-soft)',
                            borderRadius: 12, padding: '12px 14px',
                          }}>
                            <div style={{
                              display: 'flex', justifyContent: 'space-between',
                              alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
                            }}>
                              <span style={{ fontWeight: 600, color: v.color, fontSize: 13 }}>
                                {ACTIVITY_LABEL[e.action]}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-light)' }}>
                                {new Date(e.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            <div style={{ fontSize: 14, color: 'var(--text)', marginTop: 4 }}>
                              {e.details}
                            </div>
                            <div style={{
                              display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap',
                              fontSize: 12, color: 'var(--text-soft)',
                            }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <Icon name="person" size={13} /> {e.actorName}
                                <span style={{ color: 'var(--text-light)' }}>
                                  ({e.actorRole === 'ADMIN' ? 'Админ' : 'Сотрудник'})
                                </span>
                              </span>
                              {e.studentName && (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <Icon name="school" size={13} /> {e.studentName}
                                </span>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
