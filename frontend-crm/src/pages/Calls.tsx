import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listCalls,
  createCall,
  deleteCall,
  callsStats,
  fmtDuration,
  CALL_DIRECTION_LABEL,
  CALL_OUTCOME_LABEL,
  type CallLog,
  type CallStat,
  type CallDirection,
  type CallOutcome,
} from '../api/calls';
import { keys } from '../lib/queryKeys';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

const OUTCOME_COLOR: Record<CallOutcome, string> = {
  ANSWERED: 'var(--text-soft)',
  NO_ANSWER: '#c0392b',
  BUSY: '#e08600',
  CALLBACK: '#2d6cdf',
  CONVERTED: 'var(--primary-dark)',
};

export default function Calls() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const isAdmin = isElevated(me);

  const listKey = keys.calls.list({ mine: !isAdmin });
  const listQuery = useQuery<CallLog[]>({
    queryKey: listKey,
    queryFn: () => listCalls(isAdmin ? {} : { mine: true }),
  });
  const calls = listQuery.data ?? [];

  const statsKey = keys.calls.stats();
  const statsQuery = useQuery<CallStat[]>({
    queryKey: statsKey,
    queryFn: () => callsStats(),
    enabled: isAdmin,
  });
  const stats = statsQuery.data ?? [];

  const createMut = useMutation({
    mutationFn: createCall,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.calls.all });
      toast('Звонок записан', 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: deleteCall,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.calls.all });
      toast('Звонок удалён', 'info');
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  // --- Форма ---
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [direction, setDirection] = useState<CallDirection>('OUTGOING');
  const [outcome, setOutcome] = useState<CallOutcome>('ANSWERED');
  const [minutes, setMinutes] = useState('0');
  const [seconds, setSeconds] = useState('0');
  const [notes, setNotes] = useState('');

  const onLog = () => {
    if (!clientName.trim()) {
      toast('Укажи имя клиента', 'error');
      return;
    }
    const dur = (parseInt(minutes, 10) || 0) * 60 + (parseInt(seconds, 10) || 0);
    createMut.mutate(
      {
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim() || undefined,
        direction,
        outcome,
        durationSeconds: dur,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          setClientName('');
          setClientPhone('');
          setMinutes('0');
          setSeconds('0');
          setNotes('');
          setDirection('OUTGOING');
          setOutcome('ANSWERED');
        },
      },
    );
  };

  const onDelete = async (c: CallLog) => {
    const ok = await confirm({
      title: 'Удалить звонок?',
      message: `Звонок с «${c.clientName}» будет удалён без возможности восстановления.`,
      danger: true,
      confirmText: 'Удалить',
    });
    if (ok) deleteMut.mutate(c.id);
  };

  // --- Сводка по моим звонкам ---
  const mine = useMemo(() => {
    const total = calls.length;
    const seconds = calls.reduce((s, c) => s + c.durationSeconds, 0);
    const converted = calls.filter((c) => c.outcome === 'CONVERTED').length;
    const answered = calls.filter((c) => c.outcome === 'ANSWERED' || c.outcome === 'CONVERTED').length;
    return { total, seconds, converted, answered };
  }, [calls]);

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">CALL LOG · 12</span>
        <h2 className="crm-section-title">{t('calls.title')}</h2>
      </div>

      {/* Форма записи звонка */}
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
        }}>NEW · CALL</div>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginBottom: 24,
        }}>
          Записать <em style={{
            fontFamily: 'Times New Roman, Georgia, serif',
            fontWeight: 400,
            color: 'var(--primary-dark)',
          }}>звонок.</em>
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Клиент</label>
            <input
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Имя клиента"
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Телефон</label>
            <input
              value={clientPhone}
              onChange={(e) => setClientPhone(e.target.value)}
              placeholder="+992 ..."
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Направление</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as CallDirection)}>
              {(Object.keys(CALL_DIRECTION_LABEL) as CallDirection[]).map((d) => (
                <option key={d} value={d}>{CALL_DIRECTION_LABEL[d]}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Результат</label>
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as CallOutcome)}>
              {(Object.keys(CALL_OUTCOME_LABEL) as CallOutcome[]).map((o) => (
                <option key={o} value={o}>{CALL_OUTCOME_LABEL[o]}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Длительность (мин)</label>
            <input
              type="number"
              min={0}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Секунды</label>
            <input
              type="number"
              min={0}
              max={59}
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
            />
          </div>
        </div>

        <div className="form-group" style={{ marginTop: 16 }}>
          <label>Заметки</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="О чём договорились, что нужно сделать дальше"
            rows={2}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={onLog} disabled={createMut.isPending}>
            <Icon name="call" size={16} /> {createMut.isPending ? 'Сохраняем...' : 'Записать звонок'}
          </button>
        </div>
      </motion.div>

      {/* Моя сводка */}
      <div className="bento" style={{ marginBottom: 24 }}>
        <SmallStat eyebrow="CALLS" value={String(mine.total)} label="Всего звонков" span="span-3" accent />
        <SmallStat eyebrow="ON LINE" value={fmtDuration(mine.seconds)} label="На линии" span="span-3" />
        <SmallStat eyebrow="ANSWERED" value={String(mine.answered)} label="С ответом" span="span-3" />
        <SmallStat eyebrow="DEALS" value={String(mine.converted)} label="Конверсий" span="span-3" />
      </div>

      {/* Статистика по команде — ADMIN */}
      {isAdmin && stats.length > 0 && (
        <>
          <div className="crm-section-head" style={{ marginTop: 32 }}>
            <span className="crm-section-eyebrow">TEAM · PERFORMANCE</span>
            <h2 className="crm-section-title">
              Звонки <em>команды.</em>
            </h2>
          </div>
          <div className="card" style={{ padding: 0, marginBottom: 24 }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Звонков</th>
                  <th>На линии</th>
                  <th>Конверсий</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.user.id}>
                    <td style={{ fontWeight: 500 }}>{s.user.fullName}</td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{s.totalCalls}</td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{fmtDuration(s.totalSeconds)}</td>
                    <td style={{
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      color: 'var(--primary-dark)',
                    }}>{s.conversions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* История звонков */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">HISTORY</span>
        <h2 className="crm-section-title">
          Последние <em>звонки.</em>
        </h2>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Когда</th>
              <th>Клиент</th>
              {isAdmin && <th>Сотрудник</th>}
              <th>Тип</th>
              <th>Результат</th>
              <th>Длит.</th>
              <th>Заметки</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 && (
              <tr><td colSpan={isAdmin ? 8 : 7} className="empty">Пока нет звонков</td></tr>
            )}
            {calls.map((c) => (
              <tr key={c.id}>
                <td style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{fmtDateTime(c.occurredAt)}</td>
                <td>
                  <div style={{ fontWeight: 500 }}>{c.clientName}</div>
                  {c.clientPhone && (
                    <div style={{ color: 'var(--text-soft)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                      {c.clientPhone}
                    </div>
                  )}
                </td>
                {isAdmin && (
                  <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{c.user?.fullName || '—'}</td>
                )}
                <td style={{ fontSize: 13 }}>{CALL_DIRECTION_LABEL[c.direction]}</td>
                <td style={{ fontSize: 13, fontWeight: 600, color: OUTCOME_COLOR[c.outcome] }}>
                  {CALL_OUTCOME_LABEL[c.outcome]}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{fmtDuration(c.durationSeconds)}</td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>
                  {c.notes || '—'}
                  {c.recordingUrl && (
                    <div style={{ marginTop: 4 }}>
                      <audio src={c.recordingUrl} controls preload="none" style={{ height: 28, width: '100%', maxWidth: 220 }} />
                    </div>
                  )}
                </td>
                <td>
                  <button
                    className="icon-btn"
                    title="Удалить"
                    onClick={() => onDelete(c)}
                    disabled={deleteMut.isPending}
                  >
                    <Icon name="delete" size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SmallStat({ eyebrow, value, label, span = 'span-3', accent }: {
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
          fontSize: 'clamp(32px, 4vw, 48px)',
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
