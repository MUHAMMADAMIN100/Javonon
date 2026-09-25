import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TimeEntry,
  clockIn as apiClockIn,
  clockOut as apiClockOut,
  getHistory,
  getToday,
  lunchIn as apiLunchIn,
  lunchOut as apiLunchOut,
  uploadTimeProof,
  submitLateExcuse,
  submitLunchLateExcuse,
} from '../api/time';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { useOptimisticMutation } from '../lib/optimistic';
import { useRealtimeEvent } from '../realtime';
import { fmtDateText, tjFormatTime, TJ_TZ } from '../lib/tjTime';
import { tr, useT } from '../lib/i18n';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';

function fmtMin(min: number): string {
  if (min <= 0) return `0${tr('time.m')}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0) return `${h}${tr('time.h')} ${m}${tr('time.m')}`;
  return `${m}${tr('time.m')}`;
}

function fmtTime(iso: string | null): string {
  // Время clockIn/lunchOut/clockOut — серверный UTC. Форматируем в
  // Asia/Dushanbe — пользователь видит время прихода в бизнес-зоне,
  // независимо от того в каком TZ открыл CRM.
  if (!iso) return '—';
  return tjFormatTime(iso);
}

/** Минуты от полуночи по Душанбе: «Приход»/«Уход» сортируем по часам, а не по дате. */
function minutesOfDay(iso: string | null): number | null {
  if (!iso) return null;
  const [h, m] = tjFormatTime(iso).split(':').map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
}

function fmtDate(iso: string): string {
  return fmtDateText(iso, {
    timeZone: TJ_TZ,
    day: '2-digit',
    month: 'short',
    weekday: 'short',
  });
}

export default function TimeTracker() {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();

  // Live timer for "сейчас работаю" badge
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000); // every 30s
    return () => clearInterval(t);
  }, []);

  const [showClockInModal, setShowClockInModal] = useState(false);
  const [showExcuseModal, setShowExcuseModal] = useState(false);
  const [showLunchExcuseModal, setShowLunchExcuseModal] = useState(false);

  const todayKey = keys.time.today();
  const historyKey = keys.time.history({ take: 30 });

  const todayQuery = useQuery<TimeEntry | null>({
    queryKey: todayKey,
    queryFn: () => getToday(),
  });
  const today = todayQuery.data ?? null;

  // Если сотрудник опоздал с обеда и НЕ прислал причину — заставляем
  // открыть модалку при загрузке страницы (даже если он перезагрузил
  // вкладку, чтобы пропустить). Объяснение обязательно.
  useEffect(() => {
    if (
      today &&
      (today.lateLunchMinutes ?? 0) >= 10 &&
      !today.lunchLateExcuseAt &&
      !today.lateLunchPenaltyApplied
    ) {
      setShowLunchExcuseModal(true);
    }
  }, [today?.id, today?.lateLunchMinutes, today?.lunchLateExcuseAt, today?.lateLunchPenaltyApplied]);

  const historyQuery = useQuery<TimeEntry[]>({
    queryKey: historyKey,
    queryFn: () => getHistory({ take: 30 }),
  });

  // По ТЗ §5 — когда FOUNDER одобрит/отклонит причину, плашка
  // на странице /time меняется мгновенно (без релоада).
  useRealtimeEvent('excuse:approved', () => {
    qc.invalidateQueries({ queryKey: todayKey });
    qc.invalidateQueries({ queryKey: historyKey });
    toast(t('excuses.status.APPROVED'), 'success');
  });
  useRealtimeEvent('excuse:rejected', () => {
    qc.invalidateQueries({ queryKey: todayKey });
    qc.invalidateQueries({ queryKey: historyKey });
    toast(t('excuses.status.REJECTED'), 'error');
  });
  const history = historyQuery.data ?? [];
  const sort = useTableSort(history, [
    { key: 'date', label: t('workday.col.date'), type: 'date', value: (h) => h.clockIn },
    { key: 'arrival', label: t('workday.col.arrival'), type: 'number', value: (h) => minutesOfDay(h.clockIn) },
    { key: 'lunch', label: t('workday.col.lunch'), type: 'number', value: (h) => h.totalLunchMinutes },
    { key: 'leave', label: t('workday.col.leave'), type: 'number', value: (h) => minutesOfDay(h.clockOut) },
    { key: 'late', label: t('workday.col.late'), type: 'number', value: (h) => h.lateMinutes },
    {
      key: 'worked',
      label: t('workday.col.worked'),
      type: 'number',
      // Незакрытый день в ячейке — «…», считать нечего.
      value: (h) => (h.status === 'OFF' ? h.totalMinutes : null),
    },
  ]);

  const status = today?.status || 'OFF';
  const isWorking = status === 'WORKING';
  const isOnLunch = status === 'ON_LUNCH';
  const isClockedOut = !today || status === 'OFF';

  // Все 4 экшена — оптимистично переключают status в today.
  // Если сервер вернёт 400 (например double clock-in) — TanStack откатит.
  const buildMut = (fn: () => Promise<TimeEntry>, optimisticPatch: Partial<TimeEntry>, successMsg: string) =>
    useOptimisticMutation<TimeEntry, void, TimeEntry | null>({
      mutationFn: fn,
      queryKey: todayKey,
      applyOptimistic: (cur) => {
        if (!cur) {
          return {
            id: 'tmp',
            userId: '',
            status: 'WORKING',
            clockIn: new Date().toISOString(),
            lunchOut: null,
            lunchIn: null,
            clockOut: null,
            totalMinutes: 0,
            totalLunchMinutes: 0,
            lateMinutes: 0,
            ...optimisticPatch,
          } as TimeEntry;
        }
        return { ...cur, ...optimisticPatch } as TimeEntry;
      },
      invalidateAlso: [historyKey, keys.time.team()],
      onSuccess: () => toast(successMsg, 'success'),
      onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
    });

  // clockIn — отдельный с TVars=ClockInArgs (lat/lon/proofUrl)
  const clockInMut = useOptimisticMutation<TimeEntry, { lat?: number; lon?: number; proofUrl?: string }, TimeEntry | null>({
    mutationFn: (vars) => apiClockIn(vars),
    queryKey: todayKey,
    applyOptimistic: (cur) => {
      const patch: Partial<TimeEntry> = { status: 'WORKING', clockIn: new Date().toISOString() };
      if (!cur) {
        return {
          id: 'tmp',
          userId: '',
          ...patch,
          lunchOut: null,
          lunchIn: null,
          clockOut: null,
          totalMinutes: 0,
          totalLunchMinutes: 0,
          lateMinutes: 0,
        } as TimeEntry;
      }
      return { ...cur, ...patch } as TimeEntry;
    },
    invalidateAlso: [historyKey, keys.time.team()],
    onSuccess: () => toast(t('time.toast.started'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const lunchOutMut = buildMut(apiLunchOut, { status: 'ON_LUNCH', lunchOut: new Date().toISOString() }, t('time.toast.lunchOut'));
  // lunchInMut — отдельный, чтобы поймать requiresLunchExcuse в ответе
  // и открыть модалку объяснения если опоздание с обеда >= 10 мин.
  const lunchInMut = useOptimisticMutation<any, void, TimeEntry | null>({
    mutationFn: apiLunchIn,
    queryKey: todayKey,
    applyOptimistic: (cur) => {
      if (!cur) return cur;
      return { ...cur, status: 'WORKING', lunchIn: new Date().toISOString() } as TimeEntry;
    },
    invalidateAlso: [historyKey, keys.time.team()],
    onSuccess: (data: any) => {
      toast(t('time.toast.lunchIn'), 'success');
      if (data?.requiresLunchExcuse && data?.id) {
        setShowLunchExcuseModal(true);
      }
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const clockOutMut = buildMut(apiClockOut, { status: 'OFF', clockOut: new Date().toISOString() }, t('time.toast.finished'));

  const loading = clockInMut.isPending || lunchOutMut.isPending || lunchInMut.isPending || clockOutMut.isPending;
  void qc; // reserved for future cross-key invalidations

  // Live elapsed time
  let elapsedMin = 0;
  if (today && (isWorking || isOnLunch)) {
    const start = new Date(today.clockIn).getTime();
    const now = Date.now();
    const totalSinceStart = Math.floor((now - start) / 60000);
    elapsedMin = totalSinceStart - today.totalLunchMinutes;
    if (isOnLunch && today.lunchOut) {
      elapsedMin -= Math.floor((now - new Date(today.lunchOut).getTime()) / 60000);
    }
  }

  const statusLabel = isClockedOut ? t('workday.notWorking') : isWorking ? t('time.status.working') : t('time.status.lunch');
  const statusColor = isClockedOut
    ? 'var(--text-light)'
    : isWorking
      ? 'var(--primary-dark)'
      : '#b45309';

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.hr04')}</span>
        <h2 className="crm-section-title">{t('time.title')}</h2>
      </div>

      {/* Главная панель — статус + кнопки */}
      <motion.div
        className="card"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 32, marginBottom: 24, position: 'relative', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 24, marginBottom: 28 }}>
          <div>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.16em',
              color: statusColor,
              marginBottom: 8,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: statusColor,
                boxShadow: !isClockedOut ? `0 0 0 4px ${statusColor}22` : 'none',
              }} />
              {statusLabel}
            </div>
            <div style={{
              fontFamily: 'var(--font-display)',
              fontSize: 64,
              fontWeight: 500,
              letterSpacing: '-0.04em',
              lineHeight: 1,
            }}>
              {isClockedOut ? '00:00' : fmtMin(elapsedMin)}
            </div>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.10em',
              color: 'var(--text-soft)',
              textTransform: 'uppercase',
              marginTop: 8,
            }}>
              {today
                ? `${t('workday.field.arrival')}: ${fmtTime(today.clockIn)} · ${t('workday.col.lunch')}: ${fmtMin(today.totalLunchMinutes)}${today.lateMinutes > 0 ? ` · ${t('workday.col.late')}: ${today.lateMinutes}${t('common.minutes')}` : ''}`
                : t('workday.notStarted')}
            </div>
          </div>

          {/* Сегодняшний таймстемпы. min-width: 0 — с 280 на 320 px сетка
              вылезала за карточку и за край экрана. */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 20,
            minWidth: 0,
            flex: '1 1 200px',
          }}>
            <TimeStamp label={t('workday.field.arrival')} value={fmtTime(today?.clockIn || null)} />
            <TimeStamp label={t('workday.field.lunchOut')} value={fmtTime(today?.lunchOut || null)} />
            <TimeStamp label={t('workday.field.lunchIn')} value={fmtTime(today?.lunchIn || null)} />
            <TimeStamp label={t('workday.field.leave')} value={fmtTime(today?.clockOut || null)} />
          </div>
        </div>

        {/* Алерт об опоздании — если есть опоздание без оправдания и штраф ещё не начислен */}
        {today && today.lateMinutes > 15 && !today.lateExcuseAt && !today.latePenaltyApplied && (
          <div style={{
            marginTop: 20,
            padding: '14px 18px',
            background: '#fef3c7',
            border: '1px solid #fbbf24',
            borderRadius: 12,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontWeight: 600, color: '#b45309' }}>
                ⚠️ {t('time.late')} {today.lateMinutes} {t('common.minutes')}
              </div>
              <div style={{ fontSize: 13, color: '#92400e', marginTop: 4 }}>
                {t('time.lateWarning')}
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => setShowExcuseModal(true)}>
              {t('time.explain')}
            </button>
          </div>
        )}
        {today && today.lateMinutes > 15 && today.lateExcuseAt && today.status !== 'OFF' && (() => {
          // По ТЗ §5: статус определяет цвет/текст плашки.
          //   PENDING/null  → жёлтая, «на рассмотрении у основателя»
          //   APPROVED      → зелёная, «одобрено, штраф не списан»
          //   REJECTED      → красная, «отклонено, штраф будет списан»
          const status = (today as any).lateExcuseStatus as 'PENDING' | 'APPROVED' | 'REJECTED' | null;
          const isApproved = status === 'APPROVED';
          const isRejected = status === 'REJECTED';
          const style = isApproved
            ? { bg: '#dcfce7', border: '#86efac', color: '#15803d', text: `✓ ${t('time.excuse.approved')}` }
            : isRejected
            ? { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b', text: `✕ ${t('time.excuse.rejected')}` }
            : { bg: '#fef3c7', border: '#fcd34d', color: '#92400e', text: `⏳ ${t('time.excuse.pending')}` };
          return (
            <div style={{
              marginTop: 20,
              padding: '12px 16px',
              background: style.bg,
              border: `1px solid ${style.border}`,
              borderRadius: 12,
              fontSize: 13,
              color: style.color,
            }}>
              {style.text}
            </div>
          );
        })()}

        {/* Кнопки действий */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isClockedOut && (
            <motion.button
              className="btn btn-primary"
              onClick={() => setShowClockInModal(true)}
              disabled={loading}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              style={{ fontSize: 15, padding: '14px 28px' }}
            >
              <Icon name="play_arrow" size={20} />
              {t('time.clockIn')}
            </motion.button>
          )}
          {isWorking && (
            <>
              <motion.button
                className="btn btn-secondary"
                onClick={() => lunchOutMut.mutate()}
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Icon name="restaurant" size={18} />
                {t('time.lunchOut')}
              </motion.button>
              <motion.button
                className="btn btn-primary"
                onClick={() => clockOutMut.mutate()}
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Icon name="stop" size={18} />
                {t('time.clockOut')}
              </motion.button>
            </>
          )}
          {isOnLunch && (
            <>
              <motion.button
                className="btn btn-primary"
                onClick={() => lunchInMut.mutate()}
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                style={{ fontSize: 15, padding: '14px 28px' }}
              >
                <Icon name="login" size={18} />
                {t('time.lunchIn')}
              </motion.button>
              <motion.button
                className="btn btn-secondary"
                onClick={() => clockOutMut.mutate()}
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                {t('time.clockOut')}
              </motion.button>
            </>
          )}
        </div>
      </motion.div>

      {/* История */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">{t('eyebrow.historyLast30')}</span>
        <h2 className="crm-section-title">
          {t('workday.journal')}
        </h2>
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
            <AnimatePresence>
              {history.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">{t('common.empty')}</td>
                </tr>
              )}
              {sort.sorted.map((h) => (
                <motion.tr
                  key={h.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <td style={{ fontWeight: 500 }}>{fmtDate(h.clockIn)}</td>
                  <td data-label={t('workday.col.arrival')} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtTime(h.clockIn)}</td>
                  <td data-label={t('workday.col.lunch')} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(h.totalLunchMinutes)}</td>
                  <td data-label={t('workday.col.leave')} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtTime(h.clockOut)}</td>
                  <td data-label={t('workday.col.late')}>
                    {h.lateMinutes > 0 ? (
                      <span className="badge badge-warning">{h.lateMinutes}{t('common.minutes')}</span>
                    ) : (
                      <span style={{ color: 'var(--text-light)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>—</span>
                    )}
                  </td>
                  <td data-label={t('workday.col.worked')} style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 500,
                    fontSize: 16,
                    letterSpacing: '-0.01em',
                  }}>
                    {h.status === 'OFF' ? fmtMin(h.totalMinutes) : <span style={{ color: 'var(--primary-dark)' }}>…</span>}
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {showClockInModal && (
          <ClockInModal
            onCancel={() => setShowClockInModal(false)}
            onConfirm={(vars) => {
              setShowClockInModal(false);
              clockInMut.mutate(vars);
            }}
          />
        )}
        {showExcuseModal && today && (
          <ExcuseModal
            entry={today}
            onCancel={() => setShowExcuseModal(false)}
            onDone={() => {
              setShowExcuseModal(false);
              qc.invalidateQueries({ queryKey: todayKey });
              toast(t('toast.sent'), 'success');
            }}
            onError={(e) => toast(e, 'error')}
          />
        )}
        {showLunchExcuseModal && today && (
          <LunchExcuseModal
            entry={today}
            onCancel={() => setShowLunchExcuseModal(false)}
            onDone={() => {
              setShowLunchExcuseModal(false);
              qc.invalidateQueries({ queryKey: todayKey });
              toast(t('toast.sent'), 'success');
            }}
            onError={(e) => toast(e, 'error')}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function ClockInModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (vars: { lat?: number; lon?: number; proofUrl?: string }) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [geoLoading, setGeoLoading] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const detectLocation = () => {
    if (!navigator.geolocation) {
      toast(t('time.geo.unavailable'), 'error');
      return;
    }
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGeoLoading(false);
      },
      (err) => {
        setGeoLoading(false);
        toast(`${t('time.geo.label')}: ${err.message}`, 'error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const submit = async () => {
    if (!coords && !proofFile) {
      toast(t('time.proof.required'), 'error');
      return;
    }
    let proofUrl: string | undefined;
    if (proofFile) {
      setUploading(true);
      try {
        const r = await uploadTimeProof(proofFile);
        proofUrl = r.url;
      } catch (e: any) {
        toast(e?.response?.data?.message || t('dealForm.uploadError'), 'error');
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    onConfirm({ lat: coords?.lat, lon: coords?.lon, proofUrl });
  };

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
    >
      <motion.div
        className="dialog-card"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 480 }}
      >
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginBottom: 8 }}>
          {t('time.proof.title')}
        </h3>
        <p style={{ color: 'var(--text-soft)', fontSize: 14, marginBottom: 20 }}>
          {t('time.proof.text')}
        </p>

        <div style={{ marginBottom: 16 }}>
          <button
            className={coords ? 'btn btn-secondary' : 'btn btn-primary'}
            onClick={detectLocation}
            disabled={geoLoading}
            style={{ width: '100%' }}
          >
            <Icon name={coords ? 'check_circle' : 'location_on'} size={18} />
            {geoLoading ? t('time.geo.detecting') : coords ? `📍 ${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}` : t('time.geo.use')}
          </button>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>{t('time.proof.orMedia')}</div>
          <input
            type="file"
            accept="image/*,video/*"
            capture="environment"
            onChange={(e) => setProofFile(e.target.files?.[0] || null)}
            style={{ width: '100%' }}
          />
          {proofFile && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-soft)' }}>
              ✓ {proofFile.name} ({(proofFile.size / 1024).toFixed(0)} {t('finance.kb')})
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={uploading}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={uploading || (!coords && !proofFile)}>
            {uploading ? t('common.uploading') : t('time.startWork')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ExcuseModal({
  entry,
  onCancel,
  onDone,
  onError,
}: {
  entry: TimeEntry;
  onCancel: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reason.trim() && !file) {
      onError(t('time.excuse.required'));
      return;
    }
    setSubmitting(true);
    try {
      let excuseUrl: string | undefined;
      if (file) {
        const r = await uploadTimeProof(file);
        excuseUrl = r.url;
      }
      await submitLateExcuse(entry.id, {
        excuseUrl,
        excuseReason: reason.trim() || undefined,
      });
      onDone();
    } catch (e: any) {
      onError(e?.response?.data?.message || t('toast.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
    >
      <motion.div
        className="dialog-card"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 480 }}
      >
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginBottom: 8 }}>
          {t('time.excuse.title')}
        </h3>
        <p style={{ color: 'var(--text-soft)', fontSize: 14, marginBottom: 20 }}>
          {t('time.excuse.text').replace('{n}', String(entry.lateMinutes))}
        </p>

        <textarea
          className="crm-textarea"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('time.excuse.placeholder')}
          rows={3}
          style={{ width: '100%', marginBottom: 12 }}
        />
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>{t('time.excuse.media')}</div>
          <input
            type="file"
            accept="image/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ width: '100%' }}
          />
          {file && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-soft)' }}>
              ✓ {file.name}
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? t('common.sending') : t('common.send')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Объяснение опоздания с обеда. Аналогична ExcuseModal,
 *  но шлёт на /time/:id/lunch-excuse. */
function LunchExcuseModal({
  entry,
  onCancel,
  onDone,
  onError,
}: {
  entry: TimeEntry;
  onCancel: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reason.trim() && !file) {
      onError(t('time.excuse.required'));
      return;
    }
    setSubmitting(true);
    try {
      let excuseUrl: string | undefined;
      if (file) {
        const r = await uploadTimeProof(file);
        excuseUrl = r.url;
      }
      await submitLunchLateExcuse(entry.id, {
        excuseUrl,
        excuseReason: reason.trim() || undefined,
      });
      onDone();
    } catch (e: any) {
      onError(e?.response?.data?.message || t('toast.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // Объяснение обязательно — клик по backdrop НЕ закрывает модалку.
    >
      <motion.div
        className="dialog-card"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 480 }}
      >
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginBottom: 8 }}>
          {t('time.lunchExcuse.title')}
        </h3>
        <p style={{ color: 'var(--text-soft)', fontSize: 14, marginBottom: 20 }}>
          {t('time.lunchExcuse.text').replace('{n}', String(entry.lateLunchMinutes ?? 0))}
        </p>

        <textarea
          className="crm-textarea"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('time.excuse.placeholder')}
          rows={3}
          style={{ width: '100%', marginBottom: 12 }}
        />
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>{t('time.excuse.media')}</div>
          <input
            type="file"
            accept="image/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ width: '100%' }}
          />
          {file && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-soft)' }}>
              ✓ {file.name}
            </div>
          )}
        </div>

        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? t('common.sending') : t('common.send')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function TimeStamp({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--text-light)',
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: '-0.01em',
        color: value === '—' ? 'var(--text-light)' : 'var(--text)',
      }}>
        {value}
      </div>
    </div>
  );
}
