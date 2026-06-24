import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { createUser, deleteUser, listUsers, updateUser } from '../api/users';
import { type Role, type User } from '../api/types';
import { listCustomRoles } from '../api/customRoles';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useRoleLabel } from '../lib/labels';
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
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const me = useAuth((s) => s.user);
  const navigate = useNavigate();
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
      email: compose(required(t('toast.error')), emailRule()),
      fullName: compose(required(t('toast.error')), minLen(2), maxLen(100)),
      password: compose(required(t('toast.error')), passwordRule()),
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

  // Кастомные роли (Настройки → Роли и доступы). Read-эндпоинт открыт
  // FOUNDER/ADMIN/ACCOUNTANT — все они могут создавать сотрудников и им
  // нужен полный список ролей в dropdown.
  const customRolesQuery = useQuery({
    queryKey: ['custom-roles'],
    queryFn: listCustomRoles,
    enabled: !!me,
    // Если ответ 403 (юзер не в whitelist), TanStack по умолчанию ретраит
    // 3 раза — не нужно, сразу гасим.
    retry: false,
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
    onError: (e: any) => setError(e.response?.data?.message?.toString() || t('toast.error')),
  });

  const updateMut = useOptimisticMutation<User, { id: string; patch: Partial<User> }, User[]>({
    mutationFn: ({ id, patch }) => updateUser(id, patch as any),
    queryKey: listKey,
    applyOptimistic: (cur, { id, patch }) => optimistic.updateById(cur, id, patch),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteMut = useOptimisticMutation<unknown, string, User[]>({
    mutationFn: deleteUser,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    onSuccess: () => toast(t('toast.deleted'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
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
      toast(t('toast.error'), 'error');
      return;
    }
    const ok = await confirm({
      title: t('common.delete'),
      message: `«${u.fullName}»`,
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(u.id);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">{t('users.title')}</h2>
        <button className="btn btn-primary" onClick={openCreate}>+ {t('common.add')}</button>
      </div>
      <div className="card-body">
        <div className="filters">
          <input
            placeholder={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>{t('app.field.fullName')}</th><th>{t('userDetail.field.email')}</th><th>{t('userDetail.field.role')}</th><th>{t('profile.field.createdAt')}</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((u) => {
                const customRole = (u as any).customRole;
                const hasActiveCustom = customRole && customRole.isActive !== false;
                return (
                <tr
                  key={u.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/users/${u.id}`)}
                >
                  <td>
                    <span style={{ fontWeight: 600 }}>{u.fullName}</span>
                    {u.id === me?.id && <span style={{ color: '#5b6478', fontSize: 12 }}> (вы)</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {hasActiveCustom ? (
                        // Если есть активная кастомная роль — показываем
                        // только её, чтобы пользователь не путался с
                        // «технической» базовой ролью под ней.
                        <span
                          style={{
                            padding: '3px 8px',
                            borderRadius: 999,
                            background: 'var(--primary-light, #e0e7ff)',
                            border: '1.5px solid var(--primary, #4f46e5)',
                            color: 'var(--primary-dark, #4338ca)',
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                          title={t('userDetail.field.customRole')}
                        >
                          {customRole.name}
                        </span>
                      ) : (
                        Array.from(new Set([u.role, ...((u as any).roles || [])])).filter(Boolean).map((r) => (
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
                            {roleLabel(r as string)}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU') : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => setPwdTarget(u)}
                        title={t('login.password')}
                      >
                        {t('login.password')}
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => onDelete(u)} disabled={u.id === me?.id}>
                        {t('common.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
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
              <div className="dialog-title">{t('users.new')}</div>
              <div className="dialog-message" style={{ marginBottom: 16 }}>
                {t('studentNew.subtitle')}
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
                <label>{t('app.field.fullName')} *</label>
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
                <label>{t('userDetail.field.email')} *</label>
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
                  {t('login.password')} *
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
                <label>{t('userDetail.field.role')}</label>
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
                  <optgroup label={t('userDetail.field.role')}>
                    <option value="base:ADMIN">{roleLabel('ADMIN' as any)}</option>
                    <option value="base:ACCOUNTANT">{roleLabel('ACCOUNTANT' as any)}</option>
                    <option value="base:SALES_MANAGER">{roleLabel('SALES_MANAGER' as any)}</option>
                    <option value="base:CLIENT_MANAGER">{roleLabel('CLIENT_MANAGER' as any)}</option>
                  </optgroup>
                  {customRoles.length > 0 && (
                    <optgroup label={t('userDetail.field.customRole')}>
                      {customRoles.map((r) => (
                        <option key={r.id} value={`custom:${r.id}`}>
                          {r.name} ({r.permissions.length})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={closeCreate} disabled={createMut.isPending}>
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={formInvalid || createMut.isPending}
                >
                  {createMut.isPending ? t('common.saving') : t('common.create')}
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
