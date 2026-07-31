import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listStudents } from '../api/students';
import { listUsers } from '../api/users';
import type { Direction } from '../api/types';
import { APPLICATION_STATUSES, DIRECTION_LABEL, STATUS_BADGE, STATUS_LABEL, STUDENT_STATUS_BADGE, STUDENT_STATUS_LABEL } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import { generateStudentsReport } from '../utils/studentsReport';
import DirectionOptions from '../components/DirectionOptions';
import Pagination from '../components/Pagination';
import CrmDatePicker from '../components/CrmDatePicker';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import Loading from '../components/Loading';
import { isElevated, isFounder } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useDirectionLabel, useStudentStatusLabel, useApplicationStatusLabel } from '../lib/labels';
import {
  boolParam,
  enumParam,
  ignoredParam,
  pageParam,
  stringParam,
  useUrlListState,
} from '../lib/useUrlListState';

type Scope = 'all' | 'mine';

// Клиентский фильтр по этапу/специальному статусу студента.
const SPECIAL_STUDENT_STATUSES = ['PAUSED', 'GRADUATED', 'ARCHIVED'];

/**
 * Белые списки для разбора URL. Дропдаун «этап/статус» смешивает два
 * перечисления, поэтому и фильтр принимает объединение: статусы заявки
 * (ключи STATUS_BADGE — Record<ApplicationStatus, string>, то есть enum
 * целиком, включая legacy: старая ссылка обязана работать, пока миграция
 * строк не доехала) плюс три «специальных» статуса студента.
 * Всё остальное при чтении URL молча падает в «без фильтра».
 */
const STAGE_FILTER_VALUES = [
  ...(Object.keys(STATUS_BADGE) as string[]),
  ...SPECIAL_STUDENT_STATUSES,
];
const DIRECTION_VALUES = Object.keys(DIRECTION_LABEL) as Direction[];
const CABINET_VALUES = ['1', '2', '3'] as const;

// Согласовано с Applications.tsx — 20 на страницу (демо-значение 5
// было удобно для скриншотов, но реальный CRM с базой студентов
// постоянно листал страницы).
const PAGE_SIZE = 20;

// Те же роли что и в Applications.tsx — менеджеры студентов это
// SALES_MANAGER (вёл лид) и CLIENT_MANAGER (ведёт зачисленного).
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'CLIENT_MANAGER']);

export default function Students() {
  const { t } = useT();
  const directionLabel = useDirectionLabel();
  const studentStatusLabel = useStudentStatusLabel();
  const appStatusLabel = useApplicationStatusLabel();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const { toast } = useUI();
  const qc = useQueryClient();
  const isAdmin = isElevated(me);
  const founder = isFounder(me);

  // Состояние списка — в query-string (см. lib/useUrlListState): клик по
  // строке уводит на карточку студента, список размонтируется, и «назад»
  // обязан вернуть ту же страницу с теми же фильтрами.
  const { values, setValue } = useUrlListState(
    {
      search: stringParam(),
      direction: enumParam(DIRECTION_VALUES),
      // В URL — просто `status`: для читающего ссылку это статус, а не
      // «stage», хотя внутри дропдаун смешивает этап заявки и статус студента.
      status: enumParam(STAGE_FILTER_VALUES),
      cabinet: enumParam(CABINET_VALUES),
      manager: isAdmin ? stringParam('', 64) : ignoredParam(''),
      scope: enumParam<Scope, Scope>(
        isAdmin ? (['all', 'mine'] as const) : (['mine'] as const),
        isAdmin ? 'all' : 'mine',
      ),
      // Отдельная вкладка «база студентов» по ТЗ — отображаются только
      // оплатившие (есть хотя бы одна TUITION_PAYMENT транзакция).
      paid: boolParam(false),
      page: pageParam(),
    },
    { pageKey: 'page' },
  );
  const {
    direction,
    status: stageFilter,
    cabinet,
    manager,
    scope,
    paid: paidOnly,
    page,
  } = values;
  const urlSearch = values.search;

  // Модалка отчёта — не состояние списка, в URL ей делать нечего.
  const [reportOpen, setReportOpen] = useState(false);
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [generating, setGenerating] = useState(false);

  // Инпут поиска локальный (мгновенный отклик), в URL уезжает только
  // «устаканившееся» значение — дебаунс те же 300 мс.
  const [searchInput, setSearchInput] = useState(urlSearch);

  // URL → инпут: «назад/вперёд» и переход по ссылке с фильтрами. Когда
  // значение записали мы сами, setState получает то же и ререндера нет.
  useEffect(() => {
    setSearchInput(urlSearch);
  }, [urlSearch]);

  // Инпут → URL, replace'ом: история не забивается на каждую букву.
  useEffect(() => {
    if (searchInput === urlSearch) return;
    const timer = setTimeout(() => setValue('search', searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput, urlSearch, setValue]);

  const filters = {
    search: urlSearch || undefined,
    direction: direction || undefined,
    cabinet: cabinet ? parseInt(cabinet, 10) : undefined,
    mine: scope === 'mine',
    manager: manager || undefined,
    paid: paidOnly ? true : undefined,
  };

  const studentsQuery = useQuery({
    queryKey: keys.students.list(filters),
    queryFn: () => listStudents(filters),
  });
  const items = studentsQuery.data ?? [];
  const loading = studentsQuery.isLoading;

  // Сброс страницы при смене любого фильтра делает сам useUrlListState
  // (pageKey): отдельным эффектом это было бы хуже — он срабатывает и на
  // монтировании, то есть затирал бы восстановленный из URL ?page=3.

  // Клиентский фильтр по этапу/специальному статусу.
  const filteredItems = stageFilter
    ? items.filter((s) => {
        if (SPECIAL_STUDENT_STATUSES.includes(stageFilter)) {
          return s.status === stageFilter;
        }
        if (s.status !== 'ACTIVE') return false;
        return s.applications?.[0]?.status === stageFilter;
      })
    : items;

  // Кламп страницы под сократившийся список. Только после успешной
  // загрузки: пока данных нет, filteredItems пуст, и наивный кламп сбросил
  // бы восстановленный из URL ?page=3 в единицу. replace — коррекция, а не
  // переход пользователя.
  useEffect(() => {
    if (!studentsQuery.isSuccess) return;
    const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
    if (page > totalPages) setValue('page', totalPages, { replace: true });
  }, [studentsQuery.isSuccess, filteredItems.length, page, setValue]);

  const pagedItems = filteredItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
    enabled: isAdmin,
  });
  // Дропдаун «менеджер» — только SALES_MANAGER/CLIENT_MANAGER, с учётом
  // мульти-ролей по ТЗ §2 (юзер с roles=[SALES_MANAGER, ADMIN] попадает).
  const users = (usersQuery.data ?? []).filter((u) => {
    const all = [u.role, ...((u as any).roles || [])].filter(Boolean);
    return all.some((r) => MANAGER_ROLES.has(r as string));
  });

  useRealtime({
    'student:updated': () => qc.invalidateQueries({ queryKey: keys.students.all }),
    'application:new': () => qc.invalidateQueries({ queryKey: keys.students.all }),
    'application:updated': () => qc.invalidateQueries({ queryKey: keys.students.all }),
  });

  const reportDatesValid =
    !!reportFrom && !!reportTo && new Date(reportFrom) <= new Date(reportTo);

  const onDownloadReport = async () => {
    if (!reportFrom || !reportTo) {
      toast(t('toast.error'), 'error');
      return;
    }
    if (new Date(reportFrom) > new Date(reportTo)) {
      toast(t('toast.error'), 'error');
      return;
    }
    setGenerating(true);
    try {
      const all = await listStudents({});
      const from = new Date(reportFrom + 'T00:00:00');
      const to = new Date(reportTo + 'T23:59:59');
      const filtered = all.filter((s) => {
        const d = new Date(s.createdAt);
        return d >= from && d <= to;
      });
      if (filtered.length === 0) {
        toast(t('common.empty'), 'error');
        setGenerating(false);
        return;
      }
      await generateStudentsReport({
        students: filtered,
        from: reportFrom,
        to: reportTo,
      });
      toast(`Отчёт сгенерирован (${filtered.length} студентов)`, 'success');
      setReportOpen(false);
      setReportFrom('');
      setReportTo('');
    } catch (e: any) {
      toast(e?.message || t('toast.error'), 'error');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="card-header">
        <h2 className="card-title">{t('students.title')}</h2>
        <div className="card-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {isAdmin && (
            <div className="scope-switch">
              <button
                className={`scope-btn${scope === 'mine' ? ' active' : ''}`}
                onClick={() => setValue('scope', 'mine')}
              >
                <Icon name="person" size={16} />
                Мои
              </button>
              <button
                className={`scope-btn${scope === 'all' ? ' active' : ''}`}
                onClick={() => setValue('scope', 'all')}
              >
                <Icon name="groups" size={16} />
                Все
              </button>
            </div>
          )}
          <motion.button
            className="btn btn-secondary"
            onClick={() => setReportOpen(true)}
            whileHover={{ scale: 1.05, y: -2 }}
            whileTap={{ scale: 0.95 }}
            title={t('common.download')}
          >
            <Icon name="description" size={16} style={{ marginRight: 4 }} />
            Отчёт Word
          </motion.button>
          {!founder && (
            <motion.button
              className="btn btn-primary"
              onClick={() => navigate('/students/new')}
              whileHover={{ scale: 1.05, y: -2 }}
              whileTap={{ scale: 0.95 }}
            >
              + {t('studentNew.title')}
            </motion.button>
          )}
        </div>
      </div>
      <div className="card-body">
        <div className="filters" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
          <input className="crm-input" style={{ flex: '1 1 200px' }} placeholder={t('common.search')} value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          <select className="crm-select" style={{ flex: '1 1 200px' }} value={direction} onChange={(e) => setValue('direction', e.target.value as Direction | '')}>
            <option value="">{t('app.filter.direction')}</option>
            <DirectionOptions />
          </select>
          <select
            className="crm-select"
            style={{ flex: '1 1 200px' }}
            value={stageFilter}
            onChange={(e) => setValue('status', e.target.value)}
            title={t('app.filter.status')}
          >
            <option value="">{t('app.filter.status')}</option>
            <optgroup label={t('app.field.stage')}>
              {APPLICATION_STATUSES.map((s) => (
                <option key={s} value={s}>{appStatusLabel(s)}</option>
              ))}
            </optgroup>
            <optgroup label={t('common.status')}>
              <option value="PAUSED">{studentStatusLabel('PAUSED' as any)}</option>
              <option value="GRADUATED">{studentStatusLabel('GRADUATED' as any)}</option>
              <option value="ARCHIVED">{studentStatusLabel('ARCHIVED' as any)}</option>
            </optgroup>
          </select>
          <select className="crm-select" style={{ flex: '1 1 200px' }} value={cabinet} onChange={(e) => setValue('cabinet', e.target.value as typeof CABINET_VALUES[number] | '')}>
            <option value="">{t('app.field.cabinet')}</option>
            <option value="1">{t('app.field.cabinet')} 1</option>
            <option value="2">{t('app.field.cabinet')} 2</option>
            <option value="3">{t('app.field.cabinet')} 3</option>
          </select>
          {isAdmin && (
            <select
              className="crm-select"
              style={{ flex: '1 1 200px' }}
              value={manager}
              onChange={(e) => setValue('manager', e.target.value)}
              title={t('app.filter.manager')}
            >
              <option value="">{t('app.filter.manager')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </select>
          )}
          {/* По ТЗ: «база студентов — только оплатившие». Отдельная вкладка. */}
          <label className="crm-checkbox-label" style={{ flex: '1 1 200px', whiteSpace: 'nowrap', minHeight: 38 }}>
            <input
              type="checkbox"
              className="crm-checkbox"
              checked={paidOnly}
              onChange={(e) => setValue('paid', e.target.checked)}
            />
            {t('students.paidOnly')}
          </label>
        </div>

        <AnimatePresence mode="wait">
          {loading ? (
            <Loading />
          ) : filteredItems.length === 0 ? (
            <motion.div key="empty" className="empty" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="empty-icon"><Icon name="school" size={48} /></div>
              {t('common.empty')}
            </motion.div>
          ) : (
            <motion.div key="table" className="table-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('app.field.fullName')}</th><th>{t('app.field.phones')}</th><th>{t('app.field.direction')}</th><th>{t('app.field.cabinet')}</th><th>{t('app.field.manager')}</th><th>{t('common.status')}</th>
                  </tr>
                </thead>
                <motion.tbody
                  initial="hidden"
                  animate="show"
                  variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
                >
                  {pagedItems.map((s) => (
                    <motion.tr
                      key={s.id}
                      onClick={() => navigate(`/students/${s.id}`)}
                      variants={{
                        hidden: { opacity: 0, x: -10 },
                        show: { opacity: 1, x: 0, transition: { duration: 0.25 } },
                      }}
                      whileHover={{ backgroundColor: 'rgba(0,0,0,0.02)', x: 2 }}
                      style={{ cursor: 'pointer' }}
                    >
                      <td><strong>{s.fullName}</strong></td>
                      <td>{s.phones.join(', ') || '—'}</td>
                      {/* directionConfirmed === false → студент сконвертирован
                          из заявки с лендинга, и в direction лежит плейсхолдер
                          бэкенда, а не выбор клиента. Печатать «Бакалавриат»
                          нельзя — вся колонка выглядела бы как ответы клиентов.
                          undefined (старый ответ API) считаем подтверждённым,
                          как @default(true) в схеме. */}
                      <td>
                        {s.directionConfirmed === false ? (
                          <span
                            style={{ color: 'var(--text-light)' }}
                            title={t('app.direction.unconfirmed')}
                          >
                            —
                          </span>
                        ) : (
                          directionLabel(s.direction)
                        )}
                      </td>
                      {/* Кабинет до подтверждения направления — «приёмник»
                          из конвертации, а не назначенная маршрутизация. */}
                      <td>
                        №{s.cabinet}
                        {s.directionConfirmed === false && (
                          <span style={{ color: 'var(--text-light)', fontSize: 12, marginLeft: 4 }} title={t('app.direction.unconfirmed')}>
                            ·&nbsp;{t('student.cabinet.pending')}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="mgr-cell">
                          <div className="mgr-row">
                            <span className="mgr-tag tj">TJ</span>
                            {s.manager ? (
                              <span className={s.manager.id === me?.id ? 'mgr-mine' : 'mgr-other'}>
                                {s.manager.fullName}
                              </span>
                            ) : (
                              <span className="mgr-none">—</span>
                            )}
                          </div>
                          <div className="mgr-row">
                            <span className="mgr-tag cn">CN</span>
                            {s.chinaManager ? (
                              <span className={s.chinaManager.id === me?.id ? 'mgr-mine' : 'mgr-other'}>
                                {s.chinaManager.fullName}
                              </span>
                            ) : (
                              <span className="mgr-none">—</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        {(() => {
                          const appStatus = s.applications?.[0]?.status;
                          if (s.status !== 'ACTIVE' || !appStatus) {
                            return (
                              <span className={`badge ${STUDENT_STATUS_BADGE[s.status]}`}>
                                {studentStatusLabel(s.status)}
                              </span>
                            );
                          }
                          return (
                            <span className={`badge ${STATUS_BADGE[appStatus]}`}>
                              {appStatusLabel(appStatus)}
                            </span>
                          );
                        })()}
                      </td>
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
            total={filteredItems.length}
            pageSize={PAGE_SIZE}
            onChange={(next) => setValue('page', next)}
          />
        )}
      </div>

      <AnimatePresence>
        {reportOpen && (
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !generating && setReportOpen(false)}
          >
            <motion.div
              className="dialog-card"
              style={{ maxWidth: 460 }}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.22 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-icon">
                <Icon name="description" size={28} />
              </div>
              <div className="dialog-title">{t('students.reportTitle')}</div>
              <div className="dialog-message">
                {t('students.reportHint')}
              </div>

              <div className="form-grid-2" style={{ textAlign: 'left', marginBottom: 20 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>{t('common.from')} *</label>
                  <CrmDatePicker
                    value={reportFrom}
                    max={reportTo || undefined}
                    onChange={(v) => setReportFrom(v)}
                  />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>{t('common.until')} *</label>
                  <CrmDatePicker
                    value={reportTo}
                    min={reportFrom || undefined}
                    onChange={(v) => setReportTo(v)}
                  />
                </div>
              </div>

              <div className="dialog-actions">
                <motion.button
                  className="btn btn-secondary"
                  onClick={() => setReportOpen(false)}
                  disabled={generating}
                  whileTap={{ scale: 0.97 }}
                >
                  {t('common.cancel')}
                </motion.button>
                <motion.button
                  className="btn btn-primary"
                  onClick={onDownloadReport}
                  disabled={generating || !reportDatesValid}
                  whileTap={{ scale: 0.97 }}
                  style={!reportDatesValid && !generating ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  title={t('common.download')}
                >
                  {generating ? t('common.saving') : t('common.download')}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
