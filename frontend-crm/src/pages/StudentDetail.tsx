import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { assignStudentManager, deleteStudent, ensureStudentApplication, getStudent, regenerateStudentPassword, updateStudent, uploadPhoto } from '../api/students';
import { motion, AnimatePresence } from 'framer-motion';
import type { Direction, Student, StudentStatus } from '../api/types';
import { DIRECTION_LABEL, STUDENT_STATUS_LABEL } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import DocumentsChecklist from '../components/DocumentsChecklist';
import InteractionsLog from '../components/InteractionsLog';
import StudentPaymentsSection from '../components/StudentPaymentsSection';
import ManagerBar from '../components/ManagerBar';
import ApplicationFormSection from '../components/ApplicationFormSection';
import ApplicationStatusStepper from '../components/ApplicationStatusStepper';
import DirectionOptions from '../components/DirectionOptions';
import BackButton from '../components/BackButton';
import Icon from '../Icon';
import { compose, email as emailRule, hasErrors, maxLen, minLen, numberRule, required, validateAll } from '../utils/validators';

function CredRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <div className="creds-row">
      <span className="creds-label">{label}:</span>
      <code className="creds-value">{value}</code>
      <button
        type="button"
        onClick={onCopy}
        className="creds-copy-btn"
        title={copied ? 'Скопировано' : 'Скопировать'}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={15} />
      </button>
    </div>
  );
}

const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');

export default function StudentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const [student, setStudent] = useState<Student | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<any>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

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

  const reload = async () => {
    if (!id) return;
    const s = await getStudent(id);
    setStudent(s);
    setForm({
      fullName: s.fullName,
      phones: s.phones.join(', '),
      email: s.email || '',
      direction: s.direction,
      cabinet: s.cabinet,
      status: s.status,
      comment: s.comment || '',
    });
  };

  useEffect(() => { reload(); }, [id]);

  useRealtime({
    'student:updated': (data: any) => { if (data?.studentId === id) reload(); },
    'document:uploaded': (data: any) => { if (data?.studentId === id) reload(); },
    'document:deleted': (data: any) => { if (data?.studentId === id) reload(); },
    'form:updated': (data: any) => { if (data?.studentId === id) reload(); },
    'application:updated': (data: any) => {
      if (data?.application?.studentId === id) reload();
    },
  });

  const onSave = async () => {
    if (!id || !form) return;
    setTouched({ fullName: true, phones: true, email: true, cabinet: true, comment: true });
    if (hasErrors(formErrors)) {
      toast('Исправьте ошибки в форме', 'error');
      return;
    }
    const phones = form.phones.split(',').map((p: string) => p.trim()).filter(Boolean);
    try {
      await updateStudent(id, {
        fullName: form.fullName.trim(),
        phones,
        email: form.email?.trim() || undefined,
        direction: form.direction,
        cabinet: parseInt(form.cabinet, 10),
        status: form.status,
        comment: form.comment?.trim() || undefined,
      });
      toast('Данные сохранены', 'success');
      await reload();
      setEdit(false);
      setTouched({});
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка сохранения', 'error');
    }
  };

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !id) return;
    try {
      await uploadPhoto(id, file);
      toast('Фото загружено', 'success');
      await reload();
    } catch (err: any) {
      toast(err?.response?.data?.message || 'Ошибка загрузки', 'error');
    }
  };

  const onReassign = async (patch: { managerId?: string | null; chinaManagerId?: string | null }) => {
    if (!id) return;
    await assignStudentManager(id, patch);
    await reload();
  };

  const onRegenerate = async () => {
    if (!id) return;
    const ok = await confirm({
      title: 'Сбросить пароль студента',
      message: 'Старый пароль станет недействительным. Новый покажется один раз — передайте его студенту.',
      confirmText: 'Сбросить',
      danger: true,
    });
    if (!ok) return;
    setRegenerating(true);
    try {
      const cr = await regenerateStudentPassword(id);
      setCredentials(cr);
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setRegenerating(false);
    }
  };

  const copyCreds = async () => {
    if (!credentials) return;
    const text = `Логин: ${credentials.email}\nПароль: ${credentials.password}\nВход: https://javonon.vercel.app/login`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Скопировано', 'success');
    } catch {
      toast('Не удалось скопировать', 'error');
    }
  };

  const onDeleteStudent = async () => {
    if (!id) return;
    const ok = await confirm({
      title: 'Удалить студента',
      message: 'Все документы будут удалены. Действие нельзя отменить.',
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteStudent(id);
      toast('Студент удалён', 'success');
      navigate('/students');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка удаления', 'error');
    }
  };

  if (!student || !form) return <div className="empty">Загрузка...</div>;

  const isAdmin = me?.role === 'ADMIN';
  const assigned = !!student.managerId || !!student.chinaManagerId;
  const isMine = !assigned || student.managerId === me?.id || student.chinaManagerId === me?.id;
  const canEdit = isAdmin || isMine;

  const isEnrolled = student.applications?.[0]?.status === 'ENROLLED';

  return (
    <div>
      <BackButton fallback="/students" />
      <div className="card">
      <div className="card-header">
        <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {student.fullName}
          {isEnrolled && (
            <span className="enrolled-badge" title="Студент зачислен">
              <Icon name="verified" size={16} />
              Зачислен
            </span>
          )}
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {canEdit && !edit && <button className="btn btn-secondary btn-sm" onClick={() => setEdit(true)}>Редактировать</button>}
          {canEdit && edit && <>
            <button className="btn btn-secondary btn-sm" onClick={() => { setEdit(false); reload(); }}>Отмена</button>
            <button className="btn btn-primary btn-sm" onClick={onSave}>Сохранить</button>
          </>}
          {canEdit && <button className="btn btn-danger btn-sm" onClick={onDeleteStudent}>Удалить</button>}
        </div>
      </div>
      <div className="card-body">
        <ManagerBar
          manager={student.manager}
          chinaManager={student.chinaManager}
          onReassign={onReassign}
        />

        {student.applications && student.applications.length > 0 ? (
          !isEnrolled && (
            <ApplicationStatusStepper
              application={student.applications[0]}
              canEdit={canEdit}
              onChanged={reload}
            />
          )
        ) : (
          canEdit && (
            <div className="app-stepper" style={{ textAlign: 'center' }}>
              <div className="app-stepper-title" style={{ marginBottom: 6 }}>
                Этап поступления
              </div>
              <div style={{ color: 'var(--text-soft)', fontSize: 13, marginBottom: 12 }}>
                У этого студента пока нет связанной заявки. Создайте её, чтобы отслеживать этапы поступления.
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  try {
                    await ensureStudentApplication(student.id);
                    toast('Заявка создана', 'success');
                    reload();
                  } catch (e: any) {
                    toast(e?.response?.data?.message || 'Ошибка', 'error');
                  }
                }}
              >
                <Icon name="add" size={16} style={{ marginRight: 4 }} />
                Создать заявку
              </button>
            </div>
          )
        )}

        {isAdmin && (
          <div className="access-bar">
            <div className="access-bar-info">
              <Icon name="lock_person" size={22} />
              <div>
                <div className="access-bar-title">Доступ в личный кабинет студента</div>
                <div className="access-bar-email">
                  {student.email ? <>Логин: <b>{student.email}</b></> : 'Email не указан'}
                </div>
              </div>
            </div>
            {student.email && (
              <motion.button
                className="btn btn-sm btn-secondary"
                onClick={onRegenerate}
                disabled={regenerating}
                whileTap={{ scale: 0.95 }}
              >
                <Icon name="refresh" size={16} style={{ marginRight: 4 }} />
                {regenerating ? 'Сброс...' : 'Сбросить пароль'}
              </motion.button>
            )}
          </div>
        )}

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
                <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => photoRef.current?.click()}>
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
                <div className="detail-row"><div className="detail-label">Статус</div><div className="detail-value">{STUDENT_STATUS_LABEL[student.status]}</div></div>
                <div className="detail-row"><div className="detail-label">Комментарий</div><div className="detail-value" style={{ whiteSpace: 'pre-wrap' }}>{student.comment || '—'}</div></div>
                <div className="detail-row"><div className="detail-label">Создан</div><div className="detail-value">{new Date(student.createdAt).toLocaleString('ru-RU')}</div></div>
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
                  <label>Статус</label>
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
          editable={canEdit}
        />

        <div style={{ marginTop: 28 }}>
          <StudentPaymentsSection studentId={student.id} />
        </div>

        <div style={{ marginTop: 28 }}>
          <InteractionsLog studentId={student.id} canEdit={canEdit} />
        </div>

        <div style={{ marginTop: 28 }}>
          <ApplicationFormSection
            studentId={student.id}
            initialForm={student.applicationForm}
            canEdit={canEdit}
            onSaved={reload}
          />
        </div>
      </div>

      <AnimatePresence>
        {credentials && (
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setCredentials(null)}
          >
            <motion.div
              className="dialog-card"
              style={{ maxWidth: 480 }}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-icon" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
                <Icon name="key" size={28} />
              </div>
              <div className="dialog-title">Новый пароль</div>
              <div className="dialog-message">
                Передайте студенту — пароль показывается один раз.
              </div>
              <div className="creds-box">
                <CredRow label="Логин" value={credentials.email} />
                <CredRow label="Пароль" value={credentials.password} />
              </div>
              <div className="dialog-actions">
                <button className="btn btn-secondary" onClick={copyCreds}>
                  <Icon name="content_copy" size={16} style={{ marginRight: 4 }} />
                  Копировать
                </button>
                <button className="btn btn-primary" onClick={() => setCredentials(null)}>Готово</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
