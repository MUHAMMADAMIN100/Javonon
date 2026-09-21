import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { reportToday, reportsMine, upsertReport, type DailyReport } from '../api/reports';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import { keys } from '../lib/queryKeys';
import { optimistic, useOptimisticMutation } from '../lib/optimistic';
import { useT } from '../lib/i18n';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', weekday: 'short' });
}

export default function Reports() {
  const { toast } = useUI();
  const { t } = useT();
  const [formOpen, setFormOpen] = useState(false);
  const [calls, setCalls] = useState('0');
  const [meetings, setMeetings] = useState('0');
  const [contacted, setContacted] = useState('0');
  const [salesCount, setSalesCount] = useState('0');
  const [salesAmount, setSalesAmount] = useState('0');
  const [offlineConsult, setOfflineConsult] = useState('0');
  const [onlineConsult, setOnlineConsult] = useState('0');
  const [activity, setActivity] = useState('');
  const [challenges, setChallenges] = useState('');

  const todayKey = keys.reports.today();
  const todayQuery = useQuery<DailyReport | null>({
    queryKey: todayKey,
    queryFn: () => reportToday(),
  });
  const today = todayQuery.data ?? null;

  const historyKey = keys.reports.mine({ take: 30 });
  const historyQuery = useQuery<DailyReport[]>({
    queryKey: historyKey,
    queryFn: () => reportsMine({ take: 30 }),
  });
  const history = historyQuery.data ?? [];
  const sort = useTableSort(history, [
    { key: 'date', label: t('reports.col.date'), type: 'date', value: (r) => r.date },
    { key: 'calls', label: t('reports.field.calls'), type: 'number', value: (r) => r.callsCount },
    { key: 'meetings', label: t('reports.field.meetings'), type: 'number', value: (r) => r.meetingsCount },
    { key: 'applications', label: t('reports.field.applications'), type: 'number', value: (r) => r.applicationsContacted },
    { key: 'salesCount', label: t('reports.field.salesCount'), type: 'number', value: (r) => r.salesCount },
    { key: 'salesAmount', label: t('reports.field.salesAmount'), type: 'number', value: (r) => r.salesAmount },
    { key: 'activity', label: t('reports.field.activity'), value: (r) => r.activitySummary },
  ]);

  // При загрузке/обновлении today — синкаем форму.
  useEffect(() => {
    if (today) {
      setCalls(String(today.callsCount));
      setMeetings(String(today.meetingsCount));
      setContacted(String(today.applicationsContacted));
      setSalesCount(String(today.salesCount));
      setSalesAmount(String(today.salesAmount));
      setOfflineConsult(String(today.offlineConsultations ?? 0));
      setOnlineConsult(String(today.onlineConsultations ?? 0));
      setActivity(today.activitySummary || '');
      setChallenges(today.challenges || '');
    }
  }, [today?.id, today?.callsCount, today?.meetingsCount, today?.applicationsContacted, today?.salesCount, today?.salesAmount, today?.offlineConsultations, today?.onlineConsultations, today?.activitySummary, today?.challenges]);

  // Оптимистично патчим today + invalidate history.
  const upsertMut = useOptimisticMutation<DailyReport, Parameters<typeof upsertReport>[0], DailyReport | null>({
    mutationFn: upsertReport,
    queryKey: todayKey,
    applyOptimistic: (cur, dto) => optimistic.patch(cur || ({} as DailyReport), dto as Partial<DailyReport>),
    invalidateAlso: [historyKey],
    onSuccess: () => toast('Отчёт сохранён', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });
  const saving = upsertMut.isPending;

  const onSave = () => {
    upsertMut.mutate({
      callsCount: parseInt(calls, 10) || 0,
      meetingsCount: parseInt(meetings, 10) || 0,
      applicationsContacted: parseInt(contacted, 10) || 0,
      salesCount: parseInt(salesCount, 10) || 0,
      salesAmount: parseFloat(salesAmount) || 0,
      offlineConsultations: parseInt(offlineConsult, 10) || 0,
      onlineConsultations: parseInt(onlineConsult, 10) || 0,
      activitySummary: activity.trim() || undefined,
      challenges: challenges.trim() || undefined,
    }, {
      // Отчёт сохранён — окно закрываем, история под ним уже обновилась.
      onSuccess: () => setFormOpen(false),
    });
  };

  const totalCalls = history.reduce((s, r) => s + r.callsCount, 0);
  const totalMeetings = history.reduce((s, r) => s + r.meetingsCount, 0);
  const totalContacted = history.reduce((s, r) => s + r.applicationsContacted, 0);
  const totalSalesCount = history.reduce((s, r) => s + r.salesCount, 0);
  const totalSalesAmount = history.reduce((s, r) => s + r.salesAmount, 0);

  return (
    <>
      {/* Отчёт сдают раз в день, поэтому форма живёт за кнопкой, а не
          занимает верх экрана постоянно. Подпись кнопки говорит, отчёт за
          сегодня уже сдан или ещё нет. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button className="btn btn-primary" data-testid="report-new" onClick={() => setFormOpen(true)}>
          <Icon name={today ? 'edit' : 'add'} size={16} />
          {today ? t('reports.editToday') : t('reports.new')}
        </button>
      </div>

      <FormModal
        open={formOpen}
        title={today ? t('reports.editToday') : t('reports.new')}
        onClose={() => setFormOpen(false)}
        busy={saving}
        testId="report-form"
      >

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
          <NumberField label={t('reports.field.calls')} value={calls} onChange={setCalls} />
          <NumberField label={t('reports.field.meetings')} value={meetings} onChange={setMeetings} />
          <NumberField label={t('reports.field.applications')} value={contacted} onChange={setContacted} />
          <NumberField label={t('reports.field.offline')} value={offlineConsult} onChange={setOfflineConsult} />
          <NumberField label={t('reports.field.online')} value={onlineConsult} onChange={setOnlineConsult} />
          <NumberField label={t('reports.field.salesCount')} value={salesCount} onChange={setSalesCount} highlight />
          <NumberField label={t('reports.field.salesAmount')} value={salesAmount} onChange={setSalesAmount} highlight />
        </div>

        <div className="form-group" style={{ marginTop: 16 }}>
          <label>{t('reports.field.activity')}</label>
          <textarea
            className="crm-textarea"
            value={activity}
            onChange={(e) => setActivity(e.target.value)}
            rows={3}
          />
        </div>
        <div className="form-group">
          <label>{t('reports.field.challenges')}</label>
          <textarea
            className="crm-textarea"
            value={challenges}
            onChange={(e) => setChallenges(e.target.value)}
            rows={2}
          />
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            <Icon name="save" size={16} /> {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </FormModal>

      {/* Сводка за период */}
      <div className="bento" style={{ marginBottom: 24 }}>
        <SmallStat eyebrow={t('eyebrow.sales30')} value={`$${totalSalesAmount.toLocaleString('ru-RU')}`} label={t('reports.up.totalSales')} span="span-3" accent />
        <SmallStat eyebrow={t('eyebrow.deals30')} value={String(totalSalesCount)} label={t('reports.up.dealsClosed')} span="span-3" />
        <SmallStat eyebrow={t('eyebrow.calls')} value={String(totalCalls)} label={t('reports.up.calls')} span="span-2" />
        <SmallStat eyebrow={t('eyebrow.meetings')} value={String(totalMeetings)} label={t('reports.up.meetings')} span="span-2" />
        <SmallStat eyebrow={t('eyebrow.apps')} value={String(totalContacted)} label={t('reports.up.apps')} span="span-2" />
      </div>

      {/* История */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">{t('eyebrow.historyLast30')}</span>
        <h2 className="crm-section-title">{t('reports.history')}</h2>
      </div>
      {history.length > 0 && <SortSelect sort={sort} />}
      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
            </tr>
          </thead>
          <tbody>
            {history.length === 0 && <tr><td colSpan={7} className="empty">{t('reports.empty')}</td></tr>}
            {sort.sorted.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 500 }}>{fmtDate(r.date)}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{r.callsCount}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{r.meetingsCount}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{r.applicationsContacted}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--primary-dark)' }}>{r.salesCount}</td>
                <td style={{ fontFamily: 'var(--font-display)', fontWeight: 500, color: 'var(--primary-dark)' }}>${r.salesAmount.toLocaleString('ru-RU')}</td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{r.activitySummary || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NumberField({ label, value, onChange, highlight }: {
  label: string; value: string; onChange: (v: string) => void; highlight?: boolean;
}) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label style={highlight ? { color: 'var(--primary-dark)' } : undefined}>{label}</label>
      <input
        type="number"
        min={0}
        step={highlight ? '0.01' : 1}
        value={value}
        onFocus={(e) => {
          // Если в поле стоит "0" — сразу выделяем, чтобы первое нажатие
          // цифры затёрло нолик, а не дописало к нему ("03" → пользователь
          // не мог стереть ведущий 0). UX-фикс по скриншоту.
          if (value === '0' || value === '') e.currentTarget.select();
        }}
        onChange={(e) => {
          let v = e.target.value;
          // Убираем leading zeros у целых чисел: "03" → "3", "001" → "1".
          // Десятичные ("0.5") не трогаем. Пустое — оставляем пустым.
          if (v.length > 1 && v.startsWith('0') && !v.startsWith('0.')) {
            v = v.replace(/^0+/, '') || '0';
          }
          onChange(v);
        }}
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          fontWeight: 500,
          borderColor: highlight ? 'var(--primary)' : undefined,
        }}
      />
    </div>
  );
}

function SmallStat({ eyebrow, value, label, span = 'span-2', accent }: {
  eyebrow: string; value: string; label: string; span?: string; accent?: boolean;
}) {
  return (
    <motion.div
      className={`bento-card ${accent ? 'accent' : ''} ${span}`}
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
