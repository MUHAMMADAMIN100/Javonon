import { useMemo, useRef, useState } from 'react';
import CrmSelect from './CrmSelect';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import FormModal from './FormModal';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { tjDateInput, tjDateTimeInput } from '../lib/tjTime';
import { isAcademyManager } from '../lib/permissions';
import { absFileUrl, useFileToken } from '../lib/fileUrl';
import { useAuth } from '../store/auth';
import CrmDatePicker from './CrmDatePicker';
import { listUsers } from '../api/users';
import {
  createSession,
  updateSession,
  deleteSession,
  type ClassMaterial,
  type ClassSession,
  type ClassSessionStatus,
} from '../api/studyGroups';
import { addMaterialLink, deleteMaterial, uploadMaterials } from '../api/academy';
import { fileSize, materialIcon } from './academy/academyUi';

/**
 * Занятие: время, тема, ДЗ со сроком, файлы и ссылки, замена учителя,
 * статус. Одно окно на карточку группы и календарь — иначе форма урока
 * жила бы в двух местах и разъехалась.
 *
 * Кто что меняет (как на сервере): время, статус и замену — учитель группы
 * и руководство; тему, ДЗ и материалы своего урока — ещё и подменный
 * учитель. Файлы и ссылки сохраняются сразу при добавлении (отдельные
 * запросы), остальное — кнопкой «Сохранить».
 *
 * Даты собираются CrmDatePicker'ом (showTime) в наивную строку
 * `YYYY-MM-DDTHH:mm`. Бэкенд читает её как ДУШАНБИНСКОЕ время; никакой
 * конвертации в UTC на фронте быть не должно — она сдвинет расписание.
 */
export default function ClassSessionModal({
  session,
  groupId,
  groupTeacherId,
  groupOptions,
  defaultDate,
  onClose,
  onSaved,
}: {
  /** Существующее занятие — режим правки. */
  session?: ClassSession | null;
  /** Группа задана извне (карточка группы). */
  groupId?: string;
  /** Учитель группы — чтобы понять, ведёт ли её текущий пользователь. */
  groupTeacherId?: string | null;
  /** Выбор группы внутри окна (календарь). */
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
  useFileToken();
  const manager = isAcademyManager(me as any);
  const teacherOfGroup = (session?.group?.teacherId ?? groupTeacherId ?? null) === me?.id;
  // Время, статус и удаление — учитель группы и руководство.
  const canRun = manager || teacherOfGroup;
  const canPickTeacher = manager;

  const editing = !!session;
  const [group, setGroup] = useState(session?.groupId || groupId || '');
  const [startsAt, setStartsAt] = useState(() =>
    session ? tjDateTimeInput(session.startsAt) : defaultDate ? `${defaultDate}T10:00` : '',
  );
  const [endsAt, setEndsAt] = useState(() =>
    session ? tjDateTimeInput(session.endsAt) : defaultDate ? `${defaultDate}T11:30` : '',
  );
  const [topic, setTopic] = useState(session?.topic || '');
  const [homework, setHomework] = useState(session?.homework || '');
  const [homeworkDue, setHomeworkDue] = useState(session?.homeworkDue ? tjDateInput(session.homeworkDue) : '');
  const [teacherId, setTeacherId] = useState(session?.teacherId || '');
  const [status, setStatus] = useState<ClassSessionStatus>(session?.status || 'SCHEDULED');
  const [materials, setMaterials] = useState<ClassMaterial[]>(session?.materials ?? []);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Список сотрудников доступен только руководству (GET /users закрыт для
  // остальных) — поэтому и запрос делаем только тогда, когда пикер вообще
  // рисуется. Иначе учитель ловил бы 403 на пустом месте.
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
      const lessonFields = {
        topic: topic.trim(),
        homework: homework.trim(),
        homeworkDue: homeworkDue || '',
      };
      if (editing) {
        return updateSession(session!.id, {
          ...lessonFields,
          ...(canRun ? { startsAt, endsAt, status } : {}),
          // Пустая строка = снять подменного учителя (nullable-связь).
          ...(canPickTeacher ? { teacherId } : {}),
        });
      }
      const created = await createSession(group, {
        startsAt,
        endsAt,
        topic: topic.trim() || undefined,
        ...(canPickTeacher && teacherId ? { teacherId } : {}),
      });
      if (homework.trim() || homeworkDue) {
        await updateSession(created.id, { homework: homework.trim(), homeworkDue: homeworkDue || '' });
      }
      return created;
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

  const uploadMut = useMutation({
    mutationFn: (files: File[]) => uploadMaterials(session!.id, files),
    onSuccess: (rows) => {
      setMaterials((prev) => [...prev, ...rows]);
      toast(t('academy.materials.uploaded'), 'success');
      invalidate();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const linkMut = useMutation({
    mutationFn: () => addMaterialLink(session!.id, linkUrl.trim(), linkTitle.trim() || undefined),
    onSuccess: (row) => {
      setMaterials((prev) => [...prev, row]);
      setLinkUrl('');
      setLinkTitle('');
      invalidate();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const removeMaterialMut = useMutation({
    mutationFn: (id: string) => deleteMaterial(id),
    onSuccess: (_r, id) => {
      setMaterials((prev) => prev.filter((m) => m.id !== id));
      invalidate();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const rangeInvalid = useMemo(
    () => !!startsAt && !!endsAt && endsAt <= startsAt,
    [startsAt, endsAt],
  );
  const canSubmit = !!group && !!startsAt && !!endsAt && !rangeInvalid && !saveMut.isPending;
  const marked = (session?._count?.journal ?? 0) > 0;

  const onDelete = async () => {
    const ok = await confirm({
      title: t('classes.confirm.delete'),
      message: topic || t('classes.sessions'),
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) deleteMut.mutate();
  };

  const onRemoveMaterial = async (m: ClassMaterial) => {
    const ok = await confirm({
      title: t('academy.materials.confirmDelete'),
      message: m.title,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) removeMaterialMut.mutate(m.id);
  };

  return (
    <FormModal
      open
      title={editing ? t('classes.editSession') : t('classes.newSession')}
      onClose={onClose}
      busy={saveMut.isPending}
      width={620}
      testId="session-modal"
    >
      {groupOptions && !editing && (
        <div className="form-group">
          <label>{t('classes.field.group')} *</label>
          <CrmSelect className="crm-select" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">{t('classes.selectGroup')}</option>
            {groupOptions.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </CrmSelect>
        </div>
      )}
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>{t('classes.field.start')} *</label>
          <CrmDatePicker value={startsAt} onChange={setStartsAt} showTime disabled={editing && !canRun} placeholder={t('classes.field.start')} />
        </div>
        <div className="form-group">
          <label>{t('classes.field.end')} *</label>
          <CrmDatePicker value={endsAt} onChange={setEndsAt} showTime disabled={editing && !canRun} placeholder={t('classes.field.end')} />
        </div>
      </div>
      {rangeInvalid && <div className="form-error-text" style={{ marginTop: -10, marginBottom: 12 }}>{t('classes.invalidRange')}</div>}

      <div className="form-group">
        <label>{t('classes.field.topic')}</label>
        <input
          className="crm-input"
          value={topic}
          maxLength={200}
          placeholder={t('academy.lessons.topicPh')}
          onChange={(e) => setTopic(e.target.value)}
          data-testid="session-topic"
        />
      </div>
      <div className="form-group">
        <label>{t('academy.lessons.homework')}</label>
        <textarea
          className="crm-textarea"
          rows={4}
          maxLength={4000}
          value={homework}
          placeholder={t('academy.lessons.homeworkPh')}
          onChange={(e) => setHomework(e.target.value)}
          data-testid="session-homework"
        />
        <div className="acad-hint" style={{ marginTop: 6 }}>{t('academy.lessons.releaseHint')}</div>
      </div>
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>{t('academy.lessons.due')}</label>
          <CrmDatePicker value={homeworkDue} onChange={setHomeworkDue} placeholder={t('academy.lessons.dueNone')} />
        </div>
        {editing && canRun && (
          <div className="form-group">
            <label>{t('common.status')}</label>
            <CrmSelect
              className="crm-select"
              value={status}
              onChange={(e) => setStatus(e.target.value as ClassSessionStatus)}
              data-testid="session-status"
            >
              <option value="SCHEDULED">{t('classes.status.SCHEDULED')}</option>
              <option value="DONE">{t('classes.status.DONE')}</option>
              <option value="CANCELLED">{t('classes.status.CANCELLED')}</option>
            </CrmSelect>
          </div>
        )}
      </div>
      {canPickTeacher && (
        <div className="form-group">
          <label>{t('classes.field.teacher')}</label>
          <CrmSelect className="crm-select" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            <option value="">{t('classes.teacherFromGroup')}</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>{u.fullName}</option>
            ))}
          </CrmSelect>
        </div>
      )}

      <div className="form-group acad-materials-block">
        <label>{t('academy.materials.title')}</label>
        {!editing ? (
          <div className="acad-hint">{t('academy.materials.afterSave')}</div>
        ) : (
          <>
            {materials.length > 0 && (
              <div className="acad-materials" data-testid="session-materials">
                {materials.map((m) => (
                  <div key={m.id} className="acad-material">
                    <Icon name={materialIcon(m.kind, m.mimeType, m.title)} size={18} />
                    <a
                      href={m.kind === 'LINK' ? m.url : absFileUrl(m.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="acad-material-title"
                    >
                      {m.title}
                    </a>
                    {m.kind === 'FILE' && m.size ? <span className="acad-material-size">{fileSize(m.size)}</span> : null}
                    <button
                      type="button"
                      className="acad-icon-btn"
                      aria-label={t('common.delete')}
                      onClick={() => onRemoveMaterial(m)}
                      disabled={removeMaterialMut.isPending}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="acad-material-add">
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                data-testid="session-files"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = '';
                  if (files.length) uploadMut.mutate(files);
                }}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fileRef.current?.click()}
                disabled={uploadMut.isPending}
              >
                <Icon name="attach_file" size={16} />
                {uploadMut.isPending ? t('academy.materials.uploading') : t('academy.materials.addFile')}
              </button>
            </div>
            <div className="acad-link-add">
              <input
                className="crm-input"
                placeholder={t('academy.materials.linkPh')}
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                data-testid="session-link-url"
              />
              <input
                className="crm-input"
                placeholder={t('academy.materials.linkTitlePh')}
                value={linkTitle}
                maxLength={200}
                onChange={(e) => setLinkTitle(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!linkUrl.trim() || linkMut.isPending}
                onClick={() => linkMut.mutate()}
                data-testid="session-link-add"
              >
                <Icon name="add_link" size={16} /> {t('academy.materials.addLink')}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="form-actions acad-session-actions">
        {editing && canRun && (
          <button
            type="button"
            className="btn btn-danger acad-session-delete"
            onClick={onDelete}
            disabled={deleteMut.isPending || marked}
            title={marked ? t('academy.lessons.cantDelete') : undefined}
            data-testid="session-delete"
          >
            <Icon name="delete" size={16} /> {t('common.delete')}
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saveMut.isPending}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => saveMut.mutate()}
          disabled={!canSubmit}
          data-testid="session-save"
        >
          {saveMut.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
      {editing && canRun && marked && <div className="acad-hint" style={{ textAlign: 'right' }}>{t('academy.lessons.cantDelete')}</div>}
    </FormModal>
  );
}
