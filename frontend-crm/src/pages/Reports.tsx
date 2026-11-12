import { fmtDateText, TJ_TZ, tjLastDaysRange } from '../lib/tjTime';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteReport, reportToday, reportsMine, upsertReport, type DailyReport } from '../api/reports';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import { keys } from '../lib/queryKeys';
import { optimistic, useOptimisticMutation } from '../lib/optimistic';
import { useT } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { roleCan } from '../lib/permissions';

/** Сумма продаж — в сомони, как везде в CRM. */
function fmtTjs(n: number) {
  return `${n.toLocaleString('ru-RU')} TJS`;
}

/** Длина текста отчёта — как проверяет сервер (daily-reports.service). */
const MAX_REPORT_TEXT = 2000;

function fmtDate(iso: string) {
  return fmtDateText(iso, { day: '2-digit', month: 'short', weekday: 'short', timeZone: TJ_TZ });
}

export default function Reports() {
  // Свой отчёт за день: роль — «Ежедневные отчёты — свой отчёт за день».
  const canWrite = roleCan(useAuth((s) => s.user), 'reports:create');
  const { toast, confirm } = useUI();
  const { t } = useT();
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  /** Ошибки полей: показываются под полем после попытки сохранить. */
  const [errs, setErrs] = useState<Record<string, string>>({});
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

  // «30 дней» — это последние 30 календарных дней (сегодня и 29 до него),
  // а не 30 последних отчётов: раньше в «30 дней» попадал отчёт от июня.
  const last30 = tjLastDaysRange(30);
  const historyParams = { from: last30.from, to: last30.to, take: 31 };
  const historyKey = keys.reports.mine(historyParams);
  const historyQuery = useQuery<DailyReport[]>({
    queryKey: historyKey,
    queryFn: () => reportsMine(historyParams),
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

  /**
   * Форма = сохранённый отчёт за сегодня (или нули). QA-3 (BUG-04): раньше
   * поля заполнялись только при загрузке, и после «Отмена» в форме оставались
   * отменённые значения. Теперь форма сбрасывается при КАЖДОМ открытии и при
   * отмене — «Отмена» значит «ничего не менял».
   */
  const resetForm = () => {
    setCalls(String(today?.callsCount ?? 0));
    setMeetings(String(today?.meetingsCount ?? 0));
    setContacted(String(today?.applicationsContacted ?? 0));
    setSalesCount(String(today?.salesCount ?? 0));
    setSalesAmount(String(today?.salesAmount ?? 0));
    setOfflineConsult(String(today?.offlineConsultations ?? 0));
    setOnlineConsult(String(today?.onlineConsultations ?? 0));
    setActivity(today?.activitySummary || '');
    setChallenges(today?.challenges || '');
    setErrs({});
  };
  const openForm = () => { resetForm(); setFormOpen(true); };
  const closeForm = () => { setFormOpen(false); resetForm(); };
  // Отчёт подгрузился или обновился, пока окно закрыто, — держим поля в ногу.
  useEffect(() => {
    if (!formOpen) resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today?.id, today?.callsCount, today?.meetingsCount, today?.applicationsContacted, today?.salesCount, today?.salesAmount, today?.offlineConsultations, today?.onlineConsultations, today?.activitySummary, today?.challenges]);

  // Оптимистично патчим today + invalidate history.
  const upsertMut = useOptimisticMutation<DailyReport, Parameters<typeof upsertReport>[0], DailyReport | null>({
    mutationFn: upsertReport,
    queryKey: todayKey,
    applyOptimistic: (cur, dto) => optimistic.patch(cur || ({} as DailyReport), dto as Partial<DailyReport>),
    invalidateAlso: [historyKey],
    onSuccess: () => toast(t('reports.toast.saved'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const saving = upsertMut.isPending;

  // QA-3 (BUG-05): числа проверяются, а не «чинятся» молча. Раньше «1.5»
  // превращалось в 15, а «-5» в 5 — человек сохранял не то, что ввёл.
  const intOf = (raw: string): number | null => (/^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : raw.trim() === '' ? 0 : null);
  const moneyOf = (raw: string): number | null => {
    const v = raw.trim().replace(',', '.');
    if (v === '') return 0;
    return /^\d{1,9}(\.\d{1,2})?$/.test(v) ? Number(v) : null;
  };
  const onSave = () => {
    const ints = { calls, meetings, contacted, salesCount, offlineConsult, onlineConsult } as const;
    const next: Record<string, string> = {};
    const nums: Record<string, number> = {};
    for (const [k, raw] of Object.entries(ints)) {
      const n = intOf(raw);
      if (n === null) next[k] = t('reports.err.int');
      else nums[k] = n;
    }
    const amount = moneyOf(salesAmount);
    if (amount === null) next.salesAmount = t('reports.err.money');
    else if (amount > 0 && nums.salesCount === 0) next.salesCount = t('reports.err.salesCount');
    setErrs(next);
    if (Object.keys(next).length) {
      toast(t('reports.err.fix'), 'error');
      return;
    }
    upsertMut.mutate({
      callsCount: nums.calls,
      meetingsCount: nums.meetings,
      applicationsContacted: nums.contacted,
      salesCount: nums.salesCount,
      salesAmount: amount as number,
      offlineConsultations: nums.offlineConsult,
      onlineConsultations: nums.onlineConsult,
      activitySummary: activity.trim() || undefined,
      challenges: challenges.trim() || undefined,
    }, {
      // Отчёт сохранён — окно закрываем, история под ним уже обновилась.
      onSuccess: () => setFormOpen(false),
    });
  };

  // QA-3 (BUG-06): свой отчёт можно удалить — с подтверждением и датой в тексте.
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteReport(id),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: todayKey }), qc.invalidateQueries({ queryKey: historyKey })]).catch(() => undefined);
      toast(t('reports.toast.deleted'), 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const onDelete = async (r: DailyReport) => {
    const ok = await confirm({
      title: t('reports.delete.title'),
      message: t('reports.delete.message').replace('{date}', fmtDate(r.date)),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (ok) deleteMut.mutate(r.id);
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
        {canWrite && (
          <button className="btn btn-primary" data-testid="report-new" onClick={openForm}>
            <Icon name={today ? 'edit' : 'add'} size={16} />
            {today ? t('reports.editToday') : t('reports.new')}
          </button>
        )}
      </div>

      <FormModal
        open={formOpen}
        title={today ? t('reports.editToday') : t('reports.new')}
        onClose={closeForm}
        busy={saving}
        testId="report-form"
      >

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
          <NumberField name="calls" label={t('reports.field.calls')} value={calls} onChange={setCalls} error={errs.calls} />
          <NumberField name="meetings" label={t('reports.field.meetings')} value={meetings} onChange={setMeetings} error={errs.meetings} />
          <NumberField name="contacted" label={t('reports.field.applications')} value={contacted} onChange={setContacted} error={errs.contacted} />
          <NumberField name="offline" label={t('reports.field.offline')} value={offlineConsult} onChange={setOfflineConsult} error={errs.offlineConsult} />
          <NumberField name="online" label={t('reports.field.online')} value={onlineConsult} onChange={setOnlineConsult} error={errs.onlineConsult} />
          <NumberField name="salesCount" label={t('reports.field.salesCount')} value={salesCount} onChange={setSalesCount} error={errs.salesCount} highlight />
          <NumberField name="salesAmount" label={t('reports.field.salesAmount')} value={salesAmount} onChange={setSalesAmount} error={errs.salesAmount} highlight money />
        </div>

        <div className="form-group" style={{ marginTop: 16 }}>
          <label>{t('reports.field.activity')}</label>
          <textarea
            className="crm-textarea"
            value={activity}
            onChange={(e) => setActivity(e.target.value)}
            maxLength={MAX_REPORT_TEXT}
            rows={3}
          />
        </div>
        <div className="form-group">
          <label>{t('reports.field.challenges')}</label>
          <textarea
            className="crm-textarea"
            value={challenges}
            onChange={(e) => setChallenges(e.target.value)}
            maxLength={MAX_REPORT_TEXT}
            rows={2}
          />
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={closeForm} data-testid="report-cancel">
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving} data-testid="report-save">
            <Icon name="save" size={16} /> {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </FormModal>

      {/* Сводка за период */}
      <div className="bento" style={{ marginBottom: 24 }}>
        <SmallStat eyebrow={t('eyebrow.sales30')} value={fmtTjs(totalSalesAmount)} label={t('reports.up.totalSales')} span="span-3" accent />
        <SmallStat eyebrow={t('eyebrow.deals30')} value={String(totalSalesCount)} label={t('reports.up.dealsClosed')} span="span-3" />
        <SmallStat eyebrow={t('eyebrow.calls')} value={String(totalCalls)} label={t('reports.up.calls')} span="span-2" />
        <SmallStat eyebrow={t('eyebrow.meetings')} value={String(totalMeetings)} label={t('reports.up.meetings')} span="span-2" />
        <SmallStat eyebrow={t('eyebrow.leadContacts')} value={String(totalContacted)} label={t('reports.up.apps')} span="span-2" />
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
              {canWrite && <th></th>}
            </tr>
          </thead>
          <tbody>
            {history.length === 0 && <tr><td colSpan={canWrite ? 8 : 7} className="empty">{t('reports.empty')}</td></tr>}
            {sort.sorted.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 500 }}>{fmtDate(r.date)}</td>
                {/* data-label — подпись у цифры в карточке на телефоне (index.css). */}
                <td data-label={t('reports.field.calls')} style={{ fontFamily: 'var(--font-mono)' }}>{r.callsCount}</td>
                <td data-label={t('reports.field.meetings')} style={{ fontFamily: 'var(--font-mono)' }}>{r.meetingsCount}</td>
                <td data-label={t('reports.field.applications')} style={{ fontFamily: 'var(--font-mono)' }}>{r.applicationsContacted}</td>
                <td data-label={t('reports.field.salesCount')} style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--primary-dark)' }}>{r.salesCount}</td>
                <td data-label={t('reports.field.salesAmount')} style={{ fontFamily: 'var(--font-display)', fontWeight: 500, color: 'var(--primary-dark)' }}>{fmtTjs(r.salesAmount)}</td>
                <td data-label={t('reports.field.activity')} className="td-stack" style={{ color: 'var(--text-soft)', fontSize: 13 }}>{r.activitySummary || '—'}</td>
                {canWrite && (
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => onDelete(r)}
                      disabled={deleteMut.isPending}
                      data-testid="report-delete"
                      title={t('reports.delete.title')}
                    >
                      <Icon name="delete" size={14} /> {t('common.delete')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NumberField({ name, label, value, onChange, highlight, money, error }: {
  name: string; label: string; value: string; onChange: (v: string) => void; highlight?: boolean;
  /** Сумма: можно копейки («1500,50»). Остальные поля — только целые. */
  money?: boolean; error?: string;
}) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label style={highlight ? { color: 'var(--primary-dark)' } : undefined}>{label}</label>
      <input
        // Текстовое поле с цифровой клавиатурой: type="number" молча отдаёт
        // пустую строку на «1.5.2» или «-», и проверить ввод было нечем.
        type="text"
        inputMode={money ? 'decimal' : 'numeric'}
        autoComplete="off"
        value={value}
        className={error ? 'input-error' : undefined}
        aria-invalid={!!error}
        data-testid={`report-${name}`}
        onFocus={(e) => {
          // Если в поле стоит "0" — сразу выделяем, чтобы первое нажатие
          // цифры затёрло нолик, а не дописало к нему ("03" → пользователь
          // не мог стереть ведущий 0). UX-фикс по скриншоту.
          if (value === '0' || value === '') e.currentTarget.select();
        }}
        onChange={(e) => {
          // Ввод НЕ переписываем (QA-3, BUG-05): «1.5» остаётся «1.5», «-5» —
          // «-5», а ошибка показывается под полем при сохранении. Убираем
          // только ведущие нули у целого: «03» → «3».
          let v = e.target.value.slice(0, 14);
          if (/^0\d+$/.test(v)) v = v.replace(/^0+/, '') || '0';
          onChange(v);
        }}
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          fontWeight: 500,
          borderColor: error ? undefined : highlight ? 'var(--primary)' : undefined,
        }}
      />
      {error && <div className="form-error-text" role="alert" data-testid={`report-${name}-error`}>{error}</div>}
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
