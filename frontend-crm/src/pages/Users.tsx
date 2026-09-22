import { useCallback, useEffect, useState } from 'react';
import CrmSelect from '../components/CrmSelect';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { createUser, dismissUser, listUsers, restoreUser, updateUser } from '../api/users';
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
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import SearchField, { useUrlSearch } from '../components/SearchField';
import ListTotal from '../components/ListTotal';
import ActiveFilterChips from '../components/ActiveFilterChips';
import { stringParam, useUrlListState } from '../lib/useUrlListState';
import { matchesSearch } from '../lib/listSearch';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import { presenceSortValue, presenceText, usePresence } from '../lib/usePresence';
import type { PresenceState } from '../api/presence';
import PresenceDot from '../components/PresenceDot';

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

  // Роль и поиск — в ссылке: из карточки сотрудника возвращаются «назад»,
  // и выборка должна остаться.
  const { values, setValue, reset } = useUrlListState({
    role: stringParam('', 80),
    search: stringParam('', 200),
    online: stringParam('', 20),
    state: stringParam('', 20),
  });
  const setUrlSearch = useCallback((v: string) => setValue('search', v), [setValue]);
  const { input: searchInput, setInput: setSearchInput, clear: clearSearch } = useUrlSearch(values.search, setUrlSearch);

  // Сотрудников немного — грузим всех и фильтруем в браузере: так счётчик
  // «Найдено: X из N» и список ролей с числами считаются сразу.
  const listKey = ['users', 'list', {}] as const;
  const usersQuery = useQuery({
    queryKey: listKey,
    queryFn: () => listUsers(undefined, true),
  });
  // «Действующие» (по умолчанию) или «Уволенные» — счётчики и фильтры
  // ниже считаются по выбранному набору.
  const dismissedView = values.state === 'dismissed';
  const everyone = usersQuery.data ?? [];
  const activeCount = everyone.filter((u) => u.isActive !== false).length;
  const dismissedCount = everyone.length - activeCount;
  const allUsers = everyone.filter((u) => (u.isActive === false) === dismissedView);

  // «Кто в сети» — только основателю (сервер остальным отвечает 403).
  const founder = isFounder(me);
  const presence = usePresence(founder);
  const presenceOf = (u: User) => presence.byId.get(u.id);
  const presenceStates: PresenceState[] = ['ONLINE', 'AWAY', 'OFFLINE'];
  const presenceFilter = founder && presenceStates.includes(values.online as PresenceState) ? (values.online as PresenceState) : '';
  const presenceCount = (st: PresenceState) => allUsers.filter((u) => (presenceOf(u)?.state ?? 'OFFLINE') === st).length;

  /**
   * Роли сотрудника — ровно то, что видно в колонке «Роль»: активная своя
   * роль заменяет базовые, иначе все базовые (их может быть несколько).
   */
  const roleKeysOf = (u: User): { key: string; label: string }[] => {
    const custom = (u as any).customRole;
    if (custom && custom.isActive !== false) return [{ key: `custom:${custom.id}`, label: custom.name }];
    return Array.from(new Set([u.role, ...((u as any).roles || [])]))
      .filter(Boolean)
      .map((r) => ({ key: `base:${r}`, label: roleLabel(r as string) }));
  };
  // Роли в фильтре — только те, у кого есть люди, с их числом.
  const roleOptions = (() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const u of allUsers) {
      for (const r of roleKeysOf(u)) {
        const row = map.get(r.key) || { label: r.label, count: 0 };
        row.count += 1;
        map.set(r.key, row);
      }
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  })();
  const roleFilter = values.role;
  const items = allUsers.filter(
    (u) =>
      (!roleFilter || roleKeysOf(u).some((r) => r.key === roleFilter)) &&
      (!presenceFilter || (presenceOf(u)?.state ?? 'OFFLINE') === presenceFilter) &&
      matchesSearch(values.search, [u.fullName, u.email]),
  );
  const narrowed = !!(roleFilter || values.search || presenceFilter);
  const roleFilterLabel = roleOptions.find((r) => r.key === roleFilter)?.label;
  const sort = useTableSort(items, [
    { key: 'fullName', label: t('app.field.fullName'), value: (u) => u.fullName },
    ...(founder
      ? [{ key: 'presence', label: t('presence.col'), type: 'number' as const, value: (u: User) => presenceSortValue(presenceOf(u)) }]
      : []),
    { key: 'email', label: t('userDetail.field.email'), value: (u) => u.email },
    {
      key: 'role',
      label: t('userDetail.field.role'),
      // То же, что видно в ячейке: активная своя роль, иначе базовая.
      value: (u) => {
        const custom = (u as any).customRole;
        return custom && custom.isActive !== false ? custom.name : roleLabel(u.role as string);
      },
    },
    { key: 'createdAt', label: t('profile.field.createdAt'), type: 'date', value: (u) => u.createdAt },
  ]);

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

  const dismissMut = useOptimisticMutation<unknown, string, User[]>({
    mutationFn: dismissUser,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.updateById(cur, id, { isActive: false } as Partial<User>),
    onSuccess: () => toast(t('users.dismiss.done'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const restoreMut = useOptimisticMutation<unknown, string, User[]>({
    mutationFn: restoreUser,
    queryKey: listKey,
    applyOptimistic: (cur, id) => optimistic.updateById(cur, id, { isActive: true } as Partial<User>),
    onSuccess: () => toast(t('users.restore.done'), 'success'),
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

  const onDismiss = async (u: User) => {
    if (u.id === me?.id) {
      toast(t('toast.error'), 'error');
      return;
    }
    const ok = await confirm({
      title: `${t('users.dismiss')} «${u.fullName}»?`,
      message: t('users.dismiss.confirm'),
      confirmText: t('users.dismiss'),
      danger: true,
    });
    if (!ok) return;
    dismissMut.mutate(u.id);
  };

  return (
    <div className="card">
      <div className="card-header is-titleless">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <ListTotal noun="users" found={items.length} total={allUsers.length} filtered={narrowed} testId="users-total" />
          {founder && presence.ready && (
            <span className="presence-count" data-testid="users-online-count">
              <PresenceDot state="ONLINE" size={8} />
              {t('presence.onlineCount').replace('{n}', String(presenceCount('ONLINE')))}
            </span>
          )}
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ {t('common.add')}</button>
      </div>
      <div className="card-body">
        <div className="filters">
          <CrmSelect
            className="crm-select"
            value={values.state === 'dismissed' ? 'dismissed' : ''}
            onChange={(e) => setValue('state', e.target.value)}
            style={{ ['--filter-w' as string]: '200px' }}
            title={t('users.filter.state')}
            data-testid="users-filter-state"
          >
            <option value="">{`${t('users.filter.active')} (${activeCount})`}</option>
            <option value="dismissed">{`${t('users.filter.dismissed')} (${dismissedCount})`}</option>
          </CrmSelect>
          <CrmSelect
            className="crm-select"
            value={roleFilter}
            onChange={(e) => setValue('role', e.target.value)}
            style={{ ['--filter-w' as string]: '230px' }}
            title={t('users.filter.role')}
            data-testid="users-filter-role"
          >
            <option value="">{t('users.filter.allRoles')}</option>
            {/* Роль из старой ссылки, у которой уже нет людей, — чтобы список
                не показывал «Все роли» при включённом фильтре. */}
            {roleFilter && !roleOptions.some((r) => r.key === roleFilter) && (
              <option value={roleFilter}>{roleFilter.replace(/^(base|custom):/, '')} (0)</option>
            )}
            {roleOptions.map((r) => (
              <option key={r.key} value={r.key}>{`${r.label} (${r.count})`}</option>
            ))}
          </CrmSelect>
          {founder && (
            <CrmSelect
              className="crm-select"
              value={presenceFilter}
              onChange={(e) => setValue('online', e.target.value)}
              style={{ ['--filter-w' as string]: '200px' }}
              title={t('presence.filter')}
              data-testid="users-filter-presence"
            >
              <option value="">{t('presence.filter.all')}</option>
              {presenceStates.map((st) => (
                <option key={st} value={st}>
                  {`${t(st === 'ONLINE' ? 'presence.online' : st === 'AWAY' ? 'presence.away' : 'presence.offline')} (${presenceCount(st)})`}
                </option>
              ))}
            </CrmSelect>
          )}
          <SearchField
            value={searchInput}
            onChange={setSearchInput}
            onClear={clearSearch}
            placeholder={t('users.search.placeholder')}
            testId="users-search"
          />
          {(narrowed || searchInput) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSearchInput('');
                reset(['role', 'search', 'online']);
              }}
            >
              <Icon name="close" size={14} /> {t('common.reset')}
            </button>
          )}
        </div>
        <ActiveFilterChips
          chips={[
            ...(values.search
              ? [{ key: 'search', label: `${t('list.chip.search')}: «${values.search}»`, onClear: clearSearch }]
              : []),
            ...(roleFilter
              ? [{ key: 'role', label: `${t('users.chip.role')}: ${roleFilterLabel ?? '…'}`, onClear: () => reset(['role']) }]
              : []),
            ...(presenceFilter
              ? [{
                  key: 'online',
                  label: `${t('presence.chip')}: ${t(presenceFilter === 'ONLINE' ? 'presence.online' : presenceFilter === 'AWAY' ? 'presence.away' : 'presence.offline')}`,
                  onClear: () => reset(['online']),
                }]
              : []),
          ]}
        />
        {!usersQuery.isLoading && items.length === 0 && (
          <div className="empty" data-testid="users-empty">
            <div className="empty-icon"><Icon name={narrowed ? 'search_off' : 'group'} size={48} /></div>
            {narrowed ? t('common.empty') : t('users.empty')}
          </div>
        )}
        {items.length > 0 && (
        <div className="table-wrap">
          {items.length > 0 && <SortSelect sort={sort} />}
          <table className="table">
            <thead>
              <tr>
                {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((u) => {
                const customRole = (u as any).customRole;
                const hasActiveCustom = customRole && customRole.isActive !== false;
                return (
                <tr
                  key={u.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/users/${u.id}`)}
                >
                  <td>
                    <span className="presence-name">
                      {founder && <PresenceDot state={presenceOf(u)?.state} title={presenceText(presenceOf(u), presence.now, t)} />}
                      <span style={{ fontWeight: 600 }}>{u.fullName}</span>
                      {u.isActive === false && <span className="badge badge-gray" data-testid="user-dismissed-badge">{t('users.dismissed')}</span>}
                    </span>
                    {u.id === me?.id && <span style={{ color: '#5b6478', fontSize: 12 }}> ({t('common.youLower')})</span>}
                  </td>
                  {founder && (
                    <td data-testid="user-presence">
                      {(() => {
                        const r = presenceOf(u);
                        if (!r) return <span style={{ color: 'var(--text-light)' }}>—</span>;
                        return (
                          <span className={`presence-cell is-${r.state.toLowerCase()}`}>
                            {presenceText(r, presence.now, t)}
                          </span>
                        );
                      })()}
                    </td>
                  )}
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
                            borderRadius: 10,
                            // ВНИМАНИЕ: --primary-light в этой теме = #1E5BB8
                            // (это тёмно-синий, не светлый!). Поэтому текст
                            // ОБЯЗАТЕЛЬНО белый, иначе невидимо.
                            background: 'var(--primary, #01368B)',
                            border: '1.5px solid var(--primary-dark, #012457)',
                            color: '#fff',
                            fontSize: 11,
                            fontWeight: 600,
                            maxWidth: '100%',
                            wordBreak: 'break-word',
                            overflowWrap: 'anywhere',
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
                      {u.isActive === false ? (
                        <button className="btn btn-sm btn-secondary" data-testid="user-restore" onClick={() => restoreMut.mutate(u.id)}>
                          {t('users.restore')}
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => setPwdTarget(u)}
                            title={t('login.password')}
                          >
                            {t('login.password')}
                          </button>
                          <button className="btn btn-sm btn-danger" data-testid="user-dismiss" onClick={() => onDismiss(u)} disabled={u.id === me?.id}>
                            {t('users.dismiss')}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
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
                  className={`crm-input${showErr('fullName') ? ' input-error' : ''}`}
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
                  className={`crm-input${showErr('email') ? ' input-error' : ''}`}
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
                <CrmSelect
                  className="crm-select"
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
                  {/* Кастомную роль назначает только основатель (так же проверяет сервер). */}
                  {founder && customRoles.length > 0 && (
                    <optgroup label={t('userDetail.field.customRole')}>
                      {customRoles.map((r) => (
                        <option key={r.id} value={`custom:${r.id}`}>
                          {r.name} ({r.permissions.length})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </CrmSelect>
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
