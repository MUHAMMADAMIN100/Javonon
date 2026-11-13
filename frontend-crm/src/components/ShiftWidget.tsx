import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import CrmDatePicker from './CrmDatePicker';
import BusyLabel from './BusyLabel';
import { useAuth } from '../store/auth';
import { isFounder, isTeacherOnly } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { useRealtimeEvent } from '../realtime';
import { useEscClose } from '../lib/useEscClose';
import { tjFormatTime } from '../lib/tjTime';
import { clockIn as apiClockIn, clockOut as apiClockOut } from '../api/time';
import { ClockInModal } from '../pages/TimeTracker';
import {
  SHIFT_KEY,
  createNotice,
  fetchMyShift,
  pauseShift,
  requestEdit,
  resumeShift,
  type MyShift,
  type PauseKind,
} from '../api/shift';

/**
 * Рабочая смена в боковом меню (13.11.2026, как в Sabt): «Начать работу»
 * всегда под рукой, на любой странице. Идёт смена — кнопка показывает время,
 * нажатие открывает карточку «Моя смена»: перерыв с причиной, завершение,
 * отрезки дня, неделя, «Приду позже», «Поправить время».
 *
 * Правила Javonon прежние: приход — с геолокацией или фото/видео (то же окно,
 * что в «Рабочем дне»), обед — со штрафом за позднее возвращение.
 * Основателю и учителю академии кнопки нет: они смену не отмечают.
 */

/** «3 ч 12 м» из минут. */
export function fmtMin(min: number): string {
  const v = Math.max(0, Math.round(min || 0));
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (!h) return `${m} м`;
  return m ? `${h} ч ${m} м` : `${h} ч`;
}

/** «2:05» — для узкой кнопки в полосе меню. */
const clock = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min) % 60).padStart(2, '0')}`;

export function canHaveShift(user: unknown): boolean {
  return !!user && !isFounder(user as any) && !isTeacherOnly(user as any);
}

/** Своя смена: запрос раз в минуту, счётчик тикает сам, события — сразу. */
export function useMyShift() {
  const me = useAuth((s) => s.user);
  const enabled = canHaveShift(me);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: SHIFT_KEY, queryFn: fetchMyShift, enabled, refetchInterval: 60_000, staleTime: 20_000 });
  useRealtimeEvent('attendance:updated', (p: any) => {
    if (enabled && p?.userId === me?.id) qc.invalidateQueries({ queryKey: SHIFT_KEY });
  });
  useRealtimeEvent('shift:decided', () => {
    if (enabled) qc.invalidateQueries({ queryKey: SHIFT_KEY });
  });
  const [, setTick] = useState(0);
  const running = q.data?.state === 'working' || (q.data?.state === 'break' && q.data.pauseKind === 'WORK');
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [running]);
  const data = q.data;
  const worked = data ? data.workedMinutes + (running && data.fetchedAt ? Math.max(0, (Date.now() - data.fetchedAt) / 60000) : 0) : 0;
  return { enabled, data, worked: Math.floor(worked), refetch: () => qc.invalidateQueries({ queryKey: SHIFT_KEY }) };
}

/** Кнопка смены: rail — полоса значков, panel — низ выезжающей панели, sheet — лист «Ещё» на телефоне. */
export default function ShiftButton({ variant }: { variant: 'rail' | 'panel' | 'sheet' }) {
  const { t } = useT();
  const s = useMyShift();
  const [cardOpen, setCardOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  if (!s.enabled) return null;
  const st = s.data?.state ?? 'idle';
  const working = st === 'working';
  const paused = st === 'lunch' || st === 'break';
  const finished = st === 'idle' && !!s.data?.startedAt;
  const onClick = () => (st === 'idle' && !finished ? setStartOpen(true) : setCardOpen(true));
  const label = working
    ? `${fmtMin(s.worked)} · ${t('sh.onShift')}`
    : paused
      ? t('sh.onBreak')
      : finished
        ? t('sh.dayDone')
        : t('sh.start');
  const title = working
    ? t('sh.openCard')
    : paused
      ? t('sh.onBreakSince').replace('{t}', s.data?.since ? tjFormatTime(s.data.since) : '—')
      : t('sh.start');
  const tone = working ? 'is-working' : paused ? 'is-paused' : finished ? 'is-done' : 'is-idle';
  return (
    <>
      <button
        type="button"
        className={`shift-btn shift-btn-${variant} ${tone}`}
        onClick={onClick}
        title={title}
        aria-label={title}
        data-testid={`shift-btn-${variant}`}
        data-state={st}
      >
        {working ? (
          <span className="shift-dot" aria-hidden="true" />
        ) : (
          <Icon name={paused ? 'coffee' : finished ? 'check' : 'play_arrow'} size={variant === 'rail' ? 22 : 18} />
        )}
        {variant === 'rail' ? (
          working && <span className="shift-btn-time">{clock(s.worked)}</span>
        ) : (
          <span className="shift-btn-label">{label}</span>
        )}
      </button>
      {startOpen && createPortal(
        <StartModal resume={false} onClose={() => setStartOpen(false)} onStarted={() => { setStartOpen(false); s.refetch(); }} />,
        document.body,
      )}
      {cardOpen && createPortal(<ShiftCard onClose={() => setCardOpen(false)} />, document.body)}
    </>
  );
}

/** Окно прихода — то же подтверждение, что в «Рабочем дне» (геолокация или фото/видео). */
function StartModal({ resume, onClose, onStarted }: { resume: boolean; onClose: () => void; onStarted: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  return (
    <AnimatePresence>
      <ClockInModal
        resume={resume}
        onCancel={onClose}
        onConfirm={async (vars) => {
          try {
            await apiClockIn(vars);
            toast(t(resume ? 'sh.toast.resumed' : 'sh.toast.started'), 'success');
            qc.invalidateQueries({ queryKey: ['time'] });
            onStarted();
          } catch (e: any) {
            toast(e?.response?.data?.message || t('toast.error'), 'error');
          }
        }}
      />
    </AnimatePresence>
  );
}

const PAUSES: Array<{ kind: PauseKind; icon: string; labelKey: string; hintKey: string }> = [
  { kind: 'LUNCH', icon: 'restaurant', labelKey: 'sh.pause.lunch', hintKey: 'sh.pause.lunchHint' },
  { kind: 'WORK', icon: 'directions_car', labelKey: 'sh.pause.work', hintKey: 'sh.pause.workHint' },
  { kind: 'PERSONAL', icon: 'person', labelKey: 'sh.pause.personal', hintKey: 'sh.pause.personalHint' },
];

/** Карточка «Моя смена». */
export function ShiftCard({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const s = useMyShift();
  const d = s.data;
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [fixing, setFixing] = useState(false);
  useEscClose(!resumeOpen, onClose, busy);

  const run = async (fn: () => Promise<MyShift | unknown>, okKey?: string) => {
    setBusy(true);
    try {
      const fresh = await fn();
      if (fresh && typeof fresh === 'object' && 'state' in (fresh as any)) qc.setQueryData(SHIFT_KEY, fresh);
      qc.invalidateQueries({ queryKey: SHIFT_KEY });
      qc.invalidateQueries({ queryKey: ['time'] });
      if (okKey) toast(t(okKey), 'success');
      return fresh;
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
      return null;
    } finally {
      setBusy(false);
      setPausing(false);
    }
  };

  const finish = async () => {
    if (d && d.norm.isWorkday && s.worked < d.norm.minutes) {
      const ok = await confirm({
        title: t('sh.finish.title'),
        message: t('sh.finish.early').replace('{end}', d.norm.end).replace('{left}', fmtMin(d.norm.minutes - s.worked)),
        confirmText: t('sh.finish'),
      });
      if (!ok) return;
    }
    await run(apiClockOut, 'sh.toast.finished');
  };

  const st = d?.state ?? 'idle';
  const norm = d?.norm.minutes || 480;
  const left = Math.max(0, norm - s.worked);
  const pct = Math.min(100, Math.round((s.worked / norm) * 100));
  const pauseLabel = (k: PauseKind | null) => t(PAUSES.find((p) => p.kind === k)?.labelKey ?? 'sh.pause.personal');
  const statusText = !d
    ? t('common.loading')
    : st === 'working'
      ? t('sh.status.working').replace('{t}', d.startedAt ? tjFormatTime(d.startedAt) : '—')
      : st === 'lunch' || st === 'break'
        ? t('sh.status.paused').replace('{x}', pauseLabel(d.pauseKind)).replace('{t}', d.since ? tjFormatTime(d.since) : '—')
        : d.startedAt
          ? t('sh.status.done')
          : t('sh.status.idle');
  const weekMax = Math.max(norm, ...(d?.week ?? []).map((w) => w.minutes));
  const weekTotal = (d?.week ?? []).reduce((a, w) => a + w.minutes, 0);

  return (
    <div className="shift-card-backdrop" onClick={() => !busy && onClose()} data-testid="shift-card-backdrop">
      <div className="shift-card" role="dialog" aria-modal="true" aria-label={t('sh.title')} onClick={(e) => e.stopPropagation()} data-testid="shift-card">
        <div className="shift-card-head">
          <span className="shift-card-title">{t('sh.title')}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')} data-testid="shift-card-close">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="shift-status">
          <span className={`shift-status-dot is-${st}`} aria-hidden="true" />
          <span data-testid="shift-status">{statusText}</span>
          {d?.isLate && <span className="shift-chip is-late" data-testid="shift-late">{t('sh.late').replace('{n}', String(d.lateMinutes))}</span>}
        </div>
        <div className="shift-counter">
          <b data-testid="shift-worked">{fmtMin(s.worked)}</b>
          <span>{left > 0 ? t('sh.normLeft').replace('{norm}', fmtMin(norm)).replace('{left}', fmtMin(left)) : t('sh.normDone').replace('{norm}', fmtMin(norm))}</span>
        </div>
        <div className="shift-progress" role="progressbar" aria-valuemin={0} aria-valuemax={norm} aria-valuenow={s.worked}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="shift-progress-scale"><span>{d?.norm.start ?? '09:00'}</span><span>{d?.norm.end ?? '18:00'}</span></div>

        {d?.needsExcuse && (
          <div className="shift-excuse" data-testid="shift-excuse">
            <Icon name="warning" size={18} />
            <span>{t('sh.excuse').replace('{n}', String(d.lateMinutes))}</span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => { onClose(); navigate('/workday?tab=time'); }} data-testid="shift-excuse-go">
              {t('sh.excuseGo')}
            </button>
          </div>
        )}

        {/* Действия */}
        {pausing ? (
          <div className="shift-pauses" data-testid="shift-pauses">
            <span className="shift-section-label">{t('sh.pause.ask')}</span>
            {PAUSES.map((p) => (
              <button key={p.kind} type="button" className="shift-pause-opt" disabled={busy} onClick={() => run(() => pauseShift(p.kind))} data-testid={`shift-pause-${p.kind}`}>
                <Icon name={p.icon} size={20} />
                <span><b>{t(p.labelKey)}</b><small>{t(p.hintKey)}</small></span>
              </button>
            ))}
            <button type="button" className="btn btn-secondary" onClick={() => setPausing(false)}>{t('common.cancel')}</button>
          </div>
        ) : (
          <div className="shift-actions">
            {st === 'idle' && (
              <button type="button" className="btn btn-success shift-main" onClick={() => setResumeOpen(true)} disabled={busy} data-testid="shift-start">
                <Icon name="play_arrow" size={20} /> {d?.startedAt ? t('sh.resumeDay') : t('sh.start')}
              </button>
            )}
            {st === 'working' && (
              <button type="button" className="btn shift-main is-pause" onClick={() => setPausing(true)} disabled={busy} data-testid="shift-pause">
                <Icon name="coffee" size={20} /> {t('sh.pause')}
              </button>
            )}
            {(st === 'lunch' || st === 'break') && (
              <button type="button" className="btn btn-success shift-main" disabled={busy}
                onClick={async () => {
                  const r: any = await run(resumeShift, 'sh.toast.back');
                  if (r?.requiresLunchExcuse) { onClose(); navigate('/workday?tab=time'); }
                }}
                data-testid="shift-resume">
                <Icon name="play_arrow" size={20} /> {t('sh.resume')}
              </button>
            )}
            {st !== 'idle' && (
              <button type="button" className="btn shift-main is-stop" onClick={finish} disabled={busy} data-testid="shift-finish">
                <Icon name="stop" size={20} /> {t('sh.finish')}
              </button>
            )}
          </div>
        )}

        {d && d.breaks.length > 0 && (
          <div className="shift-section" data-testid="shift-breaks">
            <span className="shift-section-label">{t('sh.breaks')}</span>
            {d.breaks.map((b, i) => (
              <div key={i} className="shift-break-row">
                <span className={`shift-break-dot${b.paid ? '' : ' is-unpaid'}`} />
                <span className="shift-break-text">{tjFormatTime(b.from)} — {b.to ? tjFormatTime(b.to) : t('sh.now')} · {pauseLabel(b.kind).toLowerCase()}</span>
                <span className={b.paid ? 'shift-break-min' : 'shift-break-min is-unpaid'}>{fmtMin(b.minutes)}</span>
              </div>
            ))}
          </div>
        )}

        {d && weekTotal > 0 && (
          <div className="shift-section" data-testid="shift-week">
            <span className="shift-section-label">{t('sh.week')}</span>
            <div className="shift-week">
              {d.week.map((w) => (
                <span key={w.date} className={`shift-week-day${w.date === d.today ? ' is-today' : ''}`} title={`${w.day} · ${fmtMin(w.minutes)}`}>
                  <span className={`shift-week-bar${w.minutes >= norm ? ' is-full' : ''}`} style={{ height: `${Math.max(4, Math.round((w.minutes / weekMax) * 48))}px` }} />
                  <span>{w.day}</span>
                </span>
              ))}
            </div>
            <div className="shift-week-total"><span>{t('sh.weekTotal')}</span><b>{fmtMin(weekTotal)}</b></div>
          </div>
        )}

        {asking ? (
          <NoticeForm start={d?.norm.start ?? '09:00'} onDone={() => { setAsking(false); s.refetch(); }} onCancel={() => setAsking(false)} />
        ) : (
          <button type="button" className="shift-link" onClick={() => setAsking(true)} data-testid="shift-notice-open">
            <Icon name="event_upcoming" size={18} /> {t('sh.notice.open')}
          </button>
        )}
        {d && d.notices.length > 0 && (
          <div className="shift-section" data-testid="shift-notices">
            <span className="shift-section-label">{t('sh.notice.mine')}</span>
            {d.notices.map((n) => (
              <div key={n.id} className="shift-req-row">
                <span className={`shift-req-dot is-${n.status}`} />
                <span className="shift-req-text">{n.date.slice(8, 10)}.{n.date.slice(5, 7)} · {t('sh.notice.at').replace('{t}', n.plannedTime)}{n.reason ? ` · ${n.reason}` : ''}</span>
                <span className={`shift-req-status is-${n.status}`}>{t(`sh.req.${n.status}`)}</span>
              </div>
            ))}
          </div>
        )}

        {fixing ? (
          <EditForm onDone={() => { setFixing(false); s.refetch(); }} onCancel={() => setFixing(false)} />
        ) : (
          <button type="button" className="shift-link" onClick={() => setFixing(true)} data-testid="shift-edit-open">
            <Icon name="schedule" size={18} /> {t('sh.edit.open')}
          </button>
        )}
        {d && d.edits.length > 0 && (
          <div className="shift-section" data-testid="shift-edits">
            {d.edits.map((r) => (
              <div key={r.id} className="shift-req-row">
                <span className={`shift-req-dot is-${r.status}`} />
                <span className="shift-req-text">
                  {r.date.slice(8, 10)}.{r.date.slice(5, 7)} · {t(r.field === 'start' ? 'sh.edit.start' : 'sh.edit.end').toLowerCase()}: {r.currentTime ?? '—'} → {r.requestedTime}
                </span>
                <span className={`shift-req-status is-${r.status}`}>{t(`sh.req.${r.status}`)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {resumeOpen && (
        <StartModal resume={!!d?.startedAt} onClose={() => setResumeOpen(false)} onStarted={() => { setResumeOpen(false); s.refetch(); }} />
      )}
    </div>
  );
}

const tomorrow = () => {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dushanbe' }).format(d);
};
const todayTj = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dushanbe' }).format(new Date());

/** «Приду позже — предупредить заранее». */
function NoticeForm({ start, onDone, onCancel }: { start: string; onDone: () => void; onCancel: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const [date, setDate] = useState(tomorrow());
  const [time, setTime] = useState('11:00');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await createNotice({ date, time, reason: reason.trim() || undefined });
      toast(t('sh.sent'), 'success');
      onDone();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shift-form" data-testid="shift-notice-form">
      <b>{t('sh.notice.title')}</b>
      <p>{t('sh.notice.text').replace('{t}', start)}</p>
      <div className="shift-form-row">
        <CrmDatePicker value={date} onChange={setDate} min={todayTj()} />
        <input type="time" className="crm-input" value={time} onChange={(e) => setTime(e.target.value)} data-testid="shift-notice-time" />
      </div>
      <input className="crm-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={t('sh.notice.reason')} data-testid="shift-notice-reason" />
      {err && <div className="form-error-text" role="alert" data-testid="shift-notice-error">{err}</div>}
      <div className="shift-form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy} data-testid="shift-notice-send">
          <BusyLabel busy={busy}>{t('sh.send')}</BusyLabel>
        </button>
      </div>
    </div>
  );
}

/** «Забыл отметить — поправить время». */
function EditForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useT();
  const { toast } = useUI();
  const [date, setDate] = useState(todayTj());
  const [field, setField] = useState<'start' | 'end'>('start');
  const [time, setTime] = useState('09:00');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await requestEdit({ date, field, time, note: note.trim() || undefined });
      toast(t('sh.sent'), 'success');
      onDone();
    } catch (e: any) {
      setErr(e?.response?.data?.message || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shift-form" data-testid="shift-edit-form">
      <b>{t('sh.edit.title')}</b>
      <p>{t('sh.edit.text')}</p>
      <div className="seg-toggle shift-seg" role="group">
        <button type="button" className={field === 'start' ? 'active' : ''} aria-pressed={field === 'start'} onClick={() => setField('start')} data-testid="shift-edit-start">{t('sh.edit.start')}</button>
        <button type="button" className={field === 'end' ? 'active' : ''} aria-pressed={field === 'end'} onClick={() => setField('end')} data-testid="shift-edit-end">{t('sh.edit.end')}</button>
      </div>
      <div className="shift-form-row">
        <CrmDatePicker value={date} onChange={setDate} max={todayTj()} />
        <input type="time" className="crm-input" value={time} onChange={(e) => setTime(e.target.value)} data-testid="shift-edit-time" />
      </div>
      <input className="crm-input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={t('sh.edit.note')} data-testid="shift-edit-note" />
      {err && <div className="form-error-text" role="alert" data-testid="shift-edit-error">{err}</div>}
      <div className="shift-form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy} data-testid="shift-edit-send">
          <BusyLabel busy={busy}>{t('sh.send')}</BusyLabel>
        </button>
      </div>
    </div>
  );
}
