import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listApplications } from '../api/applications';
import { listUsers } from '../api/users';
import type { ApplicationStatus, Direction } from '../api/types';
import { DIRECTION_LABEL, STATUS_BADGE, STATUS_LABEL } from '../api/types';
import { useAuth } from '../store/auth';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import DirectionOptions from '../components/DirectionOptions';
import Pagination from '../components/Pagination';
import { keys } from '../lib/queryKeys';
import Loading from '../components/Loading';

type Scope = 'all' | 'mine';

const PAGE_SIZE = 5;

export default function Applications() {
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<ApplicationStatus | ''>('');
  const [direction, setDirection] = useState<Direction | ''>('');
  const [manager, setManager] = useState<string>('');
  const isAdmin = me?.role === 'ADMIN';
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
  }, [debouncedSearch, status, direction, scope, manager]);

  const filters = {
    search: debouncedSearch || undefined,
    status: status || undefined,
    direction: direction || undefined,
    mine: scope === 'mine',
    manager: manager || undefined,
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
  const users = usersQuery.data ?? [];

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
        <h2 className="card-title">Заявки</h2>
        {isAdmin && (
          <div className="scope-switch">
            <button
              className={`scope-btn${scope === 'mine' ? ' active' : ''}`}
              onClick={() => setScope('mine')}
            >
              <Icon name="person" size={16} />
              Мои
            </button>
            <button
              className={`scope-btn${scope === 'all' ? ' active' : ''}`}
              onClick={() => setScope('all')}
            >
              <Icon name="groups" size={16} />
              Все
            </button>
          </div>
        )}
      </div>
      <div className="card-body">
        <div className="filters">
          <input placeholder="Поиск по ФИО, телефону, email..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value as any)}>
            <option value="">Все статусы</option>
            <option value="NEW">Новая заявка</option>
            <option value="DOCS_REVIEW">Документы на проверке</option>
            <option value="DOCS_SUBMITTED">Подача документов</option>
            <option value="PRE_ADMISSION">Предварительное зачисление</option>
            <option value="AWAITING_PAYMENT">Ожидание оплаты</option>
            <option value="ENROLLED">Зачислен</option>
          </select>
          {isAdmin && (
            <select value={manager} onChange={(e) => setManager(e.target.value)} title="Фильтр по менеджеру">
              <option value="">Все менеджеры</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </select>
          )}
          <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="">Все направления</option>
            <DirectionOptions />
          </select>
        </div>

        <AnimatePresence mode="wait">
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <motion.div key="empty" className="empty" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="empty-icon"><Icon name="inbox" size={48} /></div>
              {scope === 'mine' ? 'У вас пока нет назначенных заявок' : 'Заявок не найдено'}
            </motion.div>
          ) : (
            <motion.div key="table" className="table-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>ФИО</th><th>Телефон</th><th>Направление</th><th>Менеджер</th><th>Статус</th><th>Дата</th>
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
                      <td data-label="Телефон">{a.phone}</td>
                      <td data-label="Направление">{DIRECTION_LABEL[a.direction]}</td>
                      <td data-label="Менеджеры">
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
                      <td data-label="Статус"><span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABEL[a.status]}</span></td>
                      <td data-label="Дата">{new Date(a.createdAt).toLocaleDateString('ru-RU')}</td>
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
