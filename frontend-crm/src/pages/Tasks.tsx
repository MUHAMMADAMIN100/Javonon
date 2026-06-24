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
  const [form, setForm] = useState({ title: '', description: '', assignedToId: '', deadline: '' });

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
      setForm({ title: '', description: '', assignedToId: '', deadline: '' });
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
    { title: form.title, description: form.description, assignedToId: form.assignedToId },
    {
      title: compose(required('Введите заголовок'), minLen(3, 'Минимум 3 символа'), maxLen(200)),
      description: compose(required('Опишите задачу'), minLen(5, 'Минимум 5 символов'), maxLen(2000)),
      assignedToId: required('Выберите сотрудника'),
    },
  );
  const formInvalid = hasErrors(formErrors);

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (formInvalid) {
      toast('Заполните все поля корректно', 'error');
      return;
    }
    createMut.mutate({
      title: form.title.trim(),
      description: form.description.trim(),
      assignedToId: form.assignedToId,
      deadline: form.deadline || undefined,
    });
  };
  const submitting = createMut.isPending;

  const setStatus = (t: Task, next: TaskStatus) => {
    if (t.status === next) return;
    if (next === 'DONE') toast('Задача выполнена', 'success');
    else if (next === 'IN_PROGRESS') toast('Задача взята в работу', 'success');
    else toast('Задача возвращена в очередь', 'info');
    updateMut.mutate({ id: t.id, patch: { status: next } });
  };

  const onDelete = async (t: Task) => {
    const ok = await confirm({
      title: 'Удалить задачу',
      message: `«${t.title}» — действие нельзя отменить.`,
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(t.id);
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
              Новая задача
            </motion.button>
          )}
        </div>
      </div>

      <div className="card-body">
        <div className="filters">
          <input
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
                <label>Заголовок *</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Например: Собрать документы для Иванова"
                  maxLength={200}
                  className={formErrors.title ? 'input-error' : ''}
                  required
                />
                {formErrors.title && <div className="form-error-text">{formErrors.title}</div>}
              </div>
              <div className="form-group">
                <label>Описание *</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Что именно нужно сделать..."
                  maxLength={2000}
                  className={formErrors.description ? 'input-error' : ''}
                  required
                  rows={4}
                />
                {formErrors.description && <div className="form-error-text">{formErrors.description}</div>}
              </div>
              <div className="form-group">
                <label>Назначить сотрудника</label>
                <select
                  value={form.assignedToId}
                  onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}
                  required
                >
                  <option value="">— Выберите сотрудника —</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName} · {displayRoleLabel(u as any)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Дедлайн (опционально)</label>
                <input
                  type="datetime-local"
                  value={form.deadline}
                  onChange={(e) => setForm({ ...form, deadline: e.target.value })}
                />
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { setCreating(false); setForm({ title: '', description: '', assignedToId: '', deadline: '' }); }}
                >
                  Отмена
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
              {items.map((t) => {
                const isOwner = t.assignedToId === me?.id;
                const canChange = isAdmin || isOwner;
                const statuses: { value: TaskStatus; icon: string; label: string }[] = [
                  { value: 'TODO', icon: 'radio_button_unchecked', label: 'К выполнению' },
                  { value: 'IN_PROGRESS', icon: 'autorenew', label: 'В работе' },
                  { value: 'DONE', icon: 'check_circle', label: 'Выполнено' },
                ];
                return (
                  <motion.div
                    key={t.id}
                    className={`task-item task-${t.status.toLowerCase()}`}
                    variants={{
                      hidden: { opacity: 0, y: 10 },
                      show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
                    }}
                    layout
                  >
                    <div className="task-content">
                      <div className="task-title">{t.title}</div>
                      <div className="task-desc">{t.description}</div>
                      <div className="task-meta">
                        <span className={`badge ${TASK_STATUS_BADGE[t.status]}`}>{taskStatusLabel(t.status)}</span>
                        <span className="task-meta-item">
                          <Icon name="person" size={14} />
                          {t.assignedTo?.fullName || '—'}
                          {isOwner && <span className="mgr-you"> (вы)</span>}
                        </span>
                        {t.createdBy && (
                          <span className="task-meta-item">
                            <Icon name="edit" size={14} />
                            От: {t.createdBy.fullName}
                          </span>
                        )}
                        {t.deadline && (() => {
                          const dl = new Date(t.deadline);
                          const now = new Date();
                          const ms = dl.getTime() - now.getTime();
                          const isOverdue = ms < 0 && t.status !== 'DONE';
                          const isSoon = ms >= 0 && ms < 24 * 60 * 60 * 1000 && t.status !== 'DONE';
                          const cls = isOverdue ? 'badge-danger' : isSoon ? 'badge-warning' : 'badge-info';
                          const label = isOverdue ? 'ПРОСРОЧЕНО' : isSoon ? 'СРОЧНО' : '';
                          return (
                            <span className={`badge ${cls}`} style={{ fontFamily: 'var(--font-mono)' }}>
                              <Icon name="schedule" size={12} />
                              {label && <strong style={{ marginRight: 4 }}>{label}</strong>}
                              до {dl.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          );
                        })()}
                        <span className="task-meta-item">
                          <Icon name="event" size={14} />
                          {new Date(t.createdAt).toLocaleDateString('ru-RU')}
                        </span>
                      </div>

                      <div className="task-status-switch">
                        {statuses.map((s) => (
                          <button
                            key={s.value}
                            className={`task-status-btn${t.status === s.value ? ' active' : ''} task-status-${s.value.toLowerCase()}`}
                            onClick={() => canChange && setStatus(t, s.value)}
                            disabled={!canChange}
                            title={canChange ? s.label : 'Только назначенный сотрудник или админ'}
                          >
                            <Icon name={s.icon} size={16} />
                            <span>{s.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {isAdmin && (
                      <button className="btn btn-sm btn-danger task-delete-btn" onClick={() => onDelete(t)} title="Удалить задачу">
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
