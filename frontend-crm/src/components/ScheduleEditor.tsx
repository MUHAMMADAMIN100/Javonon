import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUI } from '../ui/Dialogs';
import {
  WEEKDAY_LABEL,
  type Weekday,
  type ScheduleDay,
  getSchedule,
  upsertSchedule,
  hhmmToMinutes,
  minutesToHHMM,
} from '../api/settings';

/**
 * Универсальный редактор рабочего графика для FOUNDER. Если userId=null
 * — редактируется дефолт компании. Если userId передан — индивидуальный
 * график конкретного сотрудника (по ТЗ §3: «изменять график работы
 * менеджеров» — каждого отдельно).
 */
export default function ScheduleEditor({
  userId,
  title,
  hint,
}: {
  userId: string | null;
  title?: string;
  hint?: string;
}) {
  const { toast } = useUI();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['settings', 'schedule', userId],
    queryFn: () => getSchedule(userId),
  });
  const [draft, setDraft] = useState<ScheduleDay[]>([]);

  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);

  const update = (idx: number, patch: Partial<ScheduleDay>) => {
    setDraft((cur) => cur.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  const save = async () => {
    try {
      await upsertSchedule(userId, draft);
      qc.invalidateQueries({ queryKey: ['settings', 'schedule', userId] });
      toast('График сохранён', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  if (query.isLoading) return <div>Загружаем график…</div>;

  return (
    <div>
      {title && (
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.12em',
          color: 'var(--primary-dark)',
          marginBottom: 6,
        }}>
          {title}
        </div>
      )}
      {hint && (
        <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 16 }}>{hint}</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {draft.map((d, idx) => (
          <DayRow key={d.weekday} day={d} onChange={(patch) => update(idx, patch)} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn btn-primary" onClick={save}>Сохранить график</button>
      </div>
    </div>
  );
}

function DayRow({ day, onChange }: { day: ScheduleDay; onChange: (patch: Partial<ScheduleDay>) => void }) {
  const setTime = (field: keyof ScheduleDay, hhmm: string) => {
    onChange({ [field]: hhmmToMinutes(hhmm) } as any);
  };
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '120px 100px 1fr 1fr 1fr 1fr',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: day.isWorkday ? 'transparent' : 'var(--bg-soft)',
    }}>
      <div style={{ fontWeight: 500 }}>{WEEKDAY_LABEL[day.weekday as Weekday]}</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={day.isWorkday}
          onChange={(e) => onChange({ isWorkday: e.target.checked })}
        />
        рабочий
      </label>
      <TimeField label="Начало" value={minutesToHHMM(day.startMinute)} onChange={(v) => setTime('startMinute', v)} disabled={!day.isWorkday} />
      <TimeField label="Конец" value={minutesToHHMM(day.endMinute)} onChange={(v) => setTime('endMinute', v)} disabled={!day.isWorkday} />
      <TimeField
        label="Обед нач."
        value={day.lunchStartMinute !== null ? minutesToHHMM(day.lunchStartMinute) : ''}
        onChange={(v) => onChange({ lunchStartMinute: v ? hhmmToMinutes(v) : null })}
        disabled={!day.isWorkday}
      />
      <TimeField
        label="Обед кон."
        value={day.lunchEndMinute !== null ? minutesToHHMM(day.lunchEndMinute) : ''}
        onChange={(v) => onChange({ lunchEndMinute: v ? hhmmToMinutes(v) : null })}
        disabled={!day.isWorkday}
      />
    </div>
  );
}

function TimeField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}
      />
    </div>
  );
}
