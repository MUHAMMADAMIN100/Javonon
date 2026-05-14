import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createUser, deleteUser, listUsers, updateUser } from '../api/users';
import type { Role, User } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { compose, email as emailRule, hasErrors, maxLen, minLen, passwordRule, required, validateAll } from '../utils/validators';
import ChangePasswordModal from '../components/ChangePasswordModal';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';

export default function Users() {
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: '', fullName: '', password: '', role: 'EMPLOYEE' as Role });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [pwdTarget, setPwdTarget] = useState<User | null>(null);

  const formErrors = validateAll(
    form,
    {
      email: compose(required('Введите email'), emailRule()),
      fullName: compose(required('Введите ФИО'), minLen(2), maxLen(100)),
      password: compose(required('Введите пароль'), passwordRule()),
    },
  );
  const showErr = (k: keyof typeof formErrors) => touched[k] && formErrors[k];
  const formInvalid = hasErrors(formErrors);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const listKey = ['users', 'list', { search: debouncedSearch || undefined }] as const;
  const usersQuery = useQuery({
    queryKey: listKey,
    queryFn: () => listUsers(debouncedSearch || undefined),
  });
  const items = usersQuery.data ?? [];

  const createMut = useInvalidatingMutation({
    mutationFn: createUser,
    invalidate: [keys.users.all],
    onSuccess: () => {
      setCreating(false);
      setForm({ email: '', fullName: '', password: '', role: 'EMPLOYEE' });
      setTouched({});
      setError(null);
    },
    onError: (e: any) => setError(e.response?.data?.message?.toString() || 'Ошибка создания'),
  });

  const updateMut = useOptimisticMutation<User, { id: string; patch: Partial<User> }, User[]>({
    mutationFn: ({ id, patch }) => updateUser(id, patch as any),
    queryKey: listKey,
    applyOptimistic: (cur, { id, patch }) => optimistic.updateById(cur, id, patch),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const deleteMut = useOptimisticMutation<unknown, string, User[]>({
    mutationFn: deleteUser,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    onSuccess: () => toast('Пользователь удалён', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ email: true, fullName: true, password: true });
    if (formInvalid) return;
    setError(null);
    createMut.mutate(form);
  };

  const onChangeRole = (u: User, role: Role) => {
    updateMut.mutate({ id: u.id, patch: { role } });
  };

  const onDelete = async (u: User) => {
    if (u.id === me?.id) {
      toast('Нельзя удалить самого себя', 'error');
      return;
    }
    const ok = await confirm({
      title: 'Удалить пользователя',
      message: `Пользователь «${u.fullName}» будет удалён. Действие нельзя отменить.`,
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(u.id);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Пользователи системы</h2>
        {!creating && <button className="btn btn-primary" onClick={() => setCreating(true)}>+ Добавить</button>}
      </div>
      <div className="card-body">
        <div className="filters">
          <input
            placeholder="Поиск по email или ФИО..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {creating && (
          <form onSubmit={onCreate} style={{ marginBottom: 22, padding: 24, background: 'var(--bg-soft)', border: '1px solid var(--border-soft)', borderRadius: 18 }}>
            {error && <div className="error-banner">{error}</div>}
            <div className="form-grid-2">
              <div className="form-group">
                <label>ФИО *</label>
                <input
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, fullName: true }))}
                  className={showErr('fullName') ? 'input-error' : ''}
                  maxLength={100}
                  required
                />
                {showErr('fullName') && <div className="form-error-text">{formErrors.fullName}</div>}
              </div>
              <div className="form-group">
                <label>Email *</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                  className={showErr('email') ? 'input-error' : ''}
                  required
                />
                {showErr('email') && <div className="form-error-text">{formErrors.email}</div>}
              </div>
              <div className="form-group">
                <label>Пароль * <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 12 }}>— мин. 8 симв., буквы и цифры</span></label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                  className={showErr('password') ? 'input-error' : ''}
                  minLength={8}
                  required
                />
                {showErr('password') && <div className="form-error-text">{formErrors.password}</div>}
              </div>
              <div className="form-group">
                <label>Роль</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                  <option value="EMPLOYEE">Сотрудник</option>
                  <option value="ADMIN">Администратор</option>
                  <option value="ACCOUNTANT">Бухгалтер</option>
                </select>
              </div>
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCreating(false)}>Отмена</button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={formInvalid}
                title={formInvalid ? 'Исправьте ошибки в форме' : ''}
              >Создать</button>
            </div>
          </form>
        )}

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>ФИО</th><th>Email</th><th>Роль</th><th>Создан</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id} style={{ cursor: 'default' }}>
                  <td>
                    <Link to={`/users/${u.id}`} style={{ fontWeight: 600, color: 'inherit' }}>
                      {u.fullName}
                    </Link>
                    {u.id === me?.id && <span style={{ color: '#5b6478', fontSize: 12 }}> (вы)</span>}
                  </td>
                  <td data-label="Email">{u.email}</td>
                  <td data-label="Роль">
                    <select value={u.role} onChange={(e) => onChangeRole(u, e.target.value as Role)} disabled={u.id === me?.id}>
                      <option value="EMPLOYEE">Сотрудник</option>
                      <option value="ADMIN">Администратор</option>
                    </select>
                  </td>
                  <td data-label="Создан">{u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU') : '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => setPwdTarget(u)}
                        title="Сменить пароль"
                      >
                        Пароль
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => onDelete(u)} disabled={u.id === me?.id}>
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <ChangePasswordModal
        open={!!pwdTarget}
        mode={
          pwdTarget
            ? { kind: 'admin', userId: pwdTarget.id, userName: pwdTarget.fullName }
            : { kind: 'self' }
        }
        onClose={() => setPwdTarget(null)}
      />
    </div>
  );
}
