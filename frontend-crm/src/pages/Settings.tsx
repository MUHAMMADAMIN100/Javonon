import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useUI } from '../ui/Dialogs';
import {
  type PenaltyRule,
  type WorkLocation,
  listPenaltyRules,
  createPenaltyRule,
  updatePenaltyRule,
  deletePenaltyRule,
  getActiveLocation,
  createLocation,
  updateLocation,
} from '../api/settings';
import ScheduleEditor from '../components/ScheduleEditor';

type Tab = 'schedule' | 'penalties' | 'location';

export default function Settings() {
  const me = useAuth((s) => s.user);
  const [tab, setTab] = useState<Tab>('schedule');

  if (!isFounder(me)) {
    return (
      <div className="card" style={{ padding: 28 }}>
        Раздел доступен только основателю.
      </div>
    );
  }

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">SYSTEM</span>
        <h2 className="crm-section-title">
          Настройки <em>компании.</em>
        </h2>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{
          display: 'flex',
          borderBottom: '1px solid var(--border)',
          gap: 4,
          padding: '8px 8px 0',
        }}>
          <TabButton active={tab === 'schedule'} onClick={() => setTab('schedule')} label="График работы" />
          <TabButton active={tab === 'penalties'} onClick={() => setTab('penalties')} label="Штрафы" />
          <TabButton active={tab === 'location'} onClick={() => setTab('location')} label="Гео-зона" />
        </div>
        <div style={{ padding: 24 }}>
          {tab === 'schedule' && <ScheduleTab />}
          {tab === 'penalties' && <PenaltiesTab />}
          {tab === 'location' && <LocationTab />}
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
      }}
    >
      {label}
    </button>
  );
}

// ===== Schedule (вынесено в ScheduleEditor — компонент шарится с UserDetail.tsx) =====

function ScheduleTab() {
  return (
    <ScheduleEditor
      userId={null}
      hint="Дефолтный график для всех сотрудников. Индивидуальный график конкретного сотрудника задаётся в его карточке."
    />
  );
}

// ===== Penalties =====

function PenaltiesTab() {
  const { toast, confirm } = useUI();
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
      toast('Правило добавлено', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  const remove = async (r: PenaltyRule) => {
    const ok = await confirm({
      title: 'Удалить правило?',
      message: `Штраф ${r.amount} ${r.currency} при опоздании ≥${r.minLateMinutes} мин`,
      danger: true,
      confirmText: 'Удалить',
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
        Ступенчатая шкала штрафов за опоздание. Если правило не подходит — система
        возвращается к старой формуле (200 TJS + 50 за каждое повторное).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 16, padding: 12, border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--bg-soft)' }}>
        <Field label="От, мин"><input type="number" value={minLate} onChange={(e) => setMinLate(e.target.value)} /></Field>
        <Field label="До, мин (пусто = ∞)"><input type="number" value={maxLate} onChange={(e) => setMaxLate(e.target.value)} /></Field>
        <Field label="Сумма (TJS)"><input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Комментарий"><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="например: за час и больше" /></Field>
        <button className="btn btn-sm btn-primary" onClick={add} style={{ alignSelf: 'flex-end' }}>Добавить</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rules.length === 0 && <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>Правил пока нет — используется fallback (200+50/повтор).</div>}
        {rules.map((r) => (
          <div key={r.id} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 14px', border: '1px solid var(--border)', borderRadius: 8,
            opacity: r.isActive ? 1 : 0.5,
          }}>
            <div>
              <div style={{ fontWeight: 500 }}>
                {r.minLateMinutes}-{r.maxLateMinutes ?? '∞'} мин → <b>{r.amount} {r.currency}</b>
              </div>
              {r.comment && <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{r.comment}</div>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm btn-secondary" onClick={() => toggleActive(r)}>
                {r.isActive ? 'Выкл' : 'Вкл'}
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => remove(r)}>Удалить</button>
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
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['settings', 'work-location'],
    queryFn: () => getActiveLocation(),
  });
  const loc = query.data;

  const [name, setName] = useState('Главный офис');
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
    if (!navigator.geolocation) return toast('Геолокация недоступна в браузере', 'error');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(String(pos.coords.latitude));
        setLng(String(pos.coords.longitude));
        toast('Координаты получены', 'success');
      },
      (e) => toast('Не удалось получить координаты: ' + e.message, 'error'),
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
      toast('Локация сохранена', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 16 }}>
        Радиус, внутри которого сотрудник может «Начать работу» по геолокации. Если
        он за пределами — будет видеть фото/видео-альтернативу.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label="Название"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Широта"><input type="number" step="0.0000001" value={lat} onChange={(e) => setLat(e.target.value)} /></Field>
        <Field label="Долгота"><input type="number" step="0.0000001" value={lng} onChange={(e) => setLng(e.target.value)} /></Field>
        <Field label="Радиус, м"><input type="number" value={radius} onChange={(e) => setRadius(e.target.value)} /></Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16, gap: 8 }}>
        <button className="btn btn-sm btn-secondary" onClick={detect}>📍 Использовать текущую</button>
        <button className="btn btn-primary" onClick={save} disabled={!lat || !lng}>Сохранить</button>
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
