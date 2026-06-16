import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { createUser, deleteUser, listUsers, updateUser } from '../api/users';
import { ROLE_LABEL, type Role, type User } from '../api/types';
import { listCustomRoles } from '../api/customRoles';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useUI } from '../ui/Dialogs';
import { compose, email as emailRule, hasErrors, maxLen, minLen, passwordRule, required, validateAll } from '../utils/validators';
import ChangePasswordModal from '../components/ChangePasswordModal';
import PasswordInput from '../components/PasswordInput';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';

const EMPTY_FORM = {
  email: '', fullName: '', password: '',
  role: 'SALES_MANAGER' as Role,
  // Кастомная роль (ТЗ-доработка). null = только базовая.
  customRoleId: null as string | null,
};

export default function Users() {
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
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

  // Кастомные роли (Настройки → Роли и доступы). Доступны только FOUNDER'у
  // на endpoint — для остальных просто пустой список (запрос вернёт 403,
  // вгоняем в empty без ошибки UI).
  const customRolesQuery = useQuery({
    queryKey: ['custom-roles'],
    queryFn: listCustomRoles,
    enabled: !!me && isFounder(me),
  });
  const customRoles = (customRolesQuery.data || []).filter((r) => r.isActive);

  const createMut = useInvalidatingMutation({
    mutationFn: createUser,
    invalidate: [keys.users.all],
    onSuccess: () => {
      setCreating(false);
      setForm(EMPTY_FORM);
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

  const openCreate = () => {
    // Сбрасываем форму ДО открытия — иначе при повторном открытии
    // в полях останутся данные с прошлой попытки.
    setForm(EMPTY_FORM);
    setTouched({});
    setError(null);
    setCreating(true);
  };

  const closeCreate = () => {
    if (createMut.isPending) return;
    setCreating(false);
    setForm(EMPTY_FORM);
    setTouched({});
    setError(null);
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
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить</button>
      </div>
      <div className="card-body">
        <div className="filters">
          <input
            placeholder="Поиск по email или ФИО..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
                    {/* Мульти-роли по ТЗ §2. Раньше тут был inline-select с
                        опциями EMPLOYEE/ADMIN — обе устарели (EMPLOYEE
                        удалён, выбора из 5 ролей не было). Управление
                        ролями теперь в карточке /users/:id через RolesEditor
                        (FOUNDER-only). Здесь — только просмотр всех ролей. */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {(() => {
                        const allRoles = Array.from(
                          new Set([u.role, ...((u as any).roles || [])])
                        ).filter(Boolean);
                        return allRoles.map((r) => (
                          <span
                            key={r}
                            style={{
                              padding: '3px 8px',
                              borderRadius: 999,
                              background: r === 'FOUNDER' ? '#fef3c7' : 'var(--bg-soft)',
                              border: '1px solid var(--border)',
                              fontSize: 11,
                              fontWeight: 500,
                            }}
                          >
                            {ROLE_LABEL[r as Role] || r}
                          </span>
                        ));
                      })()}
                    </div>
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
      <AnimatePresence>
        {creating && (
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeCreate}
          >
            <motion.form
              className="dialog-card"
              style={{ maxWidth: 520 }}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
              onSubmit={onCreate}
              // autoComplete="off" на форме + нестандартные name на полях ниже —
              // чтобы браузер не подставлял сохранённый логин/пароль админа
              // в форму создания НОВОГО сотрудника.
              autoComplete="off"
            >
              <div className="dialog-icon">
                <Icon name="person_add" size={28} />
              </div>
              <div className="dialog-title">Новый сотрудник</div>
              <div className="dialog-message" style={{ marginBottom: 16 }}>
                Заполни данные нового пользователя системы.
              </div>

              {error && (
                <div className="error-banner" style={{ marginBottom: 12, textAlign: 'left' }}>
                  {error}
                </div>
              )}

              {/* Скрытые декойные поля — Chrome/Safari пытаются автозаполнить
                  ПЕРВЫЕ найденные email/password. Подставляем им фейковые,
                  чтобы реальные поля ниже остались пустыми. */}
              <input type="text" name="fake-username" autoComplete="username" style={{ display: 'none' }} />
              <input type="password" name="fake-password" autoComplete="current-password" style={{ display: 'none' }} />

              <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
                <label>ФИО *</label>
                <input
                  name="newUserFullName"
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, fullName: true }))}
                  className={showErr('fullName') ? 'input-error' : ''}
                  maxLength={100}
                  autoComplete="off"
                  autoFocus
                  required
                />
                {showErr('fullName') && <div className="form-error-text">{formErrors.fullName}</div>}
              </div>

              <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
                <label>Email *</label>
                <input
                  type="email"
                  name="newUserEmail"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                  className={showErr('email') ? 'input-error' : ''}
                  autoComplete="off"
                  required
                />
                {showErr('email') && <div className="form-error-text">{formErrors.email}</div>}
              </div>

              <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
                <label>
                  Пароль * <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 12 }}>— мин. 8 симв., буквы и цифры</span>
                </label>
                <PasswordInput
                  name="newUserPassword"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                  className={showErr('password') ? 'input-error' : ''}
                  minLength={8}
                  autoComplete="new-password"
                  required
                />
                {showErr('password') && <div className="form-error-text">{formErrors.password}</div>}
              </div>

              <div className="form-group" style={{ textAlign: 'left', marginBottom: 16 }}>
                <label>Роль</label>
                {/* ТЗ §2: 5 базовых ролей + кастомные роли FOUNDER'а.
                    Составное значение «base:X» / «custom:<id>» — чтобы
                    одним dropdown'ом покрыть оба типа. */}
                <select
                  value={form.customRoleId ? `custom:${form.customRoleId}` : `base:${form.role}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v.startsWith('custom:')) {
                      // Кастомная роль: базовая ставится «нейтральной»
                      // (SALES_MANAGER — ничего лишнего сама по себе не
                      // открывает), permissions берутся из CustomRole.
                      setForm({ ...form, role: 'SALES_MANAGER', customRoleId: v.slice('custom:'.length) });
                    } else {
                      setForm({ ...form, role: v.slice('base:'.length) as Role, customRoleId: null });
                    }
                  }}
                >
                  <optgroup label="Базовые роли">
                    <option value="base:ADMIN">Администратор</option>
                    <option value="base:ACCOUNTANT">Бухгалтер</option>
                    <option value="base:SALES_MANAGER">Менеджер по продажам</option>
                    <option value="base:CLIENT_MANAGER">Клиентский менеджер</option>
                  </optgroup>
                  {customRoles.length > 0 && (
                    <optgroup label="Кастомные роли">
                      {customRoles.map((r) => (
                        <option key={r.id} value={`custom:${r.id}`}>
                          {r.name} ({r.permissions.length} доступов)
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>
                  {customRoles.length === 0 && isFounder(me)
                    ? 'Чтобы добавить свою роль — Настройки → Роли и доступы.'
                    : 'Дополнительные роли назначаются после создания в карточке сотрудника.'}
                </div>
              </div>

              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={closeCreate} disabled={createMut.isPending}>
                  Отмена
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={formInvalid || createMut.isPending}
                  title={formInvalid ? 'Исправьте ошибки в форме' : ''}
                >
                  {createMut.isPending ? 'Создаём…' : 'Создать'}
                </button>
              </div>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>

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
