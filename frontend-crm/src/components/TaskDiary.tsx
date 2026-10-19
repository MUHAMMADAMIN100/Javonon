import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { useNow } from '../lib/useNow';
import { useMediaQuery } from '../lib/useMediaQuery';
import { tjFormatDateTime } from '../lib/tjTime';
import {
  getTaskDiary,
  writeTaskDiary,
  type TaskDiary as Diary,
  type TaskDiaryBlock,
  type TaskDiaryCell,
  type TaskDiaryWeekday,
} from '../api/tasks';
import DismissedMark from './DismissedMark';

/**
 * Дневник задачи — как дневник ДЗ ученика: каждый исполнитель за каждый
 * рабочий день (по «Графику работы») пишет, что сделал. Писать — только за
 * сегодня и до конца рабочего дня; отсчёт показывает, сколько осталось.
 * Ниже — «исполнители × дни» (на телефоне — по дням): записано, пропуск,
 * сегодня, впереди. Правила — backend tasks/task-diary.ts.
 */

type T = (key: string) => string;

/** «2 ч 15 мин», «45 мин», «меньше минуты». */
export function formatLeft(ms: number, t: T): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('taskDiary.lessThanMinute');
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} ${t('taskDiary.h')} ${m} ${t('taskDiary.min')}` : `${m} ${t('taskDiary.min')}`;
}

/** «Вт 20.10» из 'YYYY-MM-DD'. */
function dayLabel(day: string, weekday: TaskDiaryWeekday, t: T): { wd: string; date: string } {
  const [, mm, dd] = day.split('-');
  return { wd: t(`weekday.short.${weekday.toLowerCase()}`), date: `${dd}.${mm}` };
}

/** Отсчёт до конца рабочего дня — момента, когда закрывается запись за сегодня. */
export function DiaryCountdown({
  closesAt,
  compact = false,
  onExpire,
  testId = 'diary-countdown',
}: {
  closesAt: string;
  compact?: boolean;
  onExpire?: () => void;
  testId?: string;
}) {
  const { t } = useT();
  const now = useNow(1000);
  const left = new Date(closesAt).getTime() - now;
  const over = left <= 0;
  const fired = useRef(false);
  useEffect(() => {
    if (over && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
  }, [over, onExpire]);
  if (over) {
    return (
      <span className="tdiary-countdown is-over" data-testid={testId}>
        <Icon name="lock_clock" size={compact ? 14 : 16} /> {t('taskDiary.dayOver')}
      </span>
    );
  }
  // Последний час — красным: пора писать.
  const urgent = left < 60 * 60_000;
  return (
    <span
      className={`tdiary-countdown${urgent ? ' is-urgent' : ''}${compact ? ' is-compact' : ''}`}
      title={t('taskDiary.countdownHint')}
      data-testid={testId}
    >
      <Icon name="hourglass_top" size={compact ? 14 : 16} />
      {compact ? formatLeft(left, t) : `${t('taskDiary.untilEnd')}: ${formatLeft(left, t)}`}
    </span>
  );
}

const BLOCK_KEY: Record<TaskDiaryBlock, string> = {
  'no-deadline': 'taskDiary.block.noDeadline',
  done: 'taskDiary.block.done',
  'not-started': 'taskDiary.block.notStarted',
  'after-deadline': 'taskDiary.block.afterDeadline',
  'day-off': 'taskDiary.block.dayOff',
  'day-closed': 'taskDiary.block.dayClosed',
};

export default function TaskDiary({ taskId }: { taskId: string }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const narrow = useMediaQuery('(max-width: 760px)');
  const query = useQuery({ queryKey: keys.tasks.diary(taskId), queryFn: () => getTaskDiary(taskId) });
  const d = query.data;
  /** Черновик записи; null — в поле сегодняшний текст с сервера. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Открытая запись из таблицы: чья и за какой день. */
  const [picked, setPicked] = useState<{ userId: string; day: string } | null>(null);

  const save = useMutation({
    mutationFn: (text: string) => writeTaskDiary(taskId, text),
    onSuccess: () => {
      toast(t('taskDiary.saved'), 'success');
      setDraft(null);
      qc.invalidateQueries({ queryKey: keys.tasks.all });
    },
    onError: (e: any) => {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
      qc.invalidateQueries({ queryKey: keys.tasks.diary(taskId) });
    },
  });

  if (query.isLoading) {
    return <section className="tdiary" data-testid="task-diary"><div className="tdiary-muted">{t('common.loading')}</div></section>;
  }
  if (query.isError || !d) {
    return <section className="tdiary" data-testid="task-diary"><div className="tdiary-muted">{t('toast.error')}</div></section>;
  }
  if (!d.enabled) {
    return (
      <section className="tdiary is-off" data-testid="task-diary-off">
        <Icon name="event_note" size={18} /> {t('taskDiary.needsDeadline')}
      </section>
    );
  }

  const diary = d as Diary;
  const me = diary.me;
  const value = draft ?? me.todayText ?? '';
  const unchanged = value.trim() === (me.todayText ?? '').trim();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.tasks.all });
  const pickedRow = picked ? diary.rows.find((r) => r.user.id === picked.userId) : null;
  const pickedCell = picked && pickedRow ? pickedRow.cells[picked.day] : null;
  const pickedDay = picked ? diary.days.find((x) => x.day === picked.day) : null;
  /** Записано / учтено (прошедшие и сегодняшний, без «впереди» и «готово»). */
  const tally = (cells: Record<string, TaskDiaryCell>) => {
    const counted = diary.days.filter((x) => ['written', 'missed', 'open'].includes(cells[x.day]?.state));
    return { written: counted.filter((x) => cells[x.day]?.state === 'written').length, total: counted.length };
  };
  const toggle = (userId: string, day: string) =>
    setPicked((cur) => (cur && cur.userId === userId && cur.day === day ? null : { userId, day }));
  const firstDay = (() => {
    const [y, m, dd] = diary.from.split('-');
    return `${dd}.${m}.${y}`;
  })();

  const cellView = (userId: string, day: string, cell: TaskDiaryCell | undefined) => {
    const state = cell?.state ?? 'future';
    const testId = `diary-cell-${userId}-${day}`;
    if (state === 'written') {
      const active = picked?.userId === userId && picked?.day === day;
      return (
        <button
          type="button"
          className={`tdiary-cell is-written${active ? ' is-active' : ''}`}
          onClick={() => toggle(userId, day)}
          title={cell?.text}
          aria-label={`${t('taskDiary.state.written')}: ${cell?.text ?? ''}`}
          data-state="written"
          data-testid={testId}
        >
          <Icon name="check" size={16} />
        </button>
      );
    }
    const icon = state === 'open' ? 'hourglass_top' : state === 'missed' ? 'close' : state === 'done' ? 'task_alt' : state === 'off' ? 'weekend' : 'more_horiz';
    return (
      <span className={`tdiary-cell is-${state}`} title={t(`taskDiary.state.${state}`)} data-state={state} data-testid={testId}>
        <Icon name={icon} size={14} />
      </span>
    );
  };

  return (
    <section className="tdiary" data-testid="task-diary">
      <div className="tdiary-head">
        <h4 className="tdiary-title"><Icon name="edit_note" size={20} /> {t('taskDiary.title')}</h4>
        <span className="tdiary-sub">{t('taskDiary.sub')}</span>
      </div>

      {me.isAssignee && (me.canWrite && me.closesAt ? (
        <div className="tdiary-write" data-testid="diary-write">
          <div className="tdiary-write-head">
            <b>{t('taskDiary.todayWhat')}</b>
            <DiaryCountdown closesAt={me.closesAt} onExpire={refresh} />
          </div>
          <textarea
            className="crm-textarea tdiary-text"
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('taskDiary.placeholder')}
            maxLength={2000}
            rows={3}
            data-testid="diary-text"
          />
          <div className="tdiary-write-actions">
            <span className="tdiary-muted">{me.todayText ? t('taskDiary.editHint') : t('taskDiary.writeHint')}</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!value.trim() || unchanged || save.isPending}
              onClick={() => save.mutate(value.trim())}
              data-testid="diary-save"
            >
              <Icon name={me.todayText ? 'edit' : 'send'} size={16} />
              {save.isPending ? t('common.saving') : me.todayText ? t('taskDiary.update') : t('taskDiary.save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="tdiary-closed" data-testid="diary-closed">
          <Icon name="lock_clock" size={18} />
          {me.block === 'not-started'
            ? t(BLOCK_KEY['not-started']).replace('{date}', firstDay)
            : t(BLOCK_KEY[me.block ?? 'day-closed'])}
        </div>
      ))}

      {diary.days.length === 0 ? (
        <div className="tdiary-muted" data-testid="diary-nodays">
          {diary.today < diary.from ? t('taskDiary.startsOn').replace('{date}', firstDay) : t('taskDiary.noDays')}
        </div>
      ) : narrow ? (
        <DayList diary={diary} t={t} />
      ) : (
        <div className="tdiary-grid-wrap">
          <table className="tdiary-grid" data-testid="diary-grid">
            <thead>
              <tr>
                <th className="tdiary-name">{t('task.assignee')}</th>
                {diary.days.map((x) => {
                  const l = dayLabel(x.day, x.weekday, t);
                  return (
                    <th key={x.day} className={x.day === diary.today ? 'is-today' : undefined}>
                      <span className="tdiary-wd">{l.wd}</span>
                      <span className="tdiary-date">{l.date}</span>
                    </th>
                  );
                })}
                <th className="tdiary-sum">{t('taskDiary.total')}</th>
              </tr>
            </thead>
            <tbody>
              {diary.rows.map((r) => {
                const s = tally(r.cells);
                return (
                  <tr key={r.user.id} data-testid={`diary-row-${r.user.id}`}>
                    <th scope="row" className="tdiary-name">
                      {r.user.fullName}
                      <DismissedMark person={r.user} />
                    </th>
                    {diary.days.map((x) => (
                      <td key={x.day} className={x.day === diary.today ? 'is-today' : undefined}>
                        {cellView(r.user.id, x.day, r.cells[x.day])}
                      </td>
                    ))}
                    <td className="tdiary-sum" data-testid="diary-sum">{s.written}/{s.total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!narrow && pickedCell?.state === 'written' && pickedRow && pickedDay && (
        <div className="tdiary-note" data-testid="diary-note">
          <div className="tdiary-note-head">
            <b>{pickedRow.user.fullName}</b>
            <span>· {dayLabel(pickedDay.day, pickedDay.weekday, t).wd} {dayLabel(pickedDay.day, pickedDay.weekday, t).date}</span>
            <button type="button" className="tdiary-note-close" onClick={() => setPicked(null)} aria-label={t('common.close')}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <p className="tdiary-note-text">{pickedCell.text}</p>
          {pickedCell.updatedAt && (
            <span className="tdiary-muted">{t('taskDiary.writtenAt').replace('{time}', tjFormatDateTime(pickedCell.updatedAt))}</span>
          )}
        </div>
      )}

      <div className="tdiary-legend" aria-hidden="true">
        {(['written', 'open', 'missed', 'future'] as const).map((s) => (
          <span key={s} className="tdiary-legend-item">
            <span className={`tdiary-cell is-${s} is-mini`} /> {t(`taskDiary.state.${s}`)}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Телефон: по дням — кто что сделал; дни впереди одной строкой. */
function DayList({ diary, t }: { diary: Diary; t: T }) {
  const past = diary.days.filter((x) => x.day <= diary.today);
  const ahead = diary.days.filter((x) => x.day > diary.today);
  return (
    <div className="tdiary-days" data-testid="diary-days">
      {[...past].reverse().map((x) => {
        const l = dayLabel(x.day, x.weekday, t);
        return (
          <div key={x.day} className="tdiary-day" data-testid={`diary-day-${x.day}`}>
            <div className="tdiary-day-head">
              <b>{l.wd} {l.date}</b>
              {x.day === diary.today && <span className="tdiary-today-chip">{t('taskDiary.todayChip')}</span>}
            </div>
            {diary.rows.map((r) => {
              const c = r.cells[x.day];
              const state = c?.state ?? 'future';
              return (
                <div key={r.user.id} className={`tdiary-day-row is-${state}`} data-state={state}>
                  <span className="tdiary-day-name">{r.user.fullName}</span>
                  {state === 'written'
                    ? <span className="tdiary-day-text">{c?.text}</span>
                    : <span className="tdiary-day-state">{t(`taskDiary.state.${state}`)}</span>}
                </div>
              );
            })}
          </div>
        );
      })}
      {ahead.length > 0 && (
        <div className="tdiary-ahead" data-testid="diary-ahead">
          {t('taskDiary.ahead')
            .replace('{n}', String(ahead.length))
            .replace('{date}', dayLabel(ahead[ahead.length - 1].day, ahead[ahead.length - 1].weekday, t).date)}
        </div>
      )}
    </div>
  );
}
