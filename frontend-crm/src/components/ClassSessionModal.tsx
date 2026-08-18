import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { tjDateTimeInput } from '../lib/tjTime';
import { hasRole } from '../lib/roles';
import { useAuth } from '../store/auth';
import CrmDatePicker from './CrmDatePicker';
import { listUsers } from '../api/users';
import {
  createSession,
  updateSession,
  deleteSession,
  type ClassSession,
  type ClassSessionStatus,
} from '../api/studyGroups';

/**
 * Создание/правка одного занятия. Один модал на оба экрана (карточка группы
 * и календарь) — иначе форма расписания жила бы в двух местах и разъехалась.
 *
 * Даты собираются CrmDatePicker'ом (showTime) в наивную строку
 * `YYYY-MM-DDTHH:mm`. Бэкенд читает её как ДУШАНБИНСКОЕ время; никакой
 * конвертации в UTC на фронте быть не должно — она сдвинет расписание.
 */
export default function ClassSessionModal({
  session,
  groupId,
  groupOptions,
  defaultDate,
  onClose,
  onSaved,
}: {
  /** Существующее занятие — режим правки. */
  session?: ClassSession | null;
  /** Группа задана извне (карточка группы). */
  groupId?: string;
  /** Выбор группы внутри модала (календарь). */
  groupOptions?: Array<{ id: string; name: string }>;
  /** `YYYY-MM-DD` — день, по которому кликнули в календаре. */
  defaultDate?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const canPickTeacher = hasRole(me, 'FOUNDER', 'ADMIN');

  const editing = !!session;
  const [group, setGroup] = useState(session?.groupId || groupId || '');
  const [startsAt, setStartsAt] = useState(() =>
    session ? tjDateTimeInput(session.startsAt) : defaultDate ? `${defaultDate}T10:00` : '',
  );
  const [endsAt, setEndsAt] = useState(() =>
    session ? tjDateTimeInput(session.endsAt) : defaultDate ? `${defaultDate}T11:30` : '',
  );
  const [topic, setTopic] = useState(session?.topic || '');
  const [teacherId, setTeacherId] = useState(session?.teacherId || '');
  const [status, setStatus] = useState<ClassSessionStatus>(session?.status || 'SCHEDULED');

  // Список сотрудников доступен только руководству (GET /users закрыт для
  // менеджеров) — поэтому и запрос делаем только тогда, когда пикер вообще
  // рисуется. Иначе преподаватель-владелец группы ловил бы 403 на пустом месте.
  const users = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
    enabled: canPickTeacher,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: keys.groups.all });
    onSaved?.();
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      if (editing) {
        return updateSession(session!.id, {
          startsAt,
          endsAt,
          topic: topic.trim(),
          status,
          // Пустая строка = снять подменного преподавателя (nullable-связь).
          ...(canPickTeacher ? { teacherId } : {}),
        });
      }
      return createSession(group, {
        startsAt,
        endsAt,
        topic: topic.trim() || undefined,
        ...(canPickTeacher && teacherId ? { teacherId } : {}),
      });
    },
    onSuccess: () => {
      toast(editing ? t('toast.saved') : t('toast.created'), 'success');
      invalidate();
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteSession(session!.id),
    onSuccess: () => {
      toast(t('toast.deleted'), 'success');
      invalidate();
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saveMut.isPending) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saveMut.isPending]);

  const rangeInvalid = useMemo(
    () => !!startsAt && !!endsAt && endsAt <= startsAt,
    [startsAt, endsAt],
  );
  const canSubmit = !!group && !!startsAt && !!endsAt && !rangeInvalid && !saveMut.isPending;

  const onDelete = async () => {
    const ok = await confirm({
      title: t('classes.confirm.delete'),
      message: topic || t('classes.sessions'),
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) deleteMut.mutate();
  };

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !saveMut.isPending && onClose()}
    >
      <motion.div
        className="dialog-card"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520, textAlign: 'left' }}
      >
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>
          {editing ? t('classes.editSession') : t('classes.newSession')}
        </h3>

        <div style={{ display: 'grid', gap: 10 }}>
          {groupOptions && !editing && (
            <Field label={`${t('classes.field.group')} *`}>
              <select className="crm-select" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">{t('classes.selectGroup')}</option>
                {groupOptions.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </Field>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
            <Field label={`${t('classes.field.start')} *`}>
              <CrmDatePicker value={startsAt} onChange={setStartsAt} showTime placeholder={t('classes.field.start')} />
            </Field>
            <Field label={`${t('classes.field.end')} *`}>
              <CrmDatePicker value={endsAt} onChange={setEndsAt} showTime placeholder={t('classes.field.end')} />
            </Field>
          </div>
          {rangeInvalid && (
            <div style={{ color: 'var(--danger)', fontSize: 12 }}>{t('classes.invalidRange')}</div>
          )}
          <Field label={t('classes.field.topic')}>
            <input className="crm-input" value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} />
          </Field>
          {canPickTeacher && (
            <Field label={t('classes.field.teacher')}>
              <select className="crm-select" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
                <option value="">{t('classes.teacherFromGroup')}</option>
                {(users.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </select>
            </Field>
          )}
          {editing && (
            <Field label={t('common.status')}>
              <select
                className="crm-select"
                value={status}
                onChange={(e) => setStatus(e.target.value as ClassSessionStatus)}
              >
                <option value="SCHEDULED">{t('classes.status.SCHEDULED')}</option>
                <option value="DONE">{t('classes.status.DONE')}</option>
                <option value="CANCELLED">{t('classes.status.CANCELLED')}</option>
              </select>
            </Field>
          )}
        </div>

        <div className="dialog-actions" style={{ justifyContent: 'space-between' }}>
          <div>
            {editing && (
              <button className="btn btn-sm btn-danger" onClick={onDelete} disabled={deleteMut.isPending}>
                {t('common.delete')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={onClose} disabled={saveMut.isPending}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => saveMut.mutate()} disabled={!canSubmit}>
              {saveMut.isPending ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        style={{
          fontSize: 11,
          color: 'var(--text-soft)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 4,
          display: 'block',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
