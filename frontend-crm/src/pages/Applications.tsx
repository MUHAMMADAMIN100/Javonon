import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listApplications } from '../api/applications';
import { listUsers } from '../api/users';
import type { ApplicationSource, ApplicationStatus, Country, Direction } from '../api/types';
import {
  APPLICATION_SOURCES,
  APPLICATION_STATUSES,
  COUNTRIES,
  DIRECTION_LABEL,
  SOURCE_BADGE,
  SOURCE_LABEL,
  STATUS_BADGE,
} from '../api/types';
import { useAuth } from '../store/auth';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import DirectionOptions from '../components/DirectionOptions';
import Pagination from '../components/Pagination';
import { keys } from '../lib/queryKeys';
import Loading from '../components/Loading';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useDirectionLabel, useApplicationStatusLabel, useCountryLabel } from '../lib/labels';
import {
  enumParam,
  ignoredParam,
  pageParam,
  stringParam,
  useUrlListState,
} from '../lib/useUrlListState';

type Scope = 'all' | 'mine';

/**
 * Белые списки для разбора `?status=` / `?direction=` из URL.
 *
 * Для статуса берём ключи STATUS_BADGE (Record<ApplicationStatus, string>,
 * то есть перечисление целиком), а не APPLICATION_STATUSES: в дропдауне
 * предлагаются только актуальные 10 исходов, но ссылка/закладка вида
 * `?status=ENROLLED` обязана продолжать работать, пока миграция строк не
 * доехала и API реально отдаёт legacy-значения. Новые статусы список
 * подхватывает сам — тип заставляет STATUS_BADGE быть полным.
 * Всё, чего в списках нет, при чтении URL молча падает в «без фильтра».
 */
const APPLICATION_STATUS_VALUES = Object.keys(STATUS_BADGE) as ApplicationStatus[];
const DIRECTION_VALUES = Object.keys(DIRECTION_LABEL) as Direction[];

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
  const countryLabel = useCountryLabel();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const isAdmin = isElevated(me);

  // Всё состояние списка — в query-string (см. lib/useUrlListState).
  // useState здесь не годится: клик по строке уводит на карточку заявки,
  // список размонтируется, и «назад» возвращал бы первую страницу без
  // фильтров. Заодно выборка переживает F5 и шарится ссылкой.
  const { values, setValue, reset } = useUrlListState(
    {
      search: stringParam(),
      status: enumParam(APPLICATION_STATUS_VALUES),
      direction: enumParam(DIRECTION_VALUES),
      country: enumParam(COUNTRIES),
      source: enumParam(APPLICATION_SOURCES),
      // id менеджера белым списком не проверить — пользователи грузятся
      // асинхронно. Ограничиваем длину; неизвестный id бэкенд отдаст
      // пустым списком, а не ошибкой (User.id — обычная String-колонка).
      manager: isAdmin ? stringParam('', 64) : ignoredParam(''),
      // Менеджер видит только свои заявки; админ может переключать.
      // Дефолт зависит от роли и потому в URL не пишется: чистый
      // /applications у админа значит «все», у менеджера — «мои».
      scope: enumParam<Scope, Scope>(
        isAdmin ? (['all', 'mine'] as const) : (['mine'] as const),
        isAdmin ? 'all' : 'mine',
      ),
      page: pageParam(),
    },
    { pageKey: 'page' },
  );
  const { status, direction, country, source, manager, scope, page } = values;
  const urlSearch = values.search;

  // Инпут поиска держим локально: буквы обязаны появляться мгновенно, а в
  // URL уезжает только «устаканившееся» значение. Дебаунс тот же, 300 мс.
  const [searchInput, setSearchInput] = useState(urlSearch);

  // URL → инпут. Срабатывает на «назад/вперёд», на «Сбросить» и на переход
  // по ссылке с фильтрами. Если значение в URL записали мы сами, setState
  // получает то же самое и React ререндер не делает.
  useEffect(() => {
    setSearchInput(urlSearch);
  }, [urlSearch]);

  // Инпут → URL. Запись идёт replace'ом (см. useUrlListState), поэтому
  // история не забивается на каждую букву. setValue стабилен, так что
  // таймер перезапускает только реальный ввод.
  useEffect(() => {
    if (searchInput === urlSearch) return;
    const timer = setTimeout(() => setValue('search', searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput, urlSearch, setValue]);

  const filters = {
    search: urlSearch || undefined,
    status: status || undefined,
    direction: direction || undefined,
    country: country || undefined,
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
  // Ждём успешной загрузки: пока данных нет, items.length === 0, и наивный
  // кламп сбросил бы восстановленный из URL ?page=3 в единицу — ровно тот
  // баг, ради которого состояние и переехало в URL. replace: true — это
  // техническая коррекция, а не переход, в истории ей не место.
  useEffect(() => {
    if (!appsQuery.isSuccess) return;
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (page > totalPages) setValue('page', totalPages, { replace: true });
  }, [appsQuery.isSuccess, items.length, page, setValue]);

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
              onClick={() => setValue('scope', 'mine')}
            >
              <Icon name="person" size={16} />
              {t('scope.mine')}
            </button>
            <button
              className={`scope-btn${scope === 'all' ? ' active' : ''}`}
              onClick={() => setValue('scope', 'all')}
            >
              <Icon name="groups" size={16} />
              {t('common.all')}
            </button>
          </div>
        )}
      </div>
      <div className="card-body">
        <div className="filters">
          <input className="crm-input" placeholder={t('common.search')} value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          <select className="crm-select" value={status} onChange={(e) => setValue('status', e.target.value as ApplicationStatus | '')}>
            <option value="">{t('app.filter.status')}</option>
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
          {isAdmin && (
            <select className="crm-select" value={manager} onChange={(e) => setValue('manager', e.target.value)} title={t('app.filter.manager')}>
              <option value="">{t('app.filter.manager')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </select>
          )}
          <select className="crm-select" value={direction} onChange={(e) => setValue('direction', e.target.value as Direction | '')}>
            <option value="">{t('app.filter.direction')}</option>
            <DirectionOptions />
          </select>
          <select
            className="crm-select"
            value={source}
            onChange={(e) => setValue('source', e.target.value as ApplicationSource | '')}
            title={t('app.field.source')}
          >
            <option value="">{t('app.filter.source')}</option>
            {APPLICATION_SOURCES.map((s) => (
              <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
            ))}
          </select>
          <select
            className="crm-select"
            value={country}
            onChange={(e) => setValue('country', e.target.value as Country | '')}
            title={t('app.field.country')}
          >
            <option value="">{t('app.filter.country')}</option>
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>{countryLabel(c)}</option>
            ))}
          </select>
          {(searchInput || status || direction || manager || source || country) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                // Инпут гасим сразу и вручную: иначе недобежавший дебаунс
                // (успели нажать «Сбросить» раньше 300 мс) через мгновение
                // вернул бы текст обратно в URL.
                setSearchInput('');
                // scope не трогаем — как и раньше: «Мои/Все» это не фильтр
                // выборки, а режим просмотра. Страницу reset() сбрасывает сам.
                reset(['search', 'status', 'direction', 'manager', 'source', 'country']);
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
                    <th>{t('app.field.fullName')}</th><th>{t('app.field.phone')}</th><th>{t('app.field.country')}</th><th>{t('app.field.direction')}</th><th>{t('app.field.manager')}</th><th>{t('app.field.source')}</th><th>{t('common.status')}</th><th>{t('reports.col.date')}</th>
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
                      <td>
                        {/* Страна есть только у заявок с новой формы лендинга.
                            Старые заявки и всё, что заведено в обход формы
                            (ручное создание в CRM, самозапись, approve заявки
                            партнёра), её не заполняют — показываем нейтральный
                            прочерк, а не пустую/«undefined» плашку. */}
                        {a.country ? (
                          <span className="badge badge-gray">{countryLabel(a.country)}</span>
                        ) : (
                          <span style={{ color: 'var(--text-light)' }}>—</span>
                        )}
                      </td>
                      <td>
                        {/* directionConfirmed === false → в direction лежит
                            плейсхолдер бэкенда, а не выбор клиента: форма
                            лендинга направление не спрашивает. Рисуем прочерк,
                            иначе вся колонка была бы «Бакалавриат» и менеджер
                            принимал бы её за ответ. undefined (старый ответ
                            API) считаем подтверждённым — как @default(true). */}
                        {a.directionConfirmed === false ? (
                          <span
                            style={{ color: 'var(--text-light)' }}
                            title={t('app.direction.unconfirmed')}
                          >
                            —
                          </span>
                        ) : (
                          directionLabel(a.direction)
                        )}
                      </td>
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
            onChange={(next) => setValue('page', next)}
          />
        )}
      </div>
    </motion.div>
  );
}
