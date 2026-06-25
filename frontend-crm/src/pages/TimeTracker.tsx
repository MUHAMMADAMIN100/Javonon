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
} from '../api/time';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { useOptimisticMutation } from '../lib/optimistic';
import { useRealtimeEvent } from '../realtime';
import { tjFormatTime, TJ_TZ } from '../lib/tjTime';
import { useT } from '../lib/i18n';

function fmtMin(min: number): string {
  if (min <= 0) return '0м';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function fmtTime(iso: string | null): string {
  // Время clockIn/lunchOut/clockOut — серверный UTC. Форматируем в
  // Asia/Dushanbe — пользователь видит время прихода в бизнес-зоне,
  // независимо от того в каком TZ открыл CRM.
  if (!iso) return '—';
  return tjFormatTime(iso);
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TJ_TZ,
    day: '2-digit',
    month: 'short',
    weekday: 'short',
  }).format(new Date(iso));
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

  const todayKey = keys.time.today();
  const historyKey = keys.time.history({ take: 30 });

  const todayQuery = useQuery<TimeEntry | null>({
    queryKey: todayKey,
    queryFn: () => getToday(),
  });
  const today = todayQuery.data ?? null;

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
      onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
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
    onSuccess: () => toast('Рабочий день начат', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });
  const lunchOutMut = buildMut(apiLunchOut, { status: 'ON_LUNCH', lunchOut: new Date().toISOString() }, 'Ушли на обед');
  const lunchInMut = buildMut(apiLunchIn, { status: 'WORKING', lunchIn: new Date().toISOString() }, 'Вернулись с обеда');
  const clockOutMut = buildMut(apiClockOut, { status: 'OFF', clockOut: new Date().toISOString() }, 'Рабочий день завершён');

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

          {/* Сегодняшний таймстемпы */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 20,
            minWidth: 280,
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
                ⚠️ Опоздание {today.lateMinutes} минут
              </div>
              <div style={{ fontSize: 13, color: '#92400e', marginTop: 4 }}>
                Объясни причину — иначе сегодня вечером будет начислен штраф (прогрессивный, +50 TJS за каждое следующее опоздание).
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => setShowExcuseModal(true)}>
              Объяснить причину
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
            ? { bg: '#dcfce7', border: '#86efac', color: '#15803d', text: '✓ Причина одобрена — штраф не будет начислен' }
            : isRejected
            ? { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b', text: '✕ Причина отклонена — штраф будет начислен' }
            : { bg: '#fef3c7', border: '#fcd34d', color: '#92400e', text: '⏳ Ваша причина на рассмотрении у основателя' };
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

      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>{t('workday.col.date')}</th>
              <th>{t('workday.col.arrival')}</th>
              <th>{t('workday.col.lunch')}</th>
              <th>{t('workday.col.leave')}</th>
              <th>{t('workday.col.late')}</th>
              <th>{t('workday.col.worked')}</th>
              <th>{t('workday.col.overtime')}</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence>
              {history.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">{t('common.empty')}</td>
                </tr>
              )}
              {history.map((h) => (
                <motion.tr
                  key={h.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <td style={{ fontWeight: 500 }}>{fmtDate(h.clockIn)}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtTime(h.clockIn)}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtMin(h.totalLunchMinutes)}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{fmtTime(h.clockOut)}</td>
                  <td>
                    {h.lateMinutes > 0 ? (
                      <span className="badge badge-warning">{h.lateMinutes}{t('common.minutes')}</span>
                    ) : (
                      <span style={{ color: 'var(--text-light)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>—</span>
                    )}
                  </td>
                  <td style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 500,
                    fontSize: 16,
                    letterSpacing: '-0.01em',
                  }}>
                    {h.status === 'OFF' ? fmtMin(h.totalMinutes) : <span style={{ color: 'var(--primary-dark)' }}>…</span>}
                  </td>
                  <td>
                    {h.overtimeMinutes > 0 ? (
                      <span className="badge badge-success">+{fmtMin(h.overtimeMinutes)}</span>
                    ) : (
                      <span style={{ color: 'var(--text-light)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>—</span>
                    )}
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
  const { toast } = useUI();
  const [geoLoading, setGeoLoading] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const detectLocation = () => {
    if (!navigator.geolocation) {
      toast('Геолокация недоступна в этом браузере', 'error');
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
        toast(`Геолокация: ${err.message}`, 'error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const submit = async () => {
    if (!coords && !proofFile) {
      toast('Нужно подтверждение: геолокация или фото/видео', 'error');
      return;
    }
    let proofUrl: string | undefined;
    if (proofFile) {
      setUploading(true);
      try {
        const r = await uploadTimeProof(proofFile);
        proofUrl = r.url;
      } catch (e: any) {
        toast(e?.response?.data?.message || 'Ошибка загрузки', 'error');
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    onConfirm({ lat: coords?.lat, lon: coords?.lon, proofUrl });
  };

  return (
    <motion.div
      className="dialog-overlay"
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
          Подтверди присутствие
        </h3>
        <p style={{ color: 'var(--text-soft)', fontSize: 14, marginBottom: 20 }}>
          Чтобы начать рабочий день нужно либо разрешить геолокацию, либо приложить фото/видео рабочего места.
        </p>

        <div style={{ marginBottom: 16 }}>
          <button
            className={coords ? 'btn btn-secondary' : 'btn btn-primary'}
            onClick={detectLocation}
            disabled={geoLoading}
            style={{ width: '100%' }}
          >
            <Icon name={coords ? 'check_circle' : 'location_on'} size={18} />
            {geoLoading ? 'Определяем...' : coords ? `📍 ${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}` : 'Использовать геолокацию'}
          </button>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>ИЛИ ФОТО/ВИДЕО РАБОЧЕГО МЕСТА</div>
          <input
            type="file"
            accept="image/*,video/*"
            capture="environment"
            onChange={(e) => setProofFile(e.target.files?.[0] || null)}
            style={{ width: '100%' }}
          />
          {proofFile && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-soft)' }}>
              ✓ {proofFile.name} ({(proofFile.size / 1024).toFixed(0)} КБ)
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={uploading}>Отмена</button>
          <button className="btn btn-primary" onClick={submit} disabled={uploading || (!coords && !proofFile)}>
            {uploading ? 'Загружаем...' : 'Начать работу'}
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
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reason.trim() && !file) {
      onError('Укажи причину или приложи фото/видео');
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
      onError(e?.response?.data?.message || 'Ошибка');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      className="dialog-overlay"
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
          Объяснение опоздания
        </h3>
        <p style={{ color: 'var(--text-soft)', fontSize: 14, marginBottom: 20 }}>
          Опоздал на {entry.lateMinutes} мин. Если объяснишь причину — штраф не начислится.
        </p>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Причина (минимум 5 символов)"
          rows={3}
          style={{ width: '100%', padding: 12, border: '1px solid var(--border)', borderRadius: 8, marginBottom: 12, fontSize: 14, resize: 'vertical' }}
        />
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>ФОТО / ВИДЕО (опционально)</div>
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
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>Отмена</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Отправляем...' : 'Отправить'}
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
