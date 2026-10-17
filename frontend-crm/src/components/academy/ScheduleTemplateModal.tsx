import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../../Icon';
import FormModal from '../FormModal';
import CrmDatePicker from '../CrmDatePicker';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { tjToday } from '../../lib/tjTime';
import { bulkSessions } from '../../api/studyGroups';
import { weekdayKey } from './academyUi';

/**
 * Занятия по шаблону: дни недели, время, «с … по …». Пока поля
 * заполняются, сервер считает, сколько занятий получится (dryRun), —
 * человек видит цифру до нажатия «Создать». Занятия, уже стоящие на это же
 * время, пропускаются, поэтому шаблоном можно и продлевать курс.
 */
export default function ScheduleTemplateModal({
  groupId,
  onClose,
  onDone,
}: {
  groupId: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const [days, setDays] = useState<number[]>([]);
  const [startTime, setStartTime] = useState('14:00');
  const [endTime, setEndTime] = useState('16:00');
  const [from, setFrom] = useState(tjToday());
  const [to, setTo] = useState('');
  const [topic, setTopic] = useState('');

  const timeValid = /^\d{2}:\d{2}$/.test(startTime) && /^\d{2}:\d{2}$/.test(endTime) && endTime > startTime;
  const datesValid = !!from && !!to && to >= from;
  const valid = days.length > 0 && timeValid && datesValid;

  // dryRun с задержкой — не дёргать сервер на каждый символ времени.
  const [debounced, setDebounced] = useState<string>('');
  const payloadKey = JSON.stringify({ days: [...days].sort(), startTime, endTime, from, to });
  useEffect(() => {
    const id = setTimeout(() => setDebounced(payloadKey), 300);
    return () => clearTimeout(id);
  }, [payloadKey]);

  const preview = useQuery({
    queryKey: ['groups', 'bulk-preview', groupId, debounced],
    queryFn: () => bulkSessions(groupId, { weekdays: days, startTime, endTime, from, to, dryRun: true }),
    enabled: valid && debounced === payloadKey,
    retry: false,
  });

  const createMut = useMutation({
    mutationFn: () => bulkSessions(groupId, { weekdays: days, startTime, endTime, from, to, topic: topic.trim() || undefined }),
    onSuccess: (r) => {
      toast(t('academy.template.created').replace('{n}', String(r.created ?? 0)), 'success');
      qc.invalidateQueries({ queryKey: keys.groups.all });
      onDone?.();
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const toggleDay = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  const previewError = (preview.error as any)?.response?.data?.message;

  return (
    <FormModal open title={t('academy.template.title')} onClose={onClose} busy={createMut.isPending} width={560} testId="template-modal">
      <div className="form-group">
        <label>{t('academy.template.days')} *</label>
        <div className="acad-days" role="group">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <button
              key={d}
              type="button"
              className={`acad-day${days.includes(d) ? ' is-on' : ''}`}
              aria-pressed={days.includes(d)}
              onClick={() => toggleDay(d)}
              data-testid={`tpl-day-${d}`}
            >
              {t(`weekday.short.${weekdayKey(d)}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>{t('academy.template.from')} *</label>
          <input type="time" className="crm-input" value={startTime} onChange={(e) => setStartTime(e.target.value)} data-testid="tpl-start" />
        </div>
        <div className="form-group">
          <label>{t('academy.template.to')} *</label>
          <input type="time" className="crm-input" value={endTime} onChange={(e) => setEndTime(e.target.value)} data-testid="tpl-end" />
        </div>
      </div>
      {!timeValid && startTime && endTime && <div className="form-error-text" style={{ marginTop: -10, marginBottom: 12 }}>{t('classes.invalidRange')}</div>}
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>{t('academy.template.dateFrom')} *</label>
          <CrmDatePicker value={from} onChange={setFrom} />
        </div>
        <div className="form-group">
          <label>{t('academy.template.dateTo')} *</label>
          <CrmDatePicker value={to} onChange={setTo} min={from || undefined} />
        </div>
      </div>
      <div className="form-group">
        <label>{t('academy.template.topic')}</label>
        <input className="crm-input" value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} placeholder={t('academy.template.topicPh')} />
      </div>

      <div className={`acad-template-preview${valid && preview.data ? ' is-ready' : ''}`} data-testid="tpl-preview">
        <Icon name="event_repeat" size={20} />
        {!valid ? (
          <span>{t('academy.template.fill')}</span>
        ) : preview.isFetching || debounced !== payloadKey ? (
          <span>{t('academy.template.counting')}</span>
        ) : previewError ? (
          <span className="acad-template-error">{previewError}</span>
        ) : preview.data ? (
          <span>
            {t('academy.template.willCreate')} <b>{preview.data.count ?? 0}</b>
            {preview.data.skipped > 0 && <> · {t('academy.template.skipped').replace('{n}', String(preview.data.skipped))}</>}
          </span>
        ) : null}
      </div>

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={createMut.isPending}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || !preview.data || !preview.data.count || createMut.isPending}
          onClick={() => createMut.mutate()}
          data-testid="tpl-create"
        >
          {createMut.isPending ? t('common.saving') : t('academy.template.create')}
        </button>
      </div>
    </FormModal>
  );
}
