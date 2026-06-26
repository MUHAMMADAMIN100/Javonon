import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import {
  WEEKDAY_LABEL,
  type Weekday,
  type ScheduleDay,
  getSchedule,
  upsertSchedule,
  deleteSchedule,
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
  const { toast, confirm } = useUI();
  const { t } = useT();
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
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  if (query.isLoading) return <div>{t('common.loading')}</div>;

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, gap: 12, flexWrap: 'wrap' }}>
        <button
          className="btn btn-sm btn-secondary"
          onClick={async () => {
            const ok = await confirm({
              title: t('schedule.confirm.reset'),
              message: '',
              danger: true,
              confirmText: t('common.reset'),
            });
            if (!ok) return;
            try {
              await deleteSchedule(userId);
              qc.invalidateQueries({ queryKey: ['settings', 'schedule', userId] });
              toast(t('toast.updated'), 'success');
            } catch (e: any) {
              toast(e?.response?.data?.message || t('toast.error'), 'error');
            }
          }}
          title={t('common.reset')}
        >
          {t('common.reset')}
        </button>
        <button className="btn btn-primary" onClick={save}>{t('common.save')}</button>
      </div>
    </div>
  );
}

function DayRow({ day, onChange }: { day: ScheduleDay; onChange: (patch: Partial<ScheduleDay>) => void }) {
  const { t } = useT();
  const setTime = (field: keyof ScheduleDay, hhmm: string) => {
    onChange({ [field]: hhmmToMinutes(hhmm) } as any);
  };
  return (
    <div
      className="schedule-day-row"
      style={{
        padding: '10px 12px',
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: day.isWorkday ? 'transparent' : 'var(--bg-soft)',
      }}
    >
      <div className="schedule-day-head">
        <div style={{ fontWeight: 500, flex: '1 1 auto' }}>
          {t(`weekday.${day.weekday}`) !== `weekday.${day.weekday}` ? t(`weekday.${day.weekday}`) : WEEKDAY_LABEL[day.weekday as Weekday]}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={day.isWorkday}
            onChange={(e) => onChange({ isWorkday: e.target.checked })}
          />
          {t('schedule.workday')}
        </label>
      </div>
      <div className="schedule-day-times">
        <TimeField label={t('schedule.field.start')} value={minutesToHHMM(day.startMinute)} onChange={(v) => setTime('startMinute', v)} disabled={!day.isWorkday} />
        <TimeField label={t('schedule.field.end')} value={minutesToHHMM(day.endMinute)} onChange={(v) => setTime('endMinute', v)} disabled={!day.isWorkday} />
        <TimeField
          label={t('schedule.field.lunchStart')}
          value={day.lunchStartMinute !== null ? minutesToHHMM(day.lunchStartMinute) : ''}
          onChange={(v) => onChange({ lunchStartMinute: v ? hhmmToMinutes(v) : null })}
          disabled={!day.isWorkday}
        />
        <TimeField
          label={t('schedule.field.lunchEnd')}
          value={day.lunchEndMinute !== null ? minutesToHHMM(day.lunchEndMinute) : ''}
          onChange={(v) => onChange({ lunchEndMinute: v ? hhmmToMinutes(v) : null })}
          disabled={!day.isWorkday}
        />
      </div>
    </div>
  );
}

function TimeField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{
        fontSize: 10,
        color: 'var(--text-soft)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>{label}</span>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, width: '100%', minWidth: 0 }}
      />
    </div>
  );
}
