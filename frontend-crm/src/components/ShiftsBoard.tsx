import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import Icon from '../Icon';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { useRealtimeEvent } from '../realtime';
import { useEscClose } from '../lib/useEscClose';
import { useRoleLabel } from '../lib/labels';
import { tjFormatTime } from '../lib/tjTime';
import { fmtMin } from './ShiftWidget';
import {
  decideEdit,
  decideNotice,
  fetchEdits,
  fetchMyShiftMonth,
  fetchNotices,
  fetchShiftMonth,
  fetchTeamToday,
  removeAbsence,
  setAbsence,
  type AbsenceKind,
  type MonthPerson,
  type ShiftMonth,
  type TeamPerson,
} from '../api/shift';

/**
 * «Активность и смены» (13.11.2026, раскладка как в Sabt, цвета Javonon):
 * табель месяца с окном сотрудника, смены сегодня с просьбами и отгулами.
 */
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_TG = ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const AV = ['#1E5BB8', '#7C3AED', '#0E7490', '#B45309', '#BE185D', '#15803D', '#4338CA', '#C2410C'];
const avColor = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AV[h % AV.length]; };
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
/** «7.5» часа или «45м» — для клетки табеля. */
const short = (min: number) => (!min ? '·' : min < 60 ? `${min}м` : (Math.round((min / 60) * 10) / 10).toFixed(1).replace('.0', ''));
const tone = (min: number) => (!min ? 'is-empty' : min >= 480 ? 'is-full' : min >= 300 ? 'is-mid' : 'is-low');
const ABS_SHORT: Record<AbsenceKind, string> = { DAYOFF: 'О', VACATION: 'От', SICK: 'Б', HOLIDAY: 'П' };

function usePosition() {
  const roleLabel = useRoleLabel();
  return (p: { position: string | null; role: string }) => p.position || roleLabel(p.role);
}

function useMonthLabel() {
  const { lang } = useT();
  return (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return `${(lang === 'tg' ? MONTHS_TG : MONTHS)[m - 1]} ${y}`;
  };
}

function MonthNav({ ym, setYm }: { ym: string; setYm: (v: string) => void }) {
  const { t } = useT();
  const label = useMonthLabel();
  const go = (n: number) => { const [y, m] = ym.split('-').map(Number); setYm(ymOf(new Date(y, m - 1 + n, 1))); };
  return (
    <div className="ts-month-nav">
      <button type="button" className="icon-btn" onClick={() => go(-1)} aria-label={t('ts.prev')} data-testid="ts-prev"><Icon name="chevron_left" size={18} /></button>
      <b data-testid="ts-month">{label(ym)}</b>
      <button type="button" className="icon-btn" onClick={() => go(1)} aria-label={t('ts.next')} data-testid="ts-next"><Icon name="chevron_right" size={18} /></button>
    </div>
  );
}

/** Табель рабочих часов: команда × дни месяца. */
export function Timesheet() {
  const { t } = useT();
  const qc = useQueryClient();
  const [ym, setYm] = useState(() => ymOf(new Date()));
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['shift', 'month', ym], queryFn: () => fetchShiftMonth(ym), placeholderData: keepPreviousData, refetchInterval: 120_000 });
  useRealtimeEvent('attendance:updated', () => qc.invalidateQueries({ queryKey: ['shift', 'month'] }));
  const data = q.data;
  const position = usePosition();
  const days = useMemo(() => Array.from({ length: data?.daysInMonth ?? 30 }, (_, i) => i + 1), [data?.daysInMonth]);
  const todayNum = data && data.today.slice(0, 7) === ym ? Number(data.today.slice(8, 10)) : 0;
  const person = data?.items.find((p) => p.id === openId) ?? null;
  return (
    <div className="card ts-card" data-testid="timesheet">
      <div className="ts-head">
        <Icon name="schedule" size={18} />
        <b>{t('ts.title')}</b>
        <MonthNav ym={ym} setYm={setYm} />
      </div>
      <div className="ts-scroll">
        {q.isLoading && !data ? (
          <p className="ts-empty">{t('common.loading')}</p>
        ) : !data?.items.length ? (
          <p className="ts-empty" data-testid="ts-empty">{t('ts.empty')}</p>
        ) : (
          <table className="ts-table">
            <thead>
              <tr>
                <th className="ts-name-col">{t('ts.employee')}</th>
                {days.map((d) => <th key={d} className={d === todayNum ? 'is-today' : ''}>{d}</th>)}
                <th className="ts-total-col">{t('ts.total')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} onClick={() => setOpenId(p.id)} data-testid={`ts-row-${p.id}`} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(p.id); }}>
                  <td className="ts-name-col">
                    <span className="ts-person">
                      <span className="ts-av" style={{ background: avColor(p.id) }}>{initials(p.name)}</span>
                      <span className="ts-person-text"><b>{p.name}</b><small>{position(p)}</small></span>
                    </span>
                  </td>
                  {days.map((d) => {
                    const min = p.days[d] ?? 0;
                    const abs = p.absence[d];
                    const late = p.lateDays.includes(d);
                    return (
                      <td key={d}>
                        <span
                          className={`ts-cell ${abs && !min ? 'is-absence' : tone(min)}${late ? ' is-late' : ''}`}
                          title={abs && !min ? t(`ts.abs.${abs}`) : min ? `${d} · ${fmtMin(min)}${late ? ` · ${t('ts.lateWord')}` : ''}` : undefined}
                          data-testid={`ts-cell-${p.id}-${d}`}
                        >
                          {abs && !min ? ABS_SHORT[abs] : short(min)}
                        </span>
                      </td>
                    );
                  })}
                  <td className="ts-total-col">
                    <b>{p.totalMinutes ? fmtMin(p.totalMinutes) : '—'}</b>
                    <small>{t('ts.daysAvg').replace('{d}', String(p.workedDays)).replace('{a}', p.avgMinutes ? fmtMin(p.avgMinutes) : '—')}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="ts-foot">{t('ts.hint').replace('{late}', data?.lateAfter ?? '09:10').replace('{start}', data?.workStart ?? '09:00')}</p>
      {person && data && createPortal(<PersonCard person={person} data={data} ym={ym} onClose={() => setOpenId(null)} />, document.body)}
    </div>
  );
}

/** Окно сотрудника: календарь месяца, смены по дням, итоги. */
export function PersonCard({ person, data, ym, onClose, inline }: { person: MonthPerson; data: ShiftMonth; ym: string; onClose?: () => void; inline?: boolean }) {
  const { t } = useT();
  const position = usePosition();
  const label = useMonthLabel();
  useEscClose(!inline, () => onClose?.());
  const [y, m] = ym.split('-').map(Number);
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const days = Array.from({ length: data.daysInMonth }, (_, i) => i + 1);
  const withShifts = days.filter((d) => (person.segments[d]?.length ?? 0) > 0).sort((a, b) => b - a);
  const todayNum = data.today.slice(0, 7) === ym ? Number(data.today.slice(8, 10)) : 0;
  const body = (
    <div className="pc-body">
      <div className="pc-main">
        <div className="pc-cal">
          {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((w) => <span key={w} className="pc-wd">{t(`ts.wd.${w}`)}</span>)}
          {Array.from({ length: offset }, (_, i) => <span key={`x${i}`} />)}
          {days.map((d) => {
            const min = person.days[d] ?? 0;
            const abs = person.absence[d];
            return (
              <span key={d} className={`pc-day ${abs && !min ? 'is-absence' : tone(min)}${person.lateDays.includes(d) ? ' is-late' : ''}${d === todayNum ? ' is-today' : ''}`} data-testid={`pc-day-${d}`}>
                <small>{d}</small>
                <b>{abs && !min ? ABS_SHORT[abs] : min ? short(min) : ''}</b>
              </span>
            );
          })}
        </div>
        <div className="pc-shifts">
          <span className="pc-label">{t('ts.byDay')}</span>
          {withShifts.length === 0 ? (
            <p className="pc-none">{t('ts.noShifts')}</p>
          ) : withShifts.map((d) => (
            <div key={d} className="pc-shift-row" data-testid={`pc-shift-${d}`}>
              <span className="pc-shift-day">{t('ts.dayN').replace('{d}', String(d))}</span>
              <span className="pc-shift-segs">
                {person.segments[d].map((s, i) => (
                  <span key={i} className={`pc-seg${s.auto ? ' is-auto' : !s.to ? ' is-now' : ''}`}>
                    {s.from} — {s.to ?? t('sh.now')}{s.auto ? ` · ${t('ts.autoClosed')}` : ''}
                  </span>
                ))}
                {(person.breaks[d] ?? []).map((b, i) => (
                  <span key={`b${i}`} className={`pc-seg is-break${b.kind === 'PERSONAL' ? ' is-unpaid' : ''}`}>
                    {t(`ts.br.${b.kind}`)} {b.from}{b.to ? `–${b.to}` : ''}
                  </span>
                ))}
              </span>
              <b className="pc-shift-min">{fmtMin(person.days[d] ?? 0)}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="pc-tiles">
        <Tile value={fmtMin(person.totalMinutes)} label={t('ts.tile.total').replace('{m}', label(ym).split(' ')[0])} testId="pc-total" />
        <Tile value={person.avgMinutes ? fmtMin(person.avgMinutes) : '—'} label={t('ts.tile.avg')} />
        <Tile value={String(person.workedDays)} label={t('ts.tile.days')} testId="pc-days" />
        <Tile value={String(person.lateDays.length)} label={t('ts.tile.late')} tone={person.lateDays.length ? 'amber' : undefined} testId="pc-late" />
        <Tile value={String(person.autoDays.length)} label={t('ts.tile.auto')} tone={person.autoDays.length ? 'red' : undefined} />
      </div>
    </div>
  );
  if (inline) return <div className="card pc-inline" data-testid="my-month">{body}</div>;
  return (
    <div className="pc-backdrop" onClick={onClose} data-testid="pc-backdrop">
      <div className="pc-card" role="dialog" aria-modal="true" aria-label={person.name} onClick={(e) => e.stopPropagation()} data-testid="person-card">
        <div className="pc-head">
          <span className="ts-av is-big" style={{ background: avColor(person.id) }}>{initials(person.name)}</span>
          <span className="ts-person-text"><b>{person.name}</b><small>{position(person)} · {label(ym)}</small></span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')} data-testid="pc-close"><Icon name="close" size={18} /></button>
        </div>
        {body}
      </div>
    </div>
  );
}

function Tile({ value, label, tone, testId }: { value: string; label: string; tone?: 'amber' | 'red'; testId?: string }) {
  return (
    <div className={`pc-tile${tone ? ` is-${tone}` : ''}`} data-testid={testId}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** Свой месяц — для сотрудника без доступа к команде. */
export function MyMonth() {
  const { t } = useT();
  const [ym, setYm] = useState(() => ymOf(new Date()));
  const q = useQuery({ queryKey: ['shift', 'my-month', ym], queryFn: () => fetchMyShiftMonth(ym), placeholderData: keepPreviousData });
  return (
    <div className="my-month">
      <div className="ts-head is-plain">
        <Icon name="calendar_month" size={18} />
        <b>{t('ts.myMonth')}</b>
        <MonthNav ym={ym} setYm={setYm} />
      </div>
      {q.data?.item ? <PersonCard person={q.data.item} data={q.data} ym={ym} inline /> : <p className="ts-empty">{t('common.loading')}</p>}
    </div>
  );
}

const GROUPS: Array<{ key: TeamPerson['status']; cls: string }> = [
  { key: 'working', cls: 'is-green' },
  { key: 'paused', cls: 'is-amber' },
  { key: 'closed', cls: 'is-gray' },
  { key: 'waiting', cls: 'is-gray' },
  { key: 'off', cls: 'is-blue' },
  { key: 'absent', cls: 'is-red' },
];
const hm = (min: number) => (min ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` : '—');

/** Смены сегодня: кто на работе, просьбы, отгулы. */
export function TeamToday() {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const position = usePosition();
  const q = useQuery({ queryKey: ['shift', 'team'], queryFn: fetchTeamToday, refetchInterval: 60_000 });
  const notices = useQuery({ queryKey: ['shift', 'notices'], queryFn: fetchNotices, refetchInterval: 120_000 });
  const edits = useQuery({ queryKey: ['shift', 'edits'], queryFn: fetchEdits, refetchInterval: 120_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['shift'] });
  useRealtimeEvent('attendance:updated', refresh);
  useRealtimeEvent('shift:requests', refresh);
  const [marking, setMarking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, okKey: string) => {
    setBusy(true);
    try { await fn(); toast(t(okKey), 'success'); refresh(); } catch (e: any) { toast(e?.response?.data?.message || t('toast.error'), 'error'); } finally { setBusy(false); setMarking(null); }
  };
  const items = q.data?.items ?? [];
  const count = (k: TeamPerson['status']) => items.filter((u) => u.status === k).length;
  const lateCount = items.filter((u) => u.late).length;
  const dayLabel = q.data ? new Date(`${q.data.date}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  return (
    <div className="tt" data-testid="team-today">
      <div className="tt-tiles">
        <div className="tt-tile"><b data-testid="tt-working">{count('working')}</b><span>{t('tt.tile.working')}</span></div>
        <div className="tt-tile is-amber"><b>{count('paused')}</b><span>{t('tt.tile.paused')}</span></div>
        <div className="tt-tile is-red"><b data-testid="tt-absent">{count('absent')}</b><span>{t('tt.tile.absent')}</span></div>
        <div className={`tt-tile${lateCount ? ' is-amber' : ''}`}><b>{lateCount}</b><span>{t('tt.tile.late')}</span></div>
      </div>
      {(notices.data?.length ?? 0) > 0 && (
        <div className="tt-queue is-blue" data-testid="tt-notices">
          <b>{t('tt.notices')} · {notices.data!.length}</b>
          {notices.data!.map((n) => (
            <div key={n.id} className="tt-req" data-testid={`tt-notice-${n.id}`}>
              <span className="tt-req-text"><b>{n.name} · {n.date.slice(8, 10)}.{n.date.slice(5, 7)}</b><small>{t('sh.notice.at').replace('{t}', n.plannedTime)}{n.reason ? ` · ${n.reason}` : ''}</small></span>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => decideNotice(n.id, true), 'tt.approved')} data-testid="tt-approve">{t('tt.approve')}</button>
              <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act(() => decideNotice(n.id, false), 'tt.rejected')} data-testid="tt-reject">{t('tt.reject')}</button>
            </div>
          ))}
        </div>
      )}
      {(edits.data?.length ?? 0) > 0 && (
        <div className="tt-queue is-amber" data-testid="tt-edits">
          <b>{t('tt.edits')} · {edits.data!.length}</b>
          {edits.data!.map((r) => (
            <div key={r.id} className="tt-req" data-testid={`tt-edit-${r.id}`}>
              <span className="tt-req-text"><b>{r.name}</b><small>{r.date.slice(8, 10)}.{r.date.slice(5, 7)} · {t(r.field === 'start' ? 'sh.edit.start' : 'sh.edit.end').toLowerCase()}: <s>{r.currentTime ?? '—'}</s> → <b>{r.requestedTime}</b>{r.note ? ` · ${r.note}` : ''}</small></span>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => decideEdit(r.id, true), 'tt.fixed')} data-testid="tt-edit-approve">{t('tt.confirm')}</button>
              <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act(() => decideEdit(r.id, false), 'tt.rejected')} data-testid="tt-edit-reject">{t('tt.reject')}</button>
            </div>
          ))}
        </div>
      )}
      <div className="card tt-list">
        <div className="ts-head"><Icon name="schedule" size={18} /><b>{t('tt.title')}</b><span className="tt-date">{dayLabel}</span></div>
        <div className="tt-cols"><span>{t('ts.employee')}</span><span>{t('tt.col.came')}</span><span>{t('tt.col.today')}</span><span>{t('tt.col.week')}</span></div>
        {GROUPS.map((g) => {
          const list = items.filter((u) => u.status === g.key);
          if (!list.length) return null;
          return (
            <div key={g.key} data-testid={`tt-group-${g.key}`}>
              <div className={`tt-group ${g.cls}`}>{t(`tt.group.${g.key}`)} · {list.length}</div>
              {list.map((u) => (
                <div key={u.id} className="tt-row" data-testid={`tt-row-${u.id}`}>
                  <span className="ts-person">
                    <span className="ts-av" style={{ background: g.key === 'absent' || g.key === 'off' ? '#94A3B8' : avColor(u.id) }}>{initials(u.name)}</span>
                    <span className="ts-person-text">
                      <b>{u.name}</b>
                      <small>
                        {position(u)}
                        {u.status === 'paused' ? ` · ${t(`ts.br.${u.pauseKind ?? 'PERSONAL'}`)}` : ''}
                        {u.status === 'off' ? ` · ${u.absenceKind ? t(`ts.abs.${u.absenceKind}`) : t('tt.dayOff')}` : ''}
                      </small>
                    </span>
                  </span>
                  {u.status === 'absent' || u.status === 'off' || u.status === 'waiting' ? (
                    <span className="tt-actions">
                      {u.status === 'off' && u.absenceKind ? (
                        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act(() => removeAbsence(u.id, q.data!.date), 'tt.unmarked')} data-testid="tt-unmark">{t('tt.unmark')}</button>
                      ) : u.status !== 'off' && (marking === u.id ? (
                        <>
                          {(['DAYOFF', 'VACATION', 'SICK', 'HOLIDAY'] as AbsenceKind[]).map((k) => (
                            <button key={k} type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act(() => setAbsence({ userId: u.id, date: q.data!.date, kind: k }), 'tt.marked')} data-testid={`tt-mark-${k}`}>{t(`ts.abs.${k}`)}</button>
                          ))}
                          <button type="button" className="icon-btn" onClick={() => setMarking(null)} aria-label={t('common.cancel')}><Icon name="close" size={16} /></button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setMarking(u.id)} data-testid="tt-mark">{t('tt.mark')}</button>
                      ))}
                    </span>
                  ) : (
                    <>
                      <span className={`tt-num${u.late ? ' is-late' : ''}`}>{u.startedAt ? tjFormatTime(u.startedAt) : '—'}{u.excused && <small className="tt-excused">{t('tt.excused')}</small>}</span>
                      <span className="tt-num is-strong">{hm(u.todayMinutes)}</span>
                      <span className="tt-num is-soft">{hm(u.weekMinutes)}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        <p className="ts-foot">{t('tt.hint')}</p>
      </div>
    </div>
  );
}
