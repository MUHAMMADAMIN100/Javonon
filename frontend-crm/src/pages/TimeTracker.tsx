import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  TimeEntry,
  clockIn as apiClockIn,
  clockOut as apiClockOut,
  getHistory,
  getToday,
  lunchIn as apiLunchIn,
  lunchOut as apiLunchOut,
} from '../api/time';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';

function fmtMin(min: number): string {
  if (min <= 0) return '0м';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
    weekday: 'short',
  });
}

export default function TimeTracker() {
  const { toast } = useUI();
  const [today, setToday] = useState<TimeEntry | null>(null);
  const [history, setHistory] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Live timer for "сейчас работаю" badge
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000); // every 30s
    return () => clearInterval(t);
  }, []);

  const refresh = async () => {
    try {
      const [t, h] = await Promise.all([getToday(), getHistory({ take: 30 })]);
      setToday(t);
      setHistory(h);
    } catch {}
  };

  useEffect(() => { refresh(); }, []);

  const status = today?.status || 'OFF';
  const isWorking = status === 'WORKING';
  const isOnLunch = status === 'ON_LUNCH';
  const isClockedOut = !today || status === 'OFF';

  const action = async (fn: () => Promise<TimeEntry>, msg: string) => {
    setLoading(true);
    try {
      await fn();
      toast(msg, 'success');
      await refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setLoading(false);
    }
  };

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

  const statusLabel = isClockedOut ? 'НЕ В РАБОТЕ' : isWorking ? 'РАБОТАЮ' : 'НА ОБЕДЕ';
  const statusColor = isClockedOut
    ? 'var(--text-light)'
    : isWorking
      ? 'var(--primary-dark)'
      : '#b45309';

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">HR · 04</span>
        <h2 className="crm-section-title">
          Учёт <em>рабочего времени.</em>
        </h2>
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
                ? `Начал: ${fmtTime(today.clockIn)} · Перерыв: ${fmtMin(today.totalLunchMinutes)}${today.lateMinutes > 0 ? ` · Опоздание: ${today.lateMinutes}м` : ''}`
                : 'Сегодня ещё не начинал работу'}
            </div>
          </div>

          {/* Сегодняшний таймстемпы */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 20,
            minWidth: 280,
          }}>
            <TimeStamp label="Приход" value={fmtTime(today?.clockIn || null)} />
            <TimeStamp label="Уход на обед" value={fmtTime(today?.lunchOut || null)} />
            <TimeStamp label="Возврат" value={fmtTime(today?.lunchIn || null)} />
            <TimeStamp label="Уход" value={fmtTime(today?.clockOut || null)} />
          </div>
        </div>

        {/* Кнопки действий */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isClockedOut && (
            <motion.button
              className="btn btn-primary"
              onClick={() => action(apiClockIn, 'Рабочий день начат')}
              disabled={loading}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              style={{ fontSize: 15, padding: '14px 28px' }}
            >
              <Icon name="play_arrow" size={20} />
              Начать работу
            </motion.button>
          )}
          {isWorking && (
            <>
              <motion.button
                className="btn btn-secondary"
                onClick={() => action(apiLunchOut, 'Ушли на обед')}
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Icon name="restaurant" size={18} />
                Уйти на обед
              </motion.button>
              <motion.button
                className="btn btn-primary"
                onClick={() => action(apiClockOut, 'Рабочий день завершён')}
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Icon name="stop" size={18} />
                Закончить день
              </motion.button>
            </>
          )}
          {isOnLunch && (
            <>
              <motion.button
                className="btn btn-primary"
                onClick={() => action(apiLunchIn, 'Вернулись с обеда')}
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                style={{ fontSize: 15, padding: '14px 28px' }}
              >
                <Icon name="login" size={18} />
                Вернуться с обеда
              </motion.button>
              <motion.button
                className="btn btn-secondary"
                onClick={() => action(apiClockOut, 'Рабочий день завершён')}
                disabled={loading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                Закончить день
              </motion.button>
            </>
          )}
        </div>
      </motion.div>

      {/* История */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">HISTORY · LAST 30 DAYS</span>
        <h2 className="crm-section-title">
          Журнал <em>рабочих дней.</em>
        </h2>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Приход</th>
              <th>Обед</th>
              <th>Уход</th>
              <th>Опоздание</th>
              <th>Отработано</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence>
              {history.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">Нет записей</td>
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
                      <span className="badge badge-warning">{h.lateMinutes}м</span>
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
                    {h.status === 'OFF' ? fmtMin(h.totalMinutes) : <span style={{ color: 'var(--primary-dark)' }}>в процессе…</span>}
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>
    </>
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
