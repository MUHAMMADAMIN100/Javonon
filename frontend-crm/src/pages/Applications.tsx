import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listApplications } from '../api/applications';
import { listUsers } from '../api/users';
import type { ApplicationSource, ApplicationStatus, Direction } from '../api/types';
import { APPLICATION_SOURCES, SOURCE_BADGE, SOURCE_LABEL, STATUS_BADGE } from '../api/types';
import { useAuth } from '../store/auth';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import DirectionOptions from '../components/DirectionOptions';
import Pagination from '../components/Pagination';
import { keys } from '../lib/queryKeys';
import Loading from '../components/Loading';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useDirectionLabel, useApplicationStatusLabel } from '../lib/labels';

type Scope = 'all' | 'mine';

// 5 — было удобно для скриншотов/демо, но на реальном CRM с сотнями
// заявок это значит постоянное «следующая страница». 20 даёт нормальный
// объём для обзора и помещается на одном экране ноутбука.
const PAGE_SIZE = 20;

// Роли, которые реально являются менеджерами заявок (по ТЗ §7). FOUNDER/
// ADMIN/ACCOUNTANT тоже могут быть назначены, но фильтр должен по
// умолчанию показывать только реальных продажников/клиент-менеджеров.
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'CLIENT_MANAGER']);

export default function Applications() {
  const { t } = useT();
  const directionLabel = useDirectionLabel();
  const statusLabel = useApplicationStatusLabel();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<ApplicationStatus | ''>('');
  const [direction, setDirection] = useState<Direction | ''>('');
  const [manager, setManager] = useState<string>('');
  const [source, setSource] = useState<ApplicationSource | ''>('');
  const isAdmin = isElevated(me);
  // Менеджер видит только свои заявки; админ может переключать.
  const [scope, setScope] = useState<Scope>(isAdmin ? 'all' : 'mine');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Сбросить страницу при смене фильтров.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, direction, scope, manager, source]);

  const filters = {
    search: debouncedSearch || undefined,
    status: status || undefined,
    direction: direction || undefined,
    mine: scope === 'mine',
    manager: manager || undefined,
    source: source || undefined,
  };

  const appsQuery = useQuery({
    queryKey: keys.applications.list(filters),
    queryFn: () => listApplications(filters),
  });
  const items = appsQuery.data ?? [];
  const loading = appsQuery.isLoading;

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
    enabled: isAdmin,
  });
  // Фильтр дропдауна «менеджер»: только SALES_MANAGER/CLIENT_MANAGER.
  // По мульти-ролям (ТЗ §2) — попадает если хотя бы одна из ролей в наборе.
  const users = (usersQuery.data ?? []).filter((u) => {
    const all = [u.role, ...((u as any).roles || [])].filter(Boolean);
    return all.some((r) => MANAGER_ROLES.has(r as string));
  });

  // При изменении набора заявок извне — корректируем текущую страницу.
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [items.length, page]);

  const pagedItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useRealtime({
    'application:new': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
    'application:updated': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
    'application:deleted': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
  });

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="card-header">
        <h2 className="card-title">{t('app.title')}</h2>
        {isAdmin && (
          <div className="scope-switch">
            <button
              className={`scope-btn${scope === 'mine' ? ' active' : ''}`}
              onClick={() => setScope('mine')}
            >
              <Icon name="person" size={16} />
              {t('scope.mine')}
            </button>
            <button
              className={`scope-btn${scope === 'all' ? ' active' : ''}`}
              onClick={() => setScope('all')}
            >
              <Icon name="groups" size={16} />
              {t('common.all')}
            </button>
          </div>
        )}
      </div>
      <div className="card-body">
        <div className="filters">
          <input className="crm-input" placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="crm-select" value={status} onChange={(e) => setStatus(e.target.value as any)}>
            <option value="">{t('app.filter.status')}</option>
            <option value="NEW">{statusLabel('NEW' as any)}</option>
            <option value="DOCS_REVIEW">{statusLabel('DOCS_REVIEW' as any)}</option>
            <option value="DOCS_SUBMITTED">{statusLabel('DOCS_SUBMITTED' as any)}</option>
            <option value="PRE_ADMISSION">{statusLabel('PRE_ADMISSION' as any)}</option>
            <option value="AWAITING_PAYMENT">{statusLabel('AWAITING_PAYMENT' as any)}</option>
            <option value="ENROLLED">{statusLabel('ENROLLED' as any)}</option>
          </select>
          {isAdmin && (
            <select className="crm-select" value={manager} onChange={(e) => setManager(e.target.value)} title={t('app.filter.manager')}>
              <option value="">{t('app.filter.manager')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </select>
          )}
          <select className="crm-select" value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="">{t('app.filter.direction')}</option>
            <DirectionOptions />
          </select>
          <select
            className="crm-select"
            value={source}
            onChange={(e) => setSource(e.target.value as ApplicationSource | '')}
            title="Источник"
          >
            <option value="">Источник — все</option>
            {APPLICATION_SOURCES.map((s) => (
              <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
            ))}
          </select>
          {(search || status || direction || manager || source) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSearch('');
                setStatus('');
                setDirection('');
                setManager('');
                setSource('');
              }}
              title={t('common.reset')}
            >
              <Icon name="close" size={14} /> {t('common.reset')}
            </button>
          )}
        </div>

        <AnimatePresence mode="wait">
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <motion.div key="empty" className="empty" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="empty-icon"><Icon name="inbox" size={48} /></div>
              {t('app.empty')}
            </motion.div>
          ) : (
            <motion.div key="table" className="table-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('app.field.fullName')}</th><th>{t('app.field.phone')}</th><th>{t('app.field.direction')}</th><th>{t('app.field.manager')}</th><th>Источник</th><th>{t('common.status')}</th><th>{t('reports.col.date')}</th>
                  </tr>
                </thead>
                <motion.tbody
                  initial="hidden"
                  animate="show"
                  variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
                >
                  {pagedItems.map((a) => (
                    <motion.tr
                      key={a.id}
                      onClick={() => navigate(`/applications/${a.id}`)}
                      variants={{
                        hidden: { opacity: 0, x: -10 },
                        show: { opacity: 1, x: 0, transition: { duration: 0.25 } },
                      }}
                      whileHover={{ backgroundColor: 'rgba(0,0,0,0.02)', x: 2 }}
                      style={{ cursor: 'pointer' }}
                    >
                      <td><strong>{a.fullName}</strong></td>
                      <td>{a.phone}</td>
                      <td>{directionLabel(a.direction)}</td>
                      <td>
                        <div className="mgr-cell">
                          <div className="mgr-row">
                            <span className="mgr-tag tj">TJ</span>
                            {a.manager ? (
                              <span className={a.manager.id === me?.id ? 'mgr-mine' : 'mgr-other'}>
                                {a.manager.fullName}
                              </span>
                            ) : (
                              <span className="mgr-none">—</span>
                            )}
                          </div>
                          <div className="mgr-row">
                            <span className="mgr-tag cn">CN</span>
                            {a.chinaManager ? (
                              <span className={a.chinaManager.id === me?.id ? 'mgr-mine' : 'mgr-other'}>
                                {a.chinaManager.fullName}
                              </span>
                            ) : (
                              <span className="mgr-none">—</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        {/* fallback OTHER — если бэкенд когда-нибудь пришлёт заявку
                            без source (миграционные данные, dev-фикстуры), не
                            крашимся undefined-badge, а показываем нейтральный. */}
                        <span className={`badge ${SOURCE_BADGE[a.source ?? 'OTHER']}`}>
                          {SOURCE_LABEL[a.source ?? 'OTHER']}
                        </span>
                      </td>
                      <td><span className={`badge ${STATUS_BADGE[a.status]}`}>{statusLabel(a.status)}</span></td>
                      <td>{new Date(a.createdAt).toLocaleDateString('ru-RU')}</td>
                    </motion.tr>
                  ))}
                </motion.tbody>
              </table>
            </motion.div>
          )}
        </AnimatePresence>

        {!loading && (
          <Pagination
            page={page}
            total={items.length}
            pageSize={PAGE_SIZE}
            onChange={setPage}
          />
        )}
      </div>
    </motion.div>
  );
}
