import { fmtDateText, TJ_TZ } from '../lib/tjTime';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import CrmSelect from '../components/CrmSelect';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createTask, deleteTask, listTasks, updateTask } from '../api/tasks';
import { listUsers } from '../api/users';
import type { Role, Task, TaskStatus } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import { compose, hasErrors, maxLen, minLen, required, validateAll } from '../utils/validators';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import Loading from '../components/Loading';
import ListTotal from '../components/ListTotal';
import SearchField from '../components/SearchField';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import CrmDatePicker from '../components/CrmDatePicker';
import { hasRole, isElevated, displayRoleLabel } from '../lib/roles';
import { useT } from '../lib/i18n';

type Scope = 'all' | 'mine';
/** Значение фильтра «Исполнитель» для задач, которые ещё никому не назначены. */
const NO_ASSIGNEE = 'none';

export default function Tasks() {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const isAdmin = isElevated(me);
  // Удалять — как на сервере (tasks.service remove): основатель и администратор.
  const canDelete = hasRole(me, 'FOUNDER', 'ADMIN');
  const [scope, setScope] = useState<Scope>(isAdmin ? 'all' : 'mine');
  // Фильтры — в адресе страницы (?status=&assignee=): переживают обновление и ссылку.
  const [params, setParams] = useSearchParams();
  const statusFilter = (params.get('status') || '') as TaskStatus | '';
  // Исполнитель — только в режиме «Все»: в «Моих» и так только мои задачи.
  const assigneeFilter = scope === 'all' ? params.get('assignee') || '' : '';
  const setFilter = (key: 'status' | 'assignee', value: string) => {
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    description: string;
    assigneeIds: string[];
    controllerId: string;
    deadline: string;
  }>({ title: '', description: '', assigneeIds: [], controllerId: '', deadline: '' });
  // Отдельный selector для «добавить исполнителя» — сам список хранится в form.assigneeIds.
  const [assigneePicker, setAssigneePicker] = useState('');

  // Дебаунс поиска: 300ms — чтобы не дёргать сервер на каждое нажатие.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const listKey = keys.tasks.list({ mine: scope === 'mine', search: debouncedSearch || undefined });
  const tasksQuery = useQuery({
    queryKey: listKey,
    queryFn: () => listTasks(scope === 'mine', debouncedSearch || undefined),
  });
  const items = tasksQuery.data ?? [];
  const loading = tasksQuery.isLoading;
  const assignedTo = (task: Task, userId: string) =>
    (task.assignees ?? []).some((a) => a.id === userId) || task.assignedToId === userId;
  const hasAssignee = (task: Task) => (task.assignees ?? []).length > 0 || !!task.assignedToId;
  const shown = items.filter((task) =>
    (!statusFilter || task.status === statusFilter)
    && (!assigneeFilter
      || (assigneeFilter === NO_ASSIGNEE ? !hasAssignee(task) : assignedTo(task, assigneeFilter))));
  // Всего задач без поиска — для «Найдено: X из N» (тот же кэш, что и список без поиска).
  const allQuery = useQuery({
    queryKey: keys.tasks.list({ mine: scope === 'mine', search: undefined }),
    queryFn: () => listTasks(scope === 'mine', undefined),
    enabled: !!debouncedSearch,
  });
  const narrowed = !!debouncedSearch || !!statusFilter || !!assigneeFilter;
  // «Найдено X из N»: N — все задачи этого режима, без поиска и фильтров.
  const totalAll = debouncedSearch ? allQuery.data?.length : items.length;

  /** Открытая в окне задача (id — чтобы окно видело свежие данные списка). */
  const [openId, setOpenId] = useState<string | null>(null);
  const openTask = items.find((x) => x.id === openId) ?? null;
  const canChangeTask = (task: Task) =>
    isAdmin ||
    (!!me &&
      // Исполнители приходят списком assignees (assigneeIds API не отдаёт);
      // assignedToId — старое поле одного исполнителя.
      ((task.assignees ?? []).some((a) => a.id === me.id) ||
        task.assignedToId === me.id ||
        task.controllerId === me.id));

  const sort = useTableSort(shown, [
    { key: 'title', label: t('task.col.task'), value: (x) => x.title },
    { key: 'assignee', label: t('task.assignee'), value: (x) => (x.assignees ?? []).map((a) => a.fullName).join(', ') || null },
    { key: 'controller', label: t('task.controller'), value: (x) => x.controller?.fullName ?? null },
    { key: 'author', label: t('task.author'), value: (x) => x.createdBy?.fullName ?? null },
    { key: 'deadline', label: t('task.deadline'), type: 'date', value: (x) => x.deadline ?? null },
    { key: 'createdAt', label: t('task.created'), type: 'date', value: (x) => x.createdAt },
    { key: 'status', label: t('common.status'), type: 'number', value: (x) => STATUS_ORDER[x.status] },
  ]);

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
    enabled: isAdmin,
  });
  const users = usersQuery.data ?? [];

  // Realtime → инвалидируем кеш, TanStack сам перечитает.
  useRealtime({
    'task:new': () => qc.invalidateQueries({ queryKey: keys.tasks.all }),
    'task:updated': () => qc.invalidateQueries({ queryKey: keys.tasks.all }),
    'task:deleted': () => qc.invalidateQueries({ queryKey: keys.tasks.all }),
  });

  // CREATE — серверный id auto-gen, поэтому без оптимистики (только invalidate).
  const createMut = useInvalidatingMutation({
    mutationFn: createTask,
    invalidate: [keys.tasks.all, keys.tasks.stats()],
    onSuccess: () => {
      toast(t('tasks.toast.created'), 'success');
      setForm({ title: '', description: '', assigneeIds: [], controllerId: '', deadline: '' });
      setAssigneePicker('');
      setCreating(false);
    },
    onError: (err: any) => toast(err?.response?.data?.message || t('tasks.toast.createError'), 'error'),
  });

  // UPDATE STATUS — горячий UX, делаем оптимистично (мгновенное переключение).
  const updateMut = useOptimisticMutation<Task, { id: string; patch: Parameters<typeof updateTask>[1] }, Task[]>({
    mutationFn: ({ id, patch }) => updateTask(id, patch),
    queryKey: listKey,
    applyOptimistic: (cur, { id, patch }) => optimistic.updateById(cur, id, patch as Partial<Task>),
    invalidateAlso: [keys.tasks.stats()],
    onError: (err: any) => toast(err?.response?.data?.message || t('toast.error'), 'error'),
  });

  // DELETE — оптимистично убираем из списка.
  const deleteMut = useOptimisticMutation<unknown, string, Task[]>({
    mutationFn: deleteTask,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.tasks.stats()],
    onSuccess: () => toast(t('tasks.toast.deleted'), 'success'),
    onError: (err: any) => toast(err?.response?.data?.message || t('tasks.toast.deleteError'), 'error'),
  });

  const formErrors = validateAll(
    { title: form.title, description: form.description },
    {
      title: compose(required(t('tasks.err.title')), minLen(3, t('tasks.err.min3')), maxLen(200)),
      description: compose(required(t('tasks.err.description')), minLen(5, t('tasks.err.min5')), maxLen(2000)),
    },
  );
  // assigneeIds валидируем отдельно: массив, а validateAll работает со строками.
  const assigneesError = form.assigneeIds.length === 0 ? t('tasks.err.assignees') : '';
  const formInvalid = hasErrors(formErrors) || !!assigneesError;

  // Пока поле не трогали — ошибку по нему не показываем. Проверка сама по
  // себе остаётся: кнопка «Создать» выключена, и при попытке отправки
  // подсветятся все незаполненные поля сразу.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (field: string) => setTouched((t) => ({ ...t, [field]: true }));
  const errorOf = (field: string, message?: string) => (touched[field] ? message || '' : '');

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ title: true, description: true, assignees: true });
    if (formInvalid) {
      toast(t('tasks.err.fillAll'), 'error');
      return;
    }
    createMut.mutate({
      title: form.title.trim(),
      description: form.description.trim(),
      assigneeIds: form.assigneeIds,
      controllerId: form.controllerId || null,
      deadline: form.deadline || undefined,
    });
  };
  const addAssignee = (id: string) => {
    if (!id || form.assigneeIds.includes(id)) return;
    setForm((f) => ({ ...f, assigneeIds: [...f.assigneeIds, id] }));
    setAssigneePicker('');
  };
  const removeAssignee = (id: string) => {
    setForm((f) => ({ ...f, assigneeIds: f.assigneeIds.filter((x) => x !== id) }));
  };
  const userById = (id: string) => users.find((u) => u.id === id);
  const submitting = createMut.isPending;

  const setStatus = (task: Task, next: TaskStatus) => {
    if (task.status === next) return;
    if (next === 'DONE') toast(t('tasks.toast.done'), 'success');
    else if (next === 'IN_PROGRESS') toast(t('tasks.toast.inProgress'), 'success');
    else toast(t('tasks.toast.todo'), 'info');
    updateMut.mutate({ id: task.id, patch: { status: next } });
  };

  const onDelete = async (task: Task) => {
    const ok = await confirm({
      title: t('common.delete') + ' ' + t('tasks.title').toLowerCase(),
      message: `«${task.title}»`,
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    setOpenId((cur) => (cur === task.id ? null : cur));
    deleteMut.mutate(task.id);
  };

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="card-header is-titleless">
        <ListTotal
          noun="tasks"
          found={shown.length}
          total={narrowed ? totalAll : undefined}
          filtered={narrowed}
          testId="tasks-total"
        />
        <div className="card-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
          {isAdmin && !creating && (
            <motion.button
              className="btn btn-primary"
              data-testid="task-new"
              onClick={() => setCreating(true)}
              whileHover={{ scale: 1.05, y: -2 }}
              whileTap={{ scale: 0.95 }}
            >
              <Icon name="add" size={16} style={{ marginRight: 4 }} />
              {t('tasks.new')}
            </motion.button>
          )}
        </div>
      </div>

      <div className="card-body">
        <div className="filters">
          <CrmSelect
            className="crm-select"
            value={statusFilter}
            onChange={(e) => setFilter('status', e.target.value)}
            title={t('common.status')}
            data-testid="tasks-filter-status"
          >
            <option value="">{t('tasks.filter.allStatuses')}</option>
            <option value="TODO">{t('task.status.TODO')}</option>
            <option value="IN_PROGRESS">{t('task.status.IN_PROGRESS')}</option>
            <option value="DONE">{t('task.status.DONE')}</option>
          </CrmSelect>
          {scope === 'all' && (
            <CrmSelect
              className="crm-select"
              value={assigneeFilter}
              onChange={(e) => setFilter('assignee', e.target.value)}
              title={t('task.assignee')}
              data-testid="tasks-filter-assignee"
            >
              <option value="">{t('tasks.filter.allAssignees')}</option>
              <option value={NO_ASSIGNEE}>{t('tasks.filter.noAssignee')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </CrmSelect>
          )}
          <SearchField
            value={search}
            onChange={setSearch}
            onClear={() => { setSearch(''); setDebouncedSearch(''); }}
            placeholder={t('tasks.searchPlaceholder')}
            testId="tasks-search"
          />
          {(statusFilter || assigneeFilter || search) && (
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="tasks-filter-reset"
              onClick={() => {
                setSearch('');
                setDebouncedSearch('');
                setParams((cur) => {
                  const next = new URLSearchParams(cur);
                  next.delete('status');
                  next.delete('assignee');
                  return next;
                }, { replace: true });
              }}
            >
              <Icon name="close" size={14} /> {t('common.reset')}
            </button>
          )}
        </div>
        <AnimatePresence>
          {creating && isAdmin && (
            <FormModal
              open
              title={t('tasks.new')}
              onClose={() => { setCreating(false); setTouched({}); }}
              busy={submitting}
              testId="task-form"
            >
            <form onSubmit={onCreate}>
              <div className="form-group">
                <label>{t('tasks.field.title')} *</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder={t('tasks.ph.title')}
                  maxLength={200}
                  className={`crm-input${errorOf('title', formErrors.title) ? ' input-error' : ''}`}
                  onBlur={() => touch('title')}
                  required
                />
                {errorOf('title', formErrors.title) && <div className="form-error-text">{formErrors.title}</div>}
              </div>
              <div className="form-group">
                <label>{t('tasks.field.description')} *</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={t('tasks.ph.description')}
                  maxLength={2000}
                  className={`crm-textarea${errorOf('description', formErrors.description) ? ' input-error' : ''}`}
                  onBlur={() => touch('description')}
                  required
                  rows={4}
                />
                {errorOf('description', formErrors.description) && <div className="form-error-text">{formErrors.description}</div>}
              </div>
              <div className="form-group">
                <label>{t('tasks.assignees')} *</label>
                {form.assigneeIds.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      marginBottom: 8,
                    }}
                  >
                    {form.assigneeIds.map((id) => {
                      const u = userById(id);
                      return (
                        <span
                          key={id}
                          className="badge badge-info"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '4px 8px',
                            borderRadius: 999,
                          }}
                        >
                          <Icon name="person" size={12} />
                          {u ? u.fullName : id}
                          <button
                            type="button"
                            onClick={() => removeAssignee(id)}
                            aria-label={t('tasks.remove')}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              padding: 0,
                              display: 'inline-flex',
                              color: 'inherit',
                            }}
                          >
                            <Icon name="close" size={14} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <CrmSelect
                  className={`crm-select${errorOf('assignees', assigneesError) ? ' input-error' : ''}`}
                  onBlur={() => touch('assignees')}
                  value={assigneePicker}
                  onChange={(e) => addAssignee(e.target.value)}
                >
                  <option value="">
                    {form.assigneeIds.length === 0
                      ? t('tasks.pickEmployee')
                      : t('tasks.addEmployee')}
                  </option>
                  {users
                    .filter((u) => !form.assigneeIds.includes(u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.fullName} · {displayRoleLabel(u as any)}
                      </option>
                    ))}
                </CrmSelect>
                {errorOf('assignees', assigneesError) && <div className="form-error-text">{assigneesError}</div>}
              </div>
              <div className="form-group">
                <label>{t('tasks.controller')}</label>
                <CrmSelect
                  className="crm-select"
                  value={form.controllerId}
                  onChange={(e) => setForm({ ...form, controllerId: e.target.value })}
                >
                  <option value="">{t('tasks.pickController')}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName} · {displayRoleLabel(u as any)}
                    </option>
                  ))}
                </CrmSelect>
              </div>
              <div className="form-group">
                <label>{t('tasks.field.deadline')}</label>
                <CrmDatePicker
                  className="crm-input"
                  value={form.deadline}
                  onChange={(v) => setForm({ ...form, deadline: v })}
                  showTime
                />
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setCreating(false);
                    setForm({ title: '', description: '', assigneeIds: [], controllerId: '', deadline: '' });
                    setAssigneePicker('');
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting || formInvalid}
                  title={formInvalid ? t('programs.fixErrors') : ''}
                >
                  {submitting ? t('tasks.creating') : t('common.create')}
                </button>
              </div>
            </form>
            </FormModal>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {loading ? (
            <Loading />
          ) : shown.length === 0 ? (
            <motion.div key="empty" className="empty" data-testid="tasks-empty" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="empty-icon"><Icon name="task_alt" size={48} /></div>
              {items.length > 0 ? t('tasks.empty.filtered') : scope === 'mine' ? t('tasks.empty.mine') : t('tasks.empty.all')}
            </motion.div>
          ) : (
            <motion.div key="table" className="table-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <SortSelect sort={sort} />
              <table className="table tasks-table" data-testid="tasks-table">
                <thead>
                  <tr>
                    {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
                    {canDelete && <th aria-label={t('common.delete')} />}
                  </tr>
                </thead>
                <tbody>
                  {sort.sorted.map((task) => (
                    <tr
                      key={task.id}
                      className={`task-row is-${task.status.toLowerCase()}`}
                      onClick={() => setOpenId(task.id)}
                      data-testid="task-row"
                    >
                      <td className="task-cell-main">
                        <div className="task-row-title">{task.title}</div>
                        {task.description && <div className="task-row-desc">{task.description}</div>}
                      </td>
                      <td data-label={t('task.assignee')}>
                        {(task.assignees ?? []).length > 0
                          ? task.assignees!.map((a) => a.fullName).join(', ')
                          : <span className="task-empty">—</span>}
                      </td>
                      <td data-label={t('task.controller')}>{task.controller?.fullName ?? <span className="task-empty">—</span>}</td>
                      <td data-label={t('task.author')}>{task.createdBy?.fullName ?? <span className="task-empty">—</span>}</td>
                      <td data-label={t('task.deadline')}>
                        {task.deadline ? <DeadlineBadge deadline={task.deadline} status={task.status} /> : <span className="task-empty">—</span>}
                      </td>
                      <td data-label={t('task.created')}>{new Date(task.createdAt).toLocaleDateString('ru-RU')}</td>
                      {/* Выпадающий список рисуется порталом, но события React идут
                          по дереву — без stopPropagation выбор статуса открывал бы окно. */}
                      <td data-label={t('common.status')} className="task-cell-status" onClick={(e) => e.stopPropagation()}>
                        <TaskStatusSelect task={task} canChange={canChangeTask(task)} onChange={(next) => setStatus(task, next)} />
                      </td>
                      {canDelete && (
                        <td className="task-cell-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="task-delete-btn"
                            onClick={() => onDelete(task)}
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                          >
                            <Icon name="delete" size={18} />
                            {/* Подпись видна только в карточке на телефоне (index.css). */}
                            <span className="task-delete-label">{t('common.delete')}</span>
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {openTask && (
          <TaskModal
            task={openTask}
            canChange={canChangeTask(openTask)}
            canDelete={canDelete}
            onStatus={(next) => setStatus(openTask, next)}
            onDelete={async () => {
              await onDelete(openTask);
            }}
            onClose={() => setOpenId(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Порядок статусов для сортировки колонки «Статус». */
const STATUS_ORDER: Record<TaskStatus, number> = { TODO: 0, IN_PROGRESS: 1, DONE: 2 };

/** Срок: красный — просрочен, жёлтый — меньше суток, у выполненной — обычный. */
function DeadlineBadge({ deadline, status }: { deadline: string; status: TaskStatus }) {
  const dl = new Date(deadline);
  const ms = dl.getTime() - Date.now();
  const isOverdue = ms < 0 && status !== 'DONE';
  const isSoon = ms >= 0 && ms < 24 * 60 * 60 * 1000 && status !== 'DONE';
  const cls = isOverdue ? 'badge-danger' : isSoon ? 'badge-warning' : 'badge-info';
  return (
    <span className={`badge ${cls} task-deadline`} data-testid="task-deadline">
      {fmtDateText(dl, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TJ_TZ })}
    </span>
  );
}

/** Статус — цветная плашка с выпадающим списком (как статус заявки). */
function TaskStatusSelect({ task, canChange, onChange }: { task: Task; canChange: boolean; onChange: (s: TaskStatus) => void }) {
  const { t } = useT();
  return (
    <CrmSelect
      className={`crm-select task-status-select is-${task.status.toLowerCase()}`}
      value={task.status}
      onChange={(e) => onChange(e.target.value as TaskStatus)}
      disabled={!canChange}
      title={canChange ? t('common.status') : t('task.statusLocked')}
      data-testid="task-status"
    >
      <option value="TODO">{t('task.status.TODO')}</option>
      <option value="IN_PROGRESS">{t('task.status.IN_PROGRESS')}</option>
      <option value="DONE">{t('task.status.DONE')}</option>
    </CrmSelect>
  );
}

/** Окно задачи: полный текст, люди, сроки; статус меняется прямо здесь. */
function TaskModal({
  task, canChange, canDelete, onStatus, onDelete, onClose,
}: {
  task: Task; canChange: boolean; canDelete: boolean;
  onStatus: (s: TaskStatus) => void; onDelete: () => void; onClose: () => void;
}) {
  const { t } = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const people = (task.assignees ?? []).map((a) => a.fullName).join(', ');
  return (
    <motion.div
      className="dialog-backdrop details-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        className="dialog-card task-modal"
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        data-testid="task-modal"
        initial={{ opacity: 0, scale: 0.97, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 16 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="task-modal-head">
          <h3 className="task-modal-title">{task.title}</h3>
          <button type="button" className="lead-modal-close" aria-label={t('common.close')} data-testid="task-modal-close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {task.description
          ? <div className="task-modal-desc" data-testid="task-modal-desc">{task.description}</div>
          : <div className="task-modal-desc task-empty">—</div>}
        <div className="task-modal-grid">
          <div><span>{t('common.status')}</span><TaskStatusSelect task={task} canChange={canChange} onChange={onStatus} /></div>
          <div><span>{t('task.deadline')}</span>{task.deadline ? <DeadlineBadge deadline={task.deadline} status={task.status} /> : <b>—</b>}</div>
          <div><span>{t('task.assignee')}</span><b>{people || '—'}</b></div>
          <div><span>{t('task.controller')}</span><b>{task.controller?.fullName ?? '—'}</b></div>
          <div><span>{t('task.author')}</span><b>{task.createdBy?.fullName ?? '—'}</b></div>
          <div><span>{t('task.created')}</span><b>{new Date(task.createdAt).toLocaleDateString('ru-RU')}</b></div>
        </div>
        <div className="task-modal-actions">
          {canDelete && (
            <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} data-testid="task-modal-delete">
              <Icon name="delete" size={16} /> {t('common.delete')}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
