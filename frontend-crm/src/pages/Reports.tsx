import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { reportToday, reportsMine, upsertReport, type DailyReport } from '../api/reports';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', weekday: 'short' });
}

export default function Reports() {
  const { toast } = useUI();
  const [today, setToday] = useState<DailyReport | null>(null);
  const [history, setHistory] = useState<DailyReport[]>([]);
  const [calls, setCalls] = useState('0');
  const [meetings, setMeetings] = useState('0');
  const [contacted, setContacted] = useState('0');
  const [activity, setActivity] = useState('');
  const [challenges, setChallenges] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    try {
      const t = await reportToday();
      setToday(t);
      if (t) {
        setCalls(String(t.callsCount));
        setMeetings(String(t.meetingsCount));
        setContacted(String(t.applicationsContacted));
        setActivity(t.activitySummary || '');
        setChallenges(t.challenges || '');
      }
      const h = await reportsMine({ take: 30 });
      setHistory(h);
    } catch {}
  };
  useEffect(() => { refresh(); }, []);

  const onSave = async () => {
    setSaving(true);
    try {
      await upsertReport({
        callsCount: parseInt(calls, 10) || 0,
        meetingsCount: parseInt(meetings, 10) || 0,
        applicationsContacted: parseInt(contacted, 10) || 0,
        activitySummary: activity.trim() || undefined,
        challenges: challenges.trim() || undefined,
      });
      toast('Отчёт сохранён', 'success');
      await refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setSaving(false);
    }
  };

  const totalCalls = history.reduce((s, r) => s + r.callsCount, 0);
  const totalMeetings = history.reduce((s, r) => s + r.meetingsCount, 0);
  const totalContacted = history.reduce((s, r) => s + r.applicationsContacted, 0);

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">DAILY REPORT · 11</span>
        <h2 className="crm-section-title">
          Сегодняшний <em>отчёт.</em>
        </h2>
      </div>

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 28, marginBottom: 24 }}
      >
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.16em',
          color: 'var(--primary-dark)',
          marginBottom: 6,
        }}>{today ? 'EDITED · TODAY' : 'NEW · TODAY'}</div>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginBottom: 24,
        }}>
          Что ты сделал <em style={{
            fontFamily: 'Times New Roman, Georgia, serif',
            fontWeight: 400,
            color: 'var(--primary-dark)',
          }}>сегодня?</em>
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <NumberField label="Звонков" value={calls} onChange={setCalls} />
          <NumberField label="Встреч" value={meetings} onChange={setMeetings} />
          <NumberField label="Заявок обработано" value={contacted} onChange={setContacted} />
        </div>

        <div className="form-group" style={{ marginTop: 16 }}>
          <label>Что сделал за день</label>
          <textarea
            value={activity}
            onChange={(e) => setActivity(e.target.value)}
            placeholder="Краткое описание главных результатов дня"
            rows={3}
          />
        </div>
        <div className="form-group">
          <label>Блокеры / проблемы</label>
          <textarea
            value={challenges}
            onChange={(e) => setChallenges(e.target.value)}
            placeholder="Что мешало, нужна ли помощь"
            rows={2}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            <Icon name="save" size={16} /> {saving ? 'Сохраняем...' : 'Сохранить отчёт'}
          </button>
        </div>
      </motion.div>

      {/* Сводка за период */}
      <div className="bento" style={{ marginBottom: 24 }}>
        <SmallStat eyebrow="CALLS · 30 DAYS" value={String(totalCalls)} label="Всего звонков" span="span-2" />
        <SmallStat eyebrow="MEETINGS · 30 DAYS" value={String(totalMeetings)} label="Встреч" span="span-2" />
        <SmallStat eyebrow="APPS · 30 DAYS" value={String(totalContacted)} label="Заявок обработано" span="span-2" />
      </div>

      {/* История */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">HISTORY · LAST 30 DAYS</span>
        <h2 className="crm-section-title">
          Журнал <em>отчётов.</em>
        </h2>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Звонки</th>
              <th>Встречи</th>
              <th>Заявки</th>
              <th>Активность</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 && <tr><td colSpan={5} className="empty">Пока нет отчётов</td></tr>}
            {history.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 500 }}>{fmtDate(r.date)}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{r.callsCount}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{r.meetingsCount}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{r.applicationsContacted}</td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{r.activitySummary || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          fontWeight: 500,
        }}
      />
    </div>
  );
}

function SmallStat({ eyebrow, value, label, span = 'span-2' }: {
  eyebrow: string; value: string; label: string; span?: string;
}) {
  return (
    <motion.div
      className={`bento-card ${span}`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <span className="bento-num">{eyebrow}</span>
      <div style={{ marginTop: 'auto' }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(40px, 5vw, 56px)',
          fontWeight: 500,
          letterSpacing: '-0.04em',
          lineHeight: 0.9,
          marginBottom: 12,
        }}>{value}</div>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          color: 'var(--text-soft)',
          textTransform: 'uppercase',
        }}>{label}</div>
      </div>
    </motion.div>
  );
}
