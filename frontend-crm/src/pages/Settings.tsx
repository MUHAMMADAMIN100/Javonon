import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useUI } from '../ui/Dialogs';
import {
  type PenaltyRule,
  type WorkLocation,
  type BonusTier,
  type UserSalarySettings,
  listPenaltyRules,
  createPenaltyRule,
  updatePenaltyRule,
  deletePenaltyRule,
  getActiveLocation,
  createLocation,
  updateLocation,
  listBonusTiers,
  createBonusTier,
  updateBonusTier,
  deleteBonusTier,
  listSalarySettings,
  updateUserSalary,
} from '../api/settings';
import {
  type CustomRole,
  type PermissionDef,
  listCustomRoles,
  listPermissionsCatalog,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
} from '../api/customRoles';
import ScheduleEditor from '../components/ScheduleEditor';
import { useT } from '../lib/i18n';
import { useRealtime } from '../realtime';
import { me as apiMe } from '../api/auth';

type Tab = 'schedule' | 'penalties' | 'location' | 'roles' | 'salary';

export default function Settings() {
  const me = useAuth((s) => s.user);
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('schedule');

  if (!isFounder(me)) {
    return (
      <div className="card" style={{ padding: 28 }}>
        {t('settings.foundersOnly')}
      </div>
    );
  }

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.system')}</span>
        <h2 className="crm-section-title">{t('settings.title')}</h2>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div
          className="settings-tabbar"
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border)',
            gap: 4,
            padding: '8px 8px 0',
          }}
        >
          <TabButton active={tab === 'schedule'} onClick={() => setTab('schedule')} label={t('settings.tab.schedule')} />
          <TabButton active={tab === 'penalties'} onClick={() => setTab('penalties')} label={t('settings.tab.penalties')} />
          <TabButton active={tab === 'location'} onClick={() => setTab('location')} label={t('settings.tab.location')} />
          <TabButton active={tab === 'roles'} onClick={() => setTab('roles')} label={t('settings.tab.roles')} />
          <TabButton active={tab === 'salary'} onClick={() => setTab('salary')} label={t('settings.tab.salary')} />
        </div>
        <div style={{ padding: 24 }}>
          {tab === 'schedule' && <ScheduleTab />}
          {tab === 'penalties' && <PenaltiesTab />}
          {tab === 'location' && <LocationTab />}
          {tab === 'roles' && <RolesTab />}
          {tab === 'salary' && <SalaryTab />}
        </div>
      </div>
    </>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '10px 18px',
        background: active ? 'var(--bg-soft)' : 'transparent',
        border: 'none',
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        cursor: 'pointer',
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--text)' : 'var(--text-soft)',
        fontSize: 14,
        // Запрет переноса текста по символам на узких экранах.
        // На мобиле родитель .settings-tabbar скроллится горизонтально.
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

// ===== Schedule (вынесено в ScheduleEditor — компонент шарится с UserDetail.tsx) =====

function ScheduleTab() {
  return (
    <ScheduleEditor userId={null} />
  );
}

// ===== Penalties =====

function PenaltiesTab() {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['settings', 'penalty-rules'],
    queryFn: () => listPenaltyRules(),
  });
  const rules = query.data ?? [];

  const [minLate, setMinLate] = useState('10');
  const [maxLate, setMaxLate] = useState('');
  const [amount, setAmount] = useState('50');
  const [comment, setComment] = useState('');

  const add = async () => {
    try {
      await createPenaltyRule({
        minLateMinutes: parseInt(minLate, 10),
        maxLateMinutes: maxLate ? parseInt(maxLate, 10) : null,
        amount: parseFloat(amount),
        comment: comment || undefined,
      });
      setMinLate(''); setMaxLate(''); setAmount(''); setComment('');
      qc.invalidateQueries({ queryKey: ['settings', 'penalty-rules'] });
      toast(t('toast.created'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const remove = async (r: PenaltyRule) => {
    const ok = await confirm({
      title: t('common.delete') + '?',
      message: `${r.amount} ${r.currency}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    await deletePenaltyRule(r.id);
    qc.invalidateQueries({ queryKey: ['settings', 'penalty-rules'] });
  };

  const toggleActive = async (r: PenaltyRule) => {
    await updatePenaltyRule(r.id, { isActive: !r.isActive });
    qc.invalidateQueries({ queryKey: ['settings', 'penalty-rules'] });
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 16 }}>
        {t('settings.penalties.hint')}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 16, padding: 12, border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--bg-soft)' }}>
        <Field label={t('settings.penalties.minLate')}><input type="number" value={minLate} onChange={(e) => setMinLate(e.target.value)} /></Field>
        <Field label={t('settings.penalties.maxLate')}><input type="number" value={maxLate} onChange={(e) => setMaxLate(e.target.value)} /></Field>
        <Field label={t('settings.penalties.amount')}><input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label={t('settings.penalties.comment')}><input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <button className="btn btn-sm btn-primary" onClick={add} style={{ alignSelf: 'flex-end' }}>{t('common.add')}</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rules.length === 0 && <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>{t('settings.penalties.empty')}</div>}
        {rules.map((r) => (
          <div
            key={r.id}
            className="settings-row"
            style={{
              padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 8,
              opacity: r.isActive ? 1 : 0.5,
            }}
          >
            <div className="settings-row-main">
              <div style={{ fontWeight: 500 }}>
                {r.minLateMinutes}-{r.maxLateMinutes ?? '∞'} {t('common.minutes')} → <b>{r.amount} {r.currency}</b>
              </div>
              {r.comment && <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{r.comment}</div>}
            </div>
            <div className="settings-row-actions">
              <button className="btn btn-sm btn-secondary" onClick={() => toggleActive(r)}>
                {r.isActive ? t('settings.penalties.disable') : t('settings.penalties.enable')}
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => remove(r)}>{t('common.delete')}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===== Location =====

function LocationTab() {
  const { toast } = useUI();
  const { t } = useT();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['settings', 'work-location'],
    queryFn: () => getActiveLocation(),
  });
  const loc = query.data;

  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radius, setRadius] = useState('150');

  useEffect(() => {
    if (loc) {
      setName(loc.name);
      setLat(String(loc.latitude));
      setLng(String(loc.longitude));
      setRadius(String(loc.radiusMeters));
    }
  }, [loc?.id]);

  const detect = () => {
    if (!navigator.geolocation) return toast(t('toast.error'), 'error');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(String(pos.coords.latitude));
        setLng(String(pos.coords.longitude));
        toast(t('toast.updated'), 'success');
      },
      (e) => toast(t('toast.error') + ': ' + e.message, 'error'),
    );
  };

  const save = async () => {
    try {
      const payload = {
        name,
        latitude: parseFloat(lat),
        longitude: parseFloat(lng),
        radiusMeters: parseInt(radius, 10),
      };
      if (loc) {
        await updateLocation(loc.id, { ...payload, isActive: true });
      } else {
        await createLocation(payload);
      }
      qc.invalidateQueries({ queryKey: ['settings', 'work-location'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 16 }}>
        {t('settings.location.hint')}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label={t('settings.location.name')}><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('settings.location.lat')}><input type="number" step="0.0000001" value={lat} onChange={(e) => setLat(e.target.value)} /></Field>
        <Field label={t('settings.location.lng')}><input type="number" step="0.0000001" value={lng} onChange={(e) => setLng(e.target.value)} /></Field>
        <Field label={t('settings.location.radius')}><input type="number" value={radius} onChange={(e) => setRadius(e.target.value)} /></Field>
      </div>
      <div className="settings-location-actions">
        <button className="btn btn-sm btn-secondary" onClick={detect}>{t('settings.location.detect')}</button>
        <button className="btn btn-primary" onClick={save} disabled={!lat || !lng}>{t('common.save')}</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      {children}
    </div>
  );
}

// ===== Roles & Permissions (кастомные роли) =====

/**
 * Порядок отображения групп в редакторе кастомных ролей (Task 4).
 * Порядок групп зафиксирован здесь на фронте, чтобы UI не «дёргался»,
 * если в backend PERMISSION_CATALOG кто-то поменяет местами записи.
 * Ключи должны совпадать с `PermissionDef.group` из бэкенда
 * (backend/src/auth/permissions.ts). «Система» = раздел «Настройки».
 */
const PERMISSION_GROUP_ORDER: string[] = [
  'CRM',
  'Связь',
  'Продажи',
  'Финансы',
  'Аналитика',
  'HR',
  'Обучение',
  'Партнёры',
  'Система',
];

function RolesTab() {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const catalogQuery = useQuery({
    queryKey: ['custom-roles', 'catalog'],
    queryFn: listPermissionsCatalog,
  });
  const rolesQuery = useQuery({
    queryKey: ['custom-roles'],
    queryFn: listCustomRoles,
  });
  const catalog = catalogQuery.data ?? [];
  const roles = rolesQuery.data ?? [];

  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [creating, setCreating] = useState(false);

  /**
   * Realtime: сервер шлёт `customRole:*` события в staff-room. Обновление
   * списка кастомных ролей здесь даёт FOUNDER-у мгновенный фидбек — как
   * только он сохранил изменения, страница ре-рендерится с новым списком
   * (без ручного refresh). Одновременно, если у самого текущего юзера
   * назначена именно эта кастомная роль — рефрешим /auth/me, чтобы
   * `user.customRole.permissions` и `user.permissions` подтянулись сразу,
   * без релогина. Именно это позволяет target-юзеру «увидеть» новое право
   * в реальном времени — Sidebar/ProtectedRoute перечитают hasPermission
   * и покажут разделы, к которым доступ только что открылся.
   */
  useRealtime({
    'customRole:new': () => {
      qc.invalidateQueries({ queryKey: ['custom-roles'] });
    },
    'customRole:updated': async (payload: { id?: string; userId?: string }) => {
      qc.invalidateQueries({ queryKey: ['custom-roles'] });
      // Если моя кастомная роль обновилась — подхватываем свежие permissions.
      const affectsMe =
        (payload?.id && me?.customRole?.id === payload.id) ||
        (payload?.userId && me?.id === payload.userId);
      if (affectsMe) {
        try {
          const fresh = await apiMe();
          useAuth.setState({ user: fresh });
        } catch {
          // networking/500 — тихо игнорируем, следующая навигация подтянет.
        }
      }
    },
    'customRole:deleted': () => {
      qc.invalidateQueries({ queryKey: ['custom-roles'] });
    },
  });

  const onDelete = async (r: CustomRole) => {
    const ok = await confirm({
      title: t('common.delete') + '?',
      message: `«${r.name}»`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await deleteCustomRole(r.id);
      qc.invalidateQueries({ queryKey: ['custom-roles'] });
      toast(t('toast.deleted'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const onToggle = async (r: CustomRole) => {
    try {
      await updateCustomRole(r.id, { isActive: !r.isActive });
      qc.invalidateQueries({ queryKey: ['custom-roles'] });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 16 }}>
        {t('settings.roles.hint')}
      </p>

      {editing || creating ? (
        <RoleForm
          initial={editing}
          catalog={catalog}
          onCancel={() => { setEditing(null); setCreating(false); }}
          onSaved={() => {
            setEditing(null); setCreating(false);
            qc.invalidateQueries({ queryKey: ['custom-roles'] });
          }}
        />
      ) : (
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)} style={{ marginBottom: 16 }}>
          {t('settings.roles.new')}
        </button>
      )}

      {rolesQuery.isLoading ? (
        <div style={{ color: 'var(--text-soft)' }}>{t('common.loading')}</div>
      ) : roles.length === 0 ? (
        <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>
          {t('settings.roles.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {roles.map((r) => (
            <div
              key={r.id}
              className="settings-row"
              style={{
                padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 10,
                opacity: r.isActive ? 1 : 0.5,
              }}
            >
              <div className="settings-row-main">
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                {r.description && (
                  <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 2 }}>{r.description}</div>
                )}
                <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
                  {r.permissions.length} · {r._count?.users ?? 0}
                </div>
              </div>
              <div className="settings-row-actions">
                <button className="btn btn-sm btn-secondary" onClick={() => onToggle(r)}>
                  {r.isActive ? t('settings.penalties.disable') : t('settings.penalties.enable')}
                </button>
                <button className="btn btn-sm btn-secondary" onClick={() => setEditing(r)}>
                  {t('common.edit')}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => onDelete(r)}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RoleForm({
  initial, catalog, onCancel, onSaved,
}: {
  initial: CustomRole | null;
  catalog: PermissionDef[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(initial?.permissions ?? []));
  const [saving, setSaving] = useState(false);

  /**
   * Группируем permissions по секции сайдбара + сортируем группы по
   * PERMISSION_GROUP_ORDER — чтобы порядок групп в UI («CRM → Связь →
   * Финансы → Аналитика → HR → Обучение → Партнёры → Настройки»)
   * не зависел от порядка записей в backend PERMISSION_CATALOG.
   * Внутри группы сохраняем порядок, полученный от бэка (там уже
   * логически: read → create → update → delete → доп. actions).
   */
  const grouped = useMemo(() => {
    const map = new Map<string, PermissionDef[]>();
    for (const p of catalog) {
      if (!map.has(p.group)) map.set(p.group, []);
      map.get(p.group)!.push(p);
    }
    const entries = Array.from(map.entries());
    entries.sort(([a], [b]) => {
      const ia = PERMISSION_GROUP_ORDER.indexOf(a);
      const ib = PERMISSION_GROUP_ORDER.indexOf(b);
      // Неизвестные группы (если backend добавит новую раньше фронта)
      // уводим в конец, но сохраняем стабильный алфавитный порядок.
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return entries;
  }, [catalog]);

  const toggle = (key: string) => {
    const next = new Set(perms);
    if (next.has(key)) next.delete(key); else next.add(key);
    setPerms(next);
  };

  const save = async () => {
    if (!name.trim()) return toast(t('toast.error'), 'error');
    setSaving(true);
    try {
      if (initial) {
        await updateCustomRole(initial.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          permissions: Array.from(perms),
        });
        toast(t('toast.updated'), 'success');
      } else {
        await createCustomRole({
          name: name.trim(),
          description: description.trim() || undefined,
          permissions: Array.from(perms),
        });
        toast(t('toast.created'), 'success');
      }
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      border: '1px solid var(--border-soft)',
      borderRadius: 12,
      padding: 16,
      background: 'var(--bg-soft)',
      marginBottom: 16,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Field label={t('settings.roles.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
        </Field>
        <Field label={t('settings.roles.description')}>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </Field>
      </div>

      <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600 }}>
        {t('settings.roles.permissions')} ({perms.size})
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {grouped.map(([group, items]) => (
          <div key={group} style={{
            border: '1px solid var(--border)', borderRadius: 10,
            padding: '10px 12px', background: 'var(--bg)',
          }}>
            <div style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--text-soft)',
              marginBottom: 8,
            }}>{group}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {items.map((p) => (
                <label key={p.key} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 13, cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={perms.has(p.key)}
                    onChange={() => toggle(p.key)}
                  />
                  <span>{p.label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn btn-sm btn-secondary" onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : (initial ? t('common.save') : t('common.create'))}
        </button>
      </div>
    </div>
  );
}

// ===== Зарплата (базовые ставки + тарифная сетка комиссии) =====

function SalaryTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <SalaryRosterSection />
      <BonusTiersSection />
    </div>
  );
}

/**
 * Красивый input для salary roster — без браузерных спиннер-стрелок,
 * с suffix-юнитом справа («TJS», «TJS/ч», «%», «×»). Кружок-индикатор
 * рисуется если значение отличается от исходного (визуальный «dirty»).
 */
function RosterNumberInput({
  value, onChange, suffix, dirty, placeholder = '0', min = 0, max, step = 1, width,
}: {
  value: string | number;
  onChange: (v: string) => void;
  suffix?: string;
  dirty?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        border: `1.5px solid ${dirty ? 'var(--primary, #4f46e5)' : 'var(--border, #e2e8f0)'}`,
        borderRadius: 10,
        background: dirty ? 'var(--primary-light, #eef2ff)' : 'white',
        boxShadow: dirty ? '0 0 0 3px rgba(79,70,229,0.08)' : 'none',
        transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
        width: width ?? 'auto',
        minWidth: width ?? 100,
      }}
    >
      <input
        type="number"
        inputMode="decimal"
        value={value as any}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        // hide browser spinners + clean look
        className="roster-num-input"
        style={{
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
          fontSize: 14,
          fontWeight: 500,
          textAlign: 'right',
          padding: 0,
          width: '100%',
          color: 'var(--text, #0f172a)',
          MozAppearance: 'textfield',
        }}
      />
      {suffix && (
        <span style={{
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 11,
          color: 'var(--text-soft, #64748b)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          {suffix}
        </span>
      )}
    </div>
  );
}

function SalaryRosterSection() {
  const { toast } = useUI();
  const { t } = useT();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['salary-settings'],
    queryFn: listSalarySettings,
  });
  const items = query.data ?? [];

  // Локальные «черновики» полей по userId — чтобы можно было править
  // несколько строк без авто-сохранения на каждый keystroke.
  const [edits, setEdits] = useState<Record<string, Partial<UserSalarySettings>>>({});

  const setField = (userId: string, field: keyof UserSalarySettings, value: any) => {
    setEdits((e) => ({ ...e, [userId]: { ...e[userId], [field]: value } }));
  };

  const save = async (u: UserSalarySettings) => {
    const patch = edits[u.id];
    if (!patch || Object.keys(patch).length === 0) return;
    try {
      await updateUserSalary(u.id, {
        baseSalary: patch.baseSalary === undefined ? undefined : Number(patch.baseSalary),
        hourlyRate: patch.hourlyRate === undefined ? undefined : Number(patch.hourlyRate),
        bonusPercent: patch.bonusPercent === undefined ? undefined : Number(patch.bonusPercent),
        overtimeMultiplier: patch.overtimeMultiplier === undefined ? undefined : Number(patch.overtimeMultiplier),
      });
      toast(t('toast.updated'), 'success');
      setEdits((e) => {
        const { [u.id]: _omit, ...rest } = e;
        return rest;
      });
      qc.invalidateQueries({ queryKey: ['salary-settings'] });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <div>
      <h3 style={{
        fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12,
      }}>
        {t('settings.salary.title')}
      </h3>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table" style={{ width: '100%', minWidth: 880 }}>
          <thead>
            <tr>
              <th>{t('salary.field.employee')}</th>
              <th>{t('settings.salary.field.base')}</th>
              <th>{t('settings.salary.field.hourly')}</th>
              <th>{t('settings.salary.field.bonusPercent')}</th>
              <th>{t('settings.salary.field.overtimeMult')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-soft)', padding: 16 }}>{t('common.loading')}</td></tr>
            )}
            {!query.isLoading && items.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-soft)', padding: 16 }}>{t('users.empty')}</td></tr>
            )}
            {items.map((u) => {
              const patch = edits[u.id] || {};
              const has = (k: keyof UserSalarySettings) => k in patch;
              /** Значение для input: если значение 0/null/undefined —
               *  показываем пустую строку (placeholder отрисует "0").
               *  Иначе курсор после "0" приводил к вводу "01500" вместо
               *  "1500" — пользователь не мог стереть ведущий ноль. */
              const val = (k: keyof UserSalarySettings, fallback: any) => {
                const v = has(k) ? patch[k] : fallback;
                if (v === null || v === undefined || v === 0 || v === '0') return '';
                return v;
              };
              const dirty = Object.keys(patch).length > 0;
              return (
                <tr key={u.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{u.fullName}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-soft)' }}>
                      {u.customRole?.name || u.role}
                    </div>
                  </td>
                  <td>
                    <RosterNumberInput
                      value={val('baseSalary', u.baseSalary) as any}
                      onChange={(v) => setField(u.id, 'baseSalary', v)}
                      suffix="TJS"
                      dirty={has('baseSalary')}
                      step={50}
                      width={140}
                    />
                  </td>
                  <td>
                    {(() => {
                      // Превью почасовой: считаем на лету от draft baseSalary
                      // (если редактируется) или от сохранённого. monthHours
                      // приходит с бэка как кол-во часов в текущем месяце
                      // по графику сотрудника (без обеда).
                      const draftBase = has('baseSalary')
                        ? Number(patch.baseSalary) || 0
                        : (u.baseSalary || 0);
                      const monthHours = u.monthHours || 0;
                      const computed = monthHours > 0 && draftBase > 0
                        ? Math.round((draftBase / monthHours) * 100) / 100
                        : 0;
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 10px',
                            border: '1.5px solid var(--border)',
                            borderRadius: 10,
                            background: 'var(--bg-soft)',
                            width: 130,
                            justifyContent: 'flex-end',
                          }}>
                            <span style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 14,
                              fontWeight: 600,
                              color: 'var(--text)',
                            }}>
                              {computed > 0 ? computed.toFixed(2) : '—'}
                            </span>
                            <span style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                              color: 'var(--text-soft)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.06em',
                            }}>TJS/ч</span>
                          </div>
                          <div style={{
                            fontSize: 10,
                            color: 'var(--text-soft)',
                            fontFamily: 'var(--font-mono)',
                          }}>
                            {monthHours > 0
                              ? `${draftBase} ÷ ${monthHours}ч`
                              : 'график не задан'}
                          </div>
                        </div>
                      );
                    })()}
                  </td>
                  <td>
                    <RosterNumberInput
                      value={val('bonusPercent', u.bonusPercent) as any}
                      onChange={(v) => setField(u.id, 'bonusPercent', v)}
                      suffix="%"
                      dirty={has('bonusPercent')}
                      max={100}
                      step={0.5}
                      width={100}
                    />
                  </td>
                  <td>
                    <RosterNumberInput
                      value={val('overtimeMultiplier', u.overtimeMultiplier ?? 1.5) as any}
                      onChange={(v) => setField(u.id, 'overtimeMultiplier', v)}
                      suffix="×"
                      dirty={has('overtimeMultiplier')}
                      min={1}
                      max={5}
                      step={0.1}
                      placeholder="1.5"
                      width={90}
                    />
                  </td>
                  <td>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => save(u)}
                      disabled={!dirty}
                    >
                      {t('common.save')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BonusTiersSection() {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['bonus-tiers'],
    queryFn: listBonusTiers,
  });
  const tiers = query.data ?? [];

  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [percent, setPercent] = useState('');
  const [comment, setComment] = useState('');

  const add = async () => {
    try {
      await createBonusTier({
        minAmount: parseFloat(minAmount),
        maxAmount: maxAmount === '' ? null : parseFloat(maxAmount),
        percent: parseFloat(percent),
        order: tiers.length + 1,
        comment: comment || undefined,
      });
      setMinAmount(''); setMaxAmount(''); setPercent(''); setComment('');
      qc.invalidateQueries({ queryKey: ['bonus-tiers'] });
      toast(t('toast.created'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const remove = async (tier: BonusTier) => {
    const ok = await confirm({
      title: t('common.delete') + '?',
      message: `${tier.minAmount} - ${tier.maxAmount ?? '∞'} TJS → ${tier.percent}%`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    await deleteBonusTier(tier.id);
    qc.invalidateQueries({ queryKey: ['bonus-tiers'] });
  };

  const toggleActive = async (tier: BonusTier) => {
    await updateBonusTier(tier.id, { isActive: !tier.isActive });
    qc.invalidateQueries({ queryKey: ['bonus-tiers'] });
  };

  return (
    <div>
      <h3 style={{
        fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 16,
      }}>
        {t('settings.salary.bonusTiers')}
      </h3>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 8, marginBottom: 16, padding: 12,
        border: '1px solid var(--border-soft)', borderRadius: 10,
        background: 'var(--bg-soft)',
      }}>
        <Field label={t('settings.salary.tier.from')}>
          <input type="number" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />
        </Field>
        <Field label={t('settings.penalties.maxLate')}>
          <input type="number" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />
        </Field>
        <Field label={t('settings.salary.tier.percent')}>
          <input type="number" step="0.1" value={percent} onChange={(e) => setPercent(e.target.value)} />
        </Field>
        <Field label={t('common.comment')}>
          <input value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <button
          className="btn btn-sm btn-primary"
          onClick={add}
          style={{ alignSelf: 'flex-end' }}
          disabled={!minAmount || !percent}
        >
          {t('settings.salary.tier.add')}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {tiers.length === 0 && (
          <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>
            {t('common.empty')}
          </div>
        )}
        {tiers.map((tier) => (
          <div
            key={tier.id}
            className="settings-row"
            style={{
              padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 8,
              opacity: tier.isActive ? 1 : 0.5,
            }}
          >
            <div className="settings-row-main">
              <div style={{ fontWeight: 500 }}>
                {tier.minAmount.toLocaleString('ru-RU')} - {tier.maxAmount === null ? '∞' : tier.maxAmount.toLocaleString('ru-RU')} {tier.currency}
                {' → '}
                <b>{tier.percent}%</b>
              </div>
              {tier.comment && (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{tier.comment}</div>
              )}
            </div>
            <div className="settings-row-actions">
              <button className="btn btn-sm btn-secondary" onClick={() => toggleActive(tier)}>
                {tier.isActive ? t('settings.penalties.disable') : t('settings.penalties.enable')}
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => remove(tier)}>{t('common.delete')}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
