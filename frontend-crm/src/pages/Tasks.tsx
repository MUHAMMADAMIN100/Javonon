import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createTask, deleteTask, listTasks, updateTask } from '../api/tasks';
import { listUsers } from '../api/users';
import type { Role, Task, TaskStatus } from '../api/types';
import { TASK_STATUS_BADGE } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import { compose, hasErrors, maxLen, minLen, required, validateAll } from '../utils/validators';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import Loading from '../components/Loading';
import CrmDatePicker from '../components/CrmDatePicker';
import { isElevated, displayRoleLabel } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useTaskStatusLabel } from '../lib/labels';

type Scope = 'all' | 'mine';

export default function Tasks() {
  const { t } = useT();
  const taskStatusLabel = useTaskStatusLabel();
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const isAdmin = isElevated(me);
  const [scope, setScope] = useState<Scope>(isAdmin ? 'all' : 'mine');
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
      toast('Задача создана. Сотрудник получит email и уведомление.', 'success');
      setForm({ title: '', description: '', assigneeIds: [], controllerId: '', deadline: '' });
      setAssigneePicker('');
      setCreating(false);
    },
    onError: (err: any) => toast(err?.response?.data?.message || 'Ошибка создания', 'error'),
  });

  // UPDATE STATUS — горячий UX, делаем оптимистично (мгновенное переключение).
  const updateMut = useOptimisticMutation<Task, { id: string; patch: Parameters<typeof updateTask>[1] }, Task[]>({
    mutationFn: ({ id, patch }) => updateTask(id, patch),
    queryKey: listKey,
    applyOptimistic: (cur, { id, patch }) => optimistic.updateById(cur, id, patch as Partial<Task>),
    invalidateAlso: [keys.tasks.stats()],
    onError: (err: any) => toast(err?.response?.data?.message || 'Ошибка', 'error'),
  });

  // DELETE — оптимистично убираем из списка.
  const deleteMut = useOptimisticMutation<unknown, string, Task[]>({
    mutationFn: deleteTask,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.tasks.stats()],
    onSuccess: () => toast('Задача удалена', 'success'),
    onError: (err: any) => toast(err?.response?.data?.message || 'Ошибка удаления', 'error'),
  });

  const formErrors = validateAll(
    { title: form.title, description: form.description },
    {
      title: compose(required('Введите заголовок'), minLen(3, 'Минимум 3 символа'), maxLen(200)),
      description: compose(required('Опишите задачу'), minLen(5, 'Минимум 5 символов'), maxLen(2000)),
    },
  );
  // assigneeIds валидируем отдельно: массив, а validateAll работает со строками.
  const assigneesError = form.assigneeIds.length === 0 ? 'Выберите хотя бы одного сотрудника' : '';
  const formInvalid = hasErrors(formErrors) || !!assigneesError;

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (formInvalid) {
      toast('Заполните все поля корректно', 'error');
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

  const setStatus = (t: Task, next: TaskStatus) => {
    if (t.status === next) return;
    if (next === 'DONE') toast('Задача выполнена', 'success');
    else if (next === 'IN_PROGRESS') toast('Задача взята в работу', 'success');
    else toast('Задача возвращена в очередь', 'info');
    updateMut.mutate({ id: t.id, patch: { status: next } });
  };

  const onDelete = async (task: Task) => {
    const ok = await confirm({
      title: t('common.delete') + ' ' + t('tasks.title').toLowerCase(),
      message: `«${task.title}»`,
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(task.id);
  };

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="card-header">
        <h2 className="card-title">{t('tasks.title')}</h2>
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
          {isAdmin && !creating && (
            <motion.button
              className="btn btn-primary"
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
          <input
            className="crm-input"
            placeholder="Поиск по заголовку или описанию..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <AnimatePresence>
          {creating && isAdmin && (
            <motion.form
              onSubmit={onCreate}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              style={{ marginBottom: 20, padding: 18, background: 'var(--bg)', borderRadius: 10, overflow: 'hidden' }}
            >
              <div className="form-group">
                <label>{t('tasks.field.title')} *</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Например: Собрать документы для Иванова"
                  maxLength={200}
                  className={`crm-input${formErrors.title ? ' input-error' : ''}`}
                  required
                />
                {formErrors.title && <div className="form-error-text">{formErrors.title}</div>}
              </div>
              <div className="form-group">
                <label>{t('tasks.field.description')} *</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Что именно нужно сделать..."
                  maxLength={2000}
                  className={`crm-textarea${formErrors.description ? ' input-error' : ''}`}
                  required
                  rows={4}
                />
                {formErrors.description && <div className="form-error-text">{formErrors.description}</div>}
              </div>
              <div className="form-group">
                <label>Назначить сотрудников *</label>
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
                            aria-label="Убрать"
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
                <select
                  className={`crm-select${assigneesError ? ' input-error' : ''}`}
                  value={assigneePicker}
                  onChange={(e) => addAssignee(e.target.value)}
                >
                  <option value="">
                    {form.assigneeIds.length === 0
                      ? '— Выберите сотрудника —'
                      : '+ Добавить ещё сотрудника'}
                  </option>
                  {users
                    .filter((u) => !form.assigneeIds.includes(u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.fullName} · {displayRoleLabel(u as any)}
                      </option>
                    ))}
                </select>
                {assigneesError && <div className="form-error-text">{assigneesError}</div>}
              </div>
              <div className="form-group">
                <label>Контролёр задачи</label>
                <select
                  className="crm-select"
                  value={form.controllerId}
                  onChange={(e) => setForm({ ...form, controllerId: e.target.value })}
                >
                  <option value="">Выберите контролёра (необязательно)</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName} · {displayRoleLabel(u as any)}
                    </option>
                  ))}
                </select>
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
                  title={formInvalid ? 'Исправьте ошибки в форме' : ''}
                >
                  {submitting ? 'Создаём...' : 'Создать'}
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <motion.div key="empty" className="empty" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="empty-icon"><Icon name="task_alt" size={48} /></div>
              {scope === 'mine' ? 'У вас пока нет назначенных задач' : 'Задач пока нет'}
            </motion.div>
          ) : (
            <motion.div
              key="list"
              className="tasks-list"
              initial="hidden"
              animate="show"
              variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
            >
              {items.map((task) => {
                const isAssignee = !!me && task.assigneeIds?.includes(me.id);
                const isController = !!me && task.controllerId === me.id;
                const canChange = isAdmin || isAssignee || isController;
                const statuses: { value: TaskStatus; icon: string; label: string }[] = [
                  { value: 'TODO', icon: 'radio_button_unchecked', label: t('task.status.TODO') },
                  { value: 'IN_PROGRESS', icon: 'autorenew', label: t('task.status.IN_PROGRESS') },
                  { value: 'DONE', icon: 'check_circle', label: t('task.status.DONE') },
                ];
                return (
                  <motion.div
                    key={task.id}
                    className={`task-item task-${task.status.toLowerCase()}`}
                    variants={{
                      hidden: { opacity: 0, y: 10 },
                      show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
                    }}
                    layout
                  >
                    <div className="task-content">
                      <div className="task-title">{task.title}</div>
                      <div className="task-desc">{task.description}</div>
                      <div className="task-meta">
                        <span className={`badge ${TASK_STATUS_BADGE[task.status]}`}>{taskStatusLabel(task.status)}</span>
                        {(task.assignees && task.assignees.length > 0) ? (
                          task.assignees.map((a) => (
                            <span key={a.id} className="task-meta-item">
                              <Icon name="person" size={14} />
                              {a.fullName}
                            </span>
                          ))
                        ) : (
                          <span className="task-meta-item">
                            <Icon name="person" size={14} />—
                          </span>
                        )}
                        {task.controller && (
                          <span className="task-meta-item" title="Контролёр задачи">
                            <Icon name="verified_user" size={14} />
                            Контролёр: {task.controller.fullName}
                          </span>
                        )}
                        {task.createdBy && (
                          <span className="task-meta-item">
                            <Icon name="edit" size={14} />
                            {task.createdBy.fullName}
                          </span>
                        )}
                        {task.deadline && (() => {
                          const dl = new Date(task.deadline);
                          const now = new Date();
                          const ms = dl.getTime() - now.getTime();
                          const isOverdue = ms < 0 && task.status !== 'DONE';
                          const isSoon = ms >= 0 && ms < 24 * 60 * 60 * 1000 && task.status !== 'DONE';
                          const cls = isOverdue ? 'badge-danger' : isSoon ? 'badge-warning' : 'badge-info';
                          return (
                            <span className={`badge ${cls}`} style={{ fontFamily: 'var(--font-mono)' }}>
                              <Icon name="schedule" size={12} />
                              {dl.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          );
                        })()}
                        <span className="task-meta-item">
                          <Icon name="event" size={14} />
                          {new Date(task.createdAt).toLocaleDateString('ru-RU')}
                        </span>
                      </div>

                      <div className="task-status-switch">
                        {statuses.map((s) => (
                          <button
                            key={s.value}
                            className={`task-status-btn${task.status === s.value ? ' active' : ''} task-status-${s.value.toLowerCase()}`}
                            onClick={() => canChange && setStatus(task, s.value)}
                            disabled={!canChange}
                            title={s.label}
                          >
                            <Icon name={s.icon} size={16} />
                            <span>{s.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {isAdmin && (
                      <button className="btn btn-sm btn-danger task-delete-btn" onClick={() => onDelete(task)} title={t('common.delete')}>
                        <Icon name="delete" size={16} />
                      </button>
                    )}
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
