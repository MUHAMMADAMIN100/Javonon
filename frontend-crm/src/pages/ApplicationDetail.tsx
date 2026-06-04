import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { assignApplicationManager, deleteApplication, getApplication, updateApplication } from '../api/applications';
import { getStudent, updateStudent, uploadPhoto } from '../api/students';
import type { Application, ApplicationStatus, Direction, Student, StudentStatus } from '../api/types';
import { APPLICATION_STAGES, DIRECTION_LABEL, STAGE_INDEX, STATUS_BADGE, STATUS_LABEL, STATUS_SHORT, STUDENT_STATUS_LABEL } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import { keys } from '../lib/queryKeys';
import Loading from '../components/Loading';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import DocumentsChecklist, { REQUIRED_DOCUMENTS } from '../components/DocumentsChecklist';
import DirectionOptions from '../components/DirectionOptions';
import ManagerBar from '../components/ManagerBar';
import ApplicationFormSection from '../components/ApplicationFormSection';
import BackButton from '../components/BackButton';
import Icon from '../Icon';
import { motion } from 'framer-motion';
import { compose, email as emailRule, hasErrors, maxLen, minLen, numberRule, required, validateAll } from '../utils/validators';
import { isElevated } from '../lib/roles';

const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');

export default function ApplicationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<any>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const appKey = id ? keys.applications.one(id) : ['applications', 'one', null];
  const appQuery = useQuery<Application>({
    queryKey: appKey,
    queryFn: () => getApplication(id!),
    enabled: !!id,
  });
  const app = appQuery.data ?? null;
  const error = appQuery.error ? (appQuery.error as any).message : null;

  const studentId = app?.studentId;
  const studentKey = studentId ? keys.students.one(studentId) : ['students', 'one', null];
  const studentQuery = useQuery<Student>({
    queryKey: studentKey,
    queryFn: () => getStudent(studentId!),
    enabled: !!studentId,
  });
  const student = studentQuery.data ?? null;

  // Когда student приходит — синхронизируем форму.
  useEffect(() => {
    if (student) {
      setForm({
        fullName: student.fullName,
        phones: student.phones.join(', '),
        email: student.email || '',
        direction: student.direction,
        cabinet: student.cabinet,
        status: student.status,
        comment: student.comment || '',
      });
    }
  }, [student?.id, student?.fullName, student?.email, student?.direction, student?.cabinet, student?.status, student?.comment, student?.phones]);

  const reload = () => {
    qc.invalidateQueries({ queryKey: appKey });
    if (studentId) qc.invalidateQueries({ queryKey: studentKey });
  };

  const formErrors = form
    ? validateAll(
        { fullName: form.fullName, phones: form.phones, email: form.email, cabinet: form.cabinet, comment: form.comment },
        {
          fullName: compose(required('Введите ФИО'), minLen(2), maxLen(100)),
          phones: (v) => {
            const s = String(v ?? '').trim();
            if (!s) return undefined;
            const parts = s.split(',').map((p: string) => p.trim()).filter(Boolean);
            for (const p of parts) {
              const digits = p.replace(/\D/g, '');
              if (digits.length < 7) return `Номер «${p}» слишком короткий (мин. 7 цифр)`;
              if (digits.length > 15) return `Номер «${p}» слишком длинный (макс. 15 цифр)`;
            }
            return undefined;
          },
          email: emailRule(),
          cabinet: numberRule({ min: 1, max: 99, integer: true }),
          comment: maxLen(2000),
        },
      )
    : {};
  const showErr = (k: string) => touched[k] && (formErrors as any)[k];

  useRealtime({
    'application:updated': (data: any) => {
      if (data?.application?.id === id || data?.studentId === studentId) reload();
    },
    'student:updated': (data: any) => {
      if (data?.studentId && data.studentId === studentId) reload();
    },
    'document:uploaded': (data: any) => {
      if (data?.studentId === studentId) reload();
    },
    'document:deleted': (data: any) => {
      if (data?.studentId === studentId) reload();
    },
    'form:updated': (data: any) => {
      if (data?.studentId === studentId) reload();
    },
  });

  // STATUS — оптимистичное переключение этапа.
  const statusMut = useOptimisticMutation<Application, ApplicationStatus, Application>({
    mutationFn: (status) => updateApplication(id!, { status }),
    queryKey: appKey,
    applyOptimistic: (cur, status) => optimistic.patch(cur, { status }),
    invalidateAlso: [keys.applications.all, keys.students.all],
    onSuccess: (_d, status) => {
      if (status === 'IN_PROGRESS') toast('Заявка взята в работу. Создана карточка студента.', 'success');
      if (status === 'COMPLETED') toast('Заявка завершена. Студент доступен в разделе «Студенты».', 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка изменения статуса', 'error'),
  });

  const reassignMut = useOptimisticMutation<Application, { managerId?: string | null; chinaManagerId?: string | null }, Application>({
    mutationFn: (patch) => assignApplicationManager(id!, patch),
    queryKey: appKey,
    applyOptimistic: (cur, patch) => optimistic.patch(cur, patch as Partial<Application>),
    invalidateAlso: [keys.applications.all, keys.students.all],
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const deleteMut = useInvalidatingMutation({
    mutationFn: () => deleteApplication(id!),
    invalidate: [keys.applications.all, keys.students.all],
    onSuccess: () => {
      toast('Заявка удалена', 'success');
      navigate('/applications');
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка удаления', 'error'),
  });

  const updateStudentMut = useOptimisticMutation<Student, Parameters<typeof updateStudent>[1], Student>({
    mutationFn: (patch) => updateStudent(studentId!, patch),
    queryKey: studentKey,
    applyOptimistic: (cur, patch) => optimistic.patch(cur, patch as Partial<Student>),
    invalidateAlso: [keys.students.all, keys.applications.all],
    onSuccess: () => {
      toast('Данные сохранены', 'success');
      setEdit(false);
      setTouched({});
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка сохранения', 'error'),
  });

  const photoMut = useInvalidatingMutation({
    mutationFn: (file: File) => uploadPhoto(studentId!, file),
    invalidate: [studentKey, keys.students.all],
    onSuccess: () => toast('Фото загружено', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка загрузки', 'error'),
  });

  const onStatus = (status: ApplicationStatus) => {
    if (!id) return;
    statusMut.mutate(status);
  };

  const onReassign = async (patch: { managerId?: string | null; chinaManagerId?: string | null }): Promise<void> => {
    if (!id) return;
    await reassignMut.mutateAsync(patch);
  };

  const onDeleteApp = async () => {
    if (!id) return;
    const ok = await confirm({
      title: 'Удалить заявку',
      message: student
        ? 'Заявка будет удалена вместе с карточкой студента и всеми документами.'
        : 'Заявка будет удалена. Действие нельзя отменить.',
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(undefined as any);
  };

  const onSave = () => {
    if (!student || !form) return;
    setTouched({ fullName: true, phones: true, email: true, cabinet: true, comment: true });
    if (hasErrors(formErrors)) {
      toast('Исправьте ошибки в форме', 'error');
      return;
    }
    const phones = form.phones.split(',').map((p: string) => p.trim()).filter(Boolean);
    updateStudentMut.mutate({
      fullName: form.fullName.trim(),
      phones,
      email: form.email?.trim() || undefined,
      direction: form.direction,
      cabinet: parseInt(form.cabinet, 10),
      status: form.status,
      comment: form.comment?.trim() || undefined,
    });
  };

  const onPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !student) return;
    photoMut.mutate(file);
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!app) return <Loading />;

  const isNew = app.status === 'NEW';
  const isEnrolled = app.status === 'ENROLLED';
  const isAdmin = isElevated(me);
  const assigned = !!app.managerId || !!app.chinaManagerId;
  const isMine = !assigned || app.managerId === me?.id || app.chinaManagerId === me?.id;
  const canAct = isAdmin || isMine;
  const currentIdx = STAGE_INDEX[app.status] ?? 0;
  // Админ и назначенный менеджер (TJ/CN) могут редактировать заявку на любом этапе
  // — как данные студента, так и анкету.
  const canEdit = !!student && canAct;
  const uploadedTypes = new Set((student?.documents || []).map((d) => d.type).filter((t) => t && t !== 'OTHER'));
  const missingDocs = REQUIRED_DOCUMENTS.filter((r) => !uploadedTypes.has(r.type));
  const nextStage = APPLICATION_STAGES[currentIdx + 1];
  const prevStage = currentIdx > 0 ? APPLICATION_STAGES[currentIdx - 1] : null;

  const handleNext = async () => {
    if (!nextStage) return;
    // Гейт на "Подача документов" — нужны все 10 файлов
    if (nextStage === 'DOCS_SUBMITTED' && missingDocs.length > 0) {
      toast(`Загрузите все документы (не хватает: ${missingDocs.length})`, 'error');
      return;
    }
    await onStatus(nextStage);
  };

  return (
    <div>
      <BackButton fallback="/applications" />
      <div className="card">
      <div className="card-header">
        <h2 className="card-title">{app.fullName}</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {canEdit && !edit && (
            <button className="btn btn-sm btn-secondary" onClick={() => setEdit(true)}>
              Редактировать
            </button>
          )}
          {canEdit && edit && (
            <>
              <button className="btn btn-sm btn-secondary" onClick={() => { setEdit(false); reload(); }}>Отмена</button>
              <button className="btn btn-sm btn-primary" onClick={onSave}>Сохранить</button>
            </>
          )}
          {canAct && (
            <button className="btn btn-sm btn-danger" onClick={onDeleteApp}>Удалить</button>
          )}
        </div>
      </div>

      {/* Пошаговая воронка статусов — скрываем когда заявка зачислена */}
      {!isEnrolled && (
        <div className="stage-bar">
          <div className="stage-bar-track">
            {APPLICATION_STAGES.map((stage, i) => {
              const done = i < currentIdx;
              const current = i === currentIdx;
              return (
                <div
                  key={stage}
                  className={`stage-step${done ? ' done' : ''}${current ? ' current' : ''}`}
                >
                  <div className="stage-dot">
                    {done ? <Icon name="check" size={16} /> : <span>{i + 1}</span>}
                  </div>
                  <div className="stage-label">{STATUS_SHORT[stage]}</div>
                  {i < APPLICATION_STAGES.length - 1 && <div className="stage-connector" />}
                </div>
              );
            })}
          </div>
          {canAct && (
            <div className="stage-actions">
              {prevStage && (
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => onStatus(prevStage)}
                  title="Вернуться на предыдущий этап"
                >
                  <Icon name="arrow_back" size={16} style={{ marginRight: 4 }} />
                  Назад
                </button>
              )}
              {nextStage && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleNext}
                  title={
                    nextStage === 'DOCS_SUBMITTED' && missingDocs.length > 0
                      ? `Сначала загрузите все документы (не хватает: ${missingDocs.length})`
                      : `Перейти: ${STATUS_LABEL[nextStage]}`
                  }
                >
                  {STATUS_LABEL[nextStage]}
                  <Icon name="arrow_forward" size={16} style={{ marginLeft: 4 }} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {isEnrolled && canAct && prevStage && (
        <div className="stage-bar" style={{ paddingTop: 12, paddingBottom: 12 }}>
          <div className="stage-actions" style={{ marginLeft: 'auto' }}>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => onStatus(prevStage)}
              title="Вернуться на предыдущий этап"
            >
              <Icon name="arrow_back" size={16} style={{ marginRight: 4 }} />
              Назад
            </button>
          </div>
        </div>
      )}

      <div className="card-body">
        {!isNew && (
          <ManagerBar
            manager={app.manager}
            chinaManager={app.chinaManager}
            onReassign={onReassign}
          />
        )}

        {isNew && (
          <>
            <div className="detail-row"><div className="detail-label">Телефон</div><div className="detail-value">{app.phone}</div></div>
            <div className="detail-row"><div className="detail-label">Email</div><div className="detail-value">{app.email || '—'}</div></div>
            <div className="detail-row"><div className="detail-label">Направление</div><div className="detail-value">{DIRECTION_LABEL[app.direction]}</div></div>
            <div className="detail-row"><div className="detail-label">Комментарий</div><div className="detail-value">{app.comment || '—'}</div></div>
            <div className="detail-row"><div className="detail-label">Создана</div><div className="detail-value">{new Date(app.createdAt).toLocaleString('ru-RU')}</div></div>
          </>
        )}

        {!isNew && student && form && (
          <>
            <div className="detail-grid">
              <div>
                <div className={`detail-photo${isEnrolled ? ' is-enrolled' : ''}`}>
                  {student.photoUrl
                    ? <img src={`${API_BASE}${student.photoUrl}`} alt="" />
                    : <Icon name="person" size={80} style={{ color: 'var(--text-light)' }} />}
                </div>
                {isEnrolled && (
                  <motion.div
                    className="enrolled-photo-badge"
                    initial={{ opacity: 0, scale: 0.9, y: 6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 250, damping: 18 }}
                    style={{ color: '#16a34a' }}
                  >
                    <Icon name="verified" size={16} style={{ color: '#16a34a' }} />
                    <span style={{ color: '#16a34a' }}>Зачислен</span>
                  </motion.div>
                )}
                {canEdit && (
                  <>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ width: '100%', marginTop: 8 }}
                      onClick={() => photoRef.current?.click()}
                    >
                      <Icon name="photo_camera" size={18} style={{ marginRight: 6 }} />
                      Загрузить фото
                    </button>
                    <input ref={photoRef} type="file" accept="image/*" hidden onChange={onPhoto} />
                  </>
                )}
              </div>

              <div>
                {!edit ? (
                  <>
                    <div className="detail-row"><div className="detail-label">ФИО</div><div className="detail-value">{student.fullName}</div></div>
                    <div className="detail-row"><div className="detail-label">Телефоны</div><div className="detail-value">{student.phones.join(', ') || '—'}</div></div>
                    <div className="detail-row"><div className="detail-label">Email</div><div className="detail-value">{student.email || '—'}</div></div>
                    <div className="detail-row"><div className="detail-label">Направление</div><div className="detail-value">{DIRECTION_LABEL[student.direction]}</div></div>
                    <div className="detail-row"><div className="detail-label">Кабинет</div><div className="detail-value">№{student.cabinet}</div></div>
                    <div className="detail-row"><div className="detail-label">Статус студента</div><div className="detail-value">{STUDENT_STATUS_LABEL[student.status]}</div></div>
                    <div className="detail-row"><div className="detail-label">Комментарий</div><div className="detail-value" style={{ whiteSpace: 'pre-wrap' }}>{student.comment || '—'}</div></div>
                    <div className="detail-row"><div className="detail-label">Создана заявка</div><div className="detail-value">{new Date(app.createdAt).toLocaleString('ru-RU')}</div></div>
                  </>
                ) : (
                  <>
                    <div className="form-group">
                      <label>ФИО *</label>
                      <input
                        value={form.fullName}
                        onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                        onBlur={() => setTouched((t) => ({ ...t, fullName: true }))}
                        className={showErr('fullName') ? 'input-error' : ''}
                        maxLength={100}
                      />
                      {showErr('fullName') && <div className="form-error-text">{(formErrors as any).fullName}</div>}
                    </div>
                    <div className="form-group">
                      <label>Телефоны (через запятую)</label>
                      <input
                        value={form.phones}
                        onChange={(e) => setForm({ ...form, phones: e.target.value.replace(/[^\d ,+\-()]/g, '') })}
                        onBlur={() => setTouched((t) => ({ ...t, phones: true }))}
                        className={showErr('phones') ? 'input-error' : ''}
                        placeholder="+992123456789, +992111222333"
                      />
                      {showErr('phones') && <div className="form-error-text">{(formErrors as any).phones}</div>}
                    </div>
                    <div className="form-group">
                      <label>Email</label>
                      <input
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                        onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                        className={showErr('email') ? 'input-error' : ''}
                      />
                      {showErr('email') && <div className="form-error-text">{(formErrors as any).email}</div>}
                    </div>
                    <div className="form-grid-2">
                      <div className="form-group">
                        <label>Направление</label>
                        <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as Direction })}>
                          <DirectionOptions />
                        </select>
                      </div>
                      <div className="form-group">
                        <label>Кабинет</label>
                        <input
                          type="number"
                          min={1}
                          max={99}
                          value={form.cabinet}
                          onChange={(e) => setForm({ ...form, cabinet: e.target.value.replace(/[^\d]/g, '') })}
                          onBlur={() => setTouched((t) => ({ ...t, cabinet: true }))}
                          className={showErr('cabinet') ? 'input-error' : ''}
                        />
                        {showErr('cabinet') && <div className="form-error-text">{(formErrors as any).cabinet}</div>}
                      </div>
                    </div>
                    <div className="form-group">
                      <label>Статус студента</label>
                      <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as StudentStatus })}>
                        <option value="ACTIVE">Активный</option>
                        <option value="PAUSED">Приостановлен</option>
                        <option value="GRADUATED">Выпустился</option>
                        <option value="ARCHIVED">В архиве</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Комментарий</label>
                      <textarea
                        value={form.comment}
                        onChange={(e) => setForm({ ...form, comment: e.target.value })}
                        onBlur={() => setTouched((t) => ({ ...t, comment: true }))}
                        maxLength={2000}
                        className={showErr('comment') ? 'input-error' : ''}
                      />
                      {showErr('comment') && <div className="form-error-text">{(formErrors as any).comment}</div>}
                    </div>
                  </>
                )}
              </div>
            </div>

            <DocumentsChecklist
              studentId={student.id}
              studentName={student.fullName}
              documents={student.documents || []}
              applicationForm={student.applicationForm}
              onChange={reload}
              editable={!!canEdit}
            />

            <div style={{ marginTop: 28 }}>
              <ApplicationFormSection
                studentId={student.id}
                initialForm={student.applicationForm}
                canEdit={!!canEdit}
                onSaved={reload}
              />
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
