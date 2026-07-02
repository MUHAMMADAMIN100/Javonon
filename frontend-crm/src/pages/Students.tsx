import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listStudents } from '../api/students';
import { listUsers } from '../api/users';
import type { Direction } from '../api/types';
import { DIRECTION_LABEL, STATUS_BADGE, STATUS_LABEL, STUDENT_STATUS_BADGE, STUDENT_STATUS_LABEL } from '../api/types';
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

type Scope = 'all' | 'mine';

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
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [direction, setDirection] = useState<Direction | ''>('');
  const [stageFilter, setStageFilter] = useState<string>('');
  const [cabinet, setCabinet] = useState('');
  const [manager, setManager] = useState<string>('');
  const isAdmin = isElevated(me);
  const founder = isFounder(me);
  const [scope, setScope] = useState<Scope>(isAdmin ? 'all' : 'mine');
  // Отдельная вкладка «база студентов» по ТЗ — отображаются только
  // оплатившие (есть хотя бы одна TUITION_PAYMENT транзакция).
  const [paidOnly, setPaidOnly] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [generating, setGenerating] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters = {
    search: debouncedSearch || undefined,
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

  // Сброс страницы при смене любого фильтра.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, direction, cabinet, scope, manager, stageFilter, paidOnly]);

  // Клиентский фильтр по этапу/специальному статусу.
  const SPECIAL_STUDENT_STATUSES = ['PAUSED', 'GRADUATED', 'ARCHIVED'];
  const filteredItems = stageFilter
    ? items.filter((s) => {
        if (SPECIAL_STUDENT_STATUSES.includes(stageFilter)) {
          return s.status === stageFilter;
        }
        if (s.status !== 'ACTIVE') return false;
        return s.applications?.[0]?.status === stageFilter;
      })
    : items;

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [filteredItems.length, page]);

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
          <input className="crm-input" style={{ flex: '1 1 200px' }} placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="crm-select" style={{ flex: '1 1 200px' }} value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="">{t('app.filter.direction')}</option>
            <DirectionOptions />
          </select>
          <select
            className="crm-select"
            style={{ flex: '1 1 200px' }}
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            title={t('app.filter.status')}
          >
            <option value="">{t('app.filter.status')}</option>
            <optgroup label={t('app.field.stage')}>
              <option value="NEW">{appStatusLabel('NEW' as any)}</option>
              <option value="DOCS_REVIEW">{appStatusLabel('DOCS_REVIEW' as any)}</option>
              <option value="DOCS_SUBMITTED">{appStatusLabel('DOCS_SUBMITTED' as any)}</option>
              <option value="PRE_ADMISSION">{appStatusLabel('PRE_ADMISSION' as any)}</option>
              <option value="AWAITING_PAYMENT">{appStatusLabel('AWAITING_PAYMENT' as any)}</option>
              <option value="ENROLLED">{appStatusLabel('ENROLLED' as any)}</option>
            </optgroup>
            <optgroup label={t('common.status')}>
              <option value="PAUSED">{studentStatusLabel('PAUSED' as any)}</option>
              <option value="GRADUATED">{studentStatusLabel('GRADUATED' as any)}</option>
              <option value="ARCHIVED">{studentStatusLabel('ARCHIVED' as any)}</option>
            </optgroup>
          </select>
          <select className="crm-select" style={{ flex: '1 1 200px' }} value={cabinet} onChange={(e) => setCabinet(e.target.value)}>
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
              onChange={(e) => setManager(e.target.value)}
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
              onChange={(e) => setPaidOnly(e.target.checked)}
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
                      <td>{directionLabel(s.direction)}</td>
                      <td>№{s.cabinet}</td>
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
            onChange={setPage}
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
