import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { assignStudentManager, deleteStudent, ensureStudentApplication, getStudent, regenerateStudentPassword, updateStudent, uploadPhoto } from '../api/students';
import { motion, AnimatePresence } from 'framer-motion';
import type { Direction, Student, StudentStatus } from '../api/types';
import { DIRECTION_LABEL, ONBOARDING_STAGE_LABEL, STUDENT_STATUS_LABEL, isFinishedApplicationStatus } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import { keys } from '../lib/queryKeys';
import Loading from '../components/Loading';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import DocumentsChecklist from '../components/DocumentsChecklist';
import InteractionsLog from '../components/InteractionsLog';
import StudentPaymentsSection from '../components/StudentPaymentsSection';
import ManagerBar from '../components/ManagerBar';
import PartnerAttributionCard from '../components/PartnerAttributionCard';
import ApplicationFormSection from '../components/ApplicationFormSection';
import ApplicationStatusSelect from '../components/ApplicationStatusSelect';
import DirectionOptions from '../components/DirectionOptions';
import BackButton from '../components/BackButton';
import CrmDatePicker from '../components/CrmDatePicker';
import Icon from '../Icon';
import { compose, email as emailRule, hasErrors, maxLen, minLen, numberRule, required, validateAll } from '../utils/validators';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useDirectionLabel, useStudentStatusLabel, useApplicationStatusLabel, useOnboardingLabel, useChannelLabel, useCountryLabel } from '../lib/labels';
import { tjDateInput, tjFormatDate } from '../lib/tjTime';

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
  const qc = useQueryClient();
  const { t } = useT();
  const directionLabel = useDirectionLabel();
  const statusLabel = useStudentStatusLabel();
  // Метка «успешного» исхода заявки. Раньше сюда передавали 'ENROLLED' в
  // useStudentStatusLabel — ключа student.status.ENROLLED нет ни в одном
  // словаре, и на плашке зачисления рендерился сырой enum.
  const appStatusLabel = useApplicationStatusLabel();
  const onboardingLabel = useOnboardingLabel();
  const channelLabel = useChannelLabel();
  const countryLabel = useCountryLabel();
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<any>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const studentKey = id ? keys.students.one(id) : ['students', 'one', null];
  const studentQuery = useQuery<Student>({
    queryKey: studentKey,
    queryFn: () => getStudent(id!),
    enabled: !!id,
  });
  const student = studentQuery.data ?? null;

  // Когда придёт student с сервера — синхронизируем форму редактирования.
  useEffect(() => {
    if (student) {
      setForm({
        fullName: student.fullName,
        phones: student.phones.join(', '),
        phoneLabels: (student.phoneLabels || []).join(', '),
        preferredChannel: student.preferredChannel || '',
        // tjDateInput, а не slice(0, 10): дата рождения хранится как
        // душанбинская полночь (12.03 → «2006-03-11T19:00:00.000Z»), срез
        // строки подставил бы в пикер 11-е и сохранил бы сдвиг в БД.
        birthday: tjDateInput(student.birthday),
        email: student.email || '',
        direction: student.direction,
        cabinet: student.cabinet,
        status: student.status,
        onboardingStage: student.onboardingStage || 'WELCOME',
        comment: student.comment || '',
      });
    }
  }, [student?.id, student?.fullName, student?.email, student?.direction, student?.cabinet, student?.status, student?.comment, student?.phones]);

  const reload = () => qc.invalidateQueries({ queryKey: studentKey });

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
    'student:updated': (data: any) => { if (data?.studentId === id) reload(); },
    'document:uploaded': (data: any) => { if (data?.studentId === id) reload(); },
    'document:deleted': (data: any) => { if (data?.studentId === id) reload(); },
    'form:updated': (data: any) => { if (data?.studentId === id) reload(); },
    'application:updated': (data: any) => {
      if (data?.application?.studentId === id) reload();
    },
  });

  // UPDATE — оптимистично патчим student в кеше.
  const updateMut = useOptimisticMutation<Student, Parameters<typeof updateStudent>[1], Student>({
    mutationFn: (patch) => updateStudent(id!, patch),
    queryKey: studentKey,
    applyOptimistic: (cur, patch) => optimistic.patch(cur, patch as Partial<Student>),
    invalidateAlso: [keys.students.all],
    onSuccess: () => {
      toast(t('toast.updated'), 'success');
      setEdit(false);
      setTouched({});
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const photoMut = useInvalidatingMutation({
    mutationFn: (file: File) => uploadPhoto(id!, file),
    invalidate: [studentKey, keys.students.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const reassignMut = useOptimisticMutation<Student, { managerId?: string | null; chinaManagerId?: string | null }, Student>({
    mutationFn: (patch) => assignStudentManager(id!, patch),
    queryKey: studentKey,
    applyOptimistic: (cur, patch) => optimistic.patch(cur, patch as Partial<Student>),
    invalidateAlso: [keys.students.all, keys.applications.all],
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const regenMut = useInvalidatingMutation({
    mutationFn: () => regenerateStudentPassword(id!),
    invalidate: [studentKey],
    onSuccess: (cr: any) => setCredentials(cr),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const regenerating = regenMut.isPending;

  const deleteMut = useInvalidatingMutation({
    mutationFn: () => deleteStudent(id!),
    invalidate: [keys.students.all],
    onSuccess: () => {
      toast(t('toast.deleted'), 'success');
      navigate('/students');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onSave = () => {
    if (!id || !form) return;
    setTouched({ fullName: true, phones: true, email: true, cabinet: true, comment: true });
    if (hasErrors(formErrors)) {
      toast(t('toast.error'), 'error');
      return;
    }
    const phones = form.phones.split(',').map((p: string) => p.trim()).filter(Boolean);
    const phoneLabels = (form.phoneLabels || '').split(',').map((s: string) => s.trim());
    // Подгоняем длину массива подписей под кол-во телефонов: лишние
    // обрезаем, недостающие заполняем пустыми строками.
    while (phoneLabels.length < phones.length) phoneLabels.push('');
    phoneLabels.length = phones.length;
    updateMut.mutate({
      fullName: form.fullName.trim(),
      phones,
      phoneLabels,
      preferredChannel: form.preferredChannel || undefined,
      birthday: form.birthday || undefined,
      email: form.email?.trim() || undefined,
      direction: form.direction,
      cabinet: parseInt(form.cabinet, 10),
      status: form.status,
      onboardingStage: form.onboardingStage || undefined,
      comment: form.comment?.trim() || undefined,
    } as any);
  };

  const onPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !id) return;
    photoMut.mutate(file);
  };

  const onReassign = async (patch: { managerId?: string | null; chinaManagerId?: string | null }): Promise<void> => {
    if (!id) return;
    await reassignMut.mutateAsync(patch);
  };

  const onRegenerate = async () => {
    if (!id) return;
    const ok = await confirm({
      title: t('userDetail.action.resetPassword'),
      message: '',
      confirmText: t('common.reset'),
      danger: true,
    });
    if (!ok) return;
    regenMut.mutate(undefined as any);
  };

  const copyCreds = async () => {
    if (!credentials) return;
    const text = `${t('userDetail.field.email')}: ${credentials.email}\n${t('login.password')}: ${credentials.password}\n${t('login.title')}: https://javonon.vercel.app/login`;
    try {
      await navigator.clipboard.writeText(text);
      toast(t('toast.copied'), 'success');
    } catch {
      toast(t('toast.error'), 'error');
    }
  };

  const onDeleteStudent = async () => {
    if (!id) return;
    const ok = await confirm({
      title: t('common.delete') + ' · ' + t('studentDetail.title'),
      message: '',
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(undefined as any);
  };

  if (!student || !form) return <Loading />;

  const isAdmin = isElevated(me);
  const assigned = !!student.managerId || !!student.chinaManagerId;
  const isMine = !assigned || student.managerId === me?.id || student.chinaManagerId === me?.id;
  const canEdit = isAdmin || isMine;

  // «Успех» — новое SUCCESSFUL_LEAD ИЛИ старые ENROLLED/COMPLETED: пока
  // миграция строк не отработала, API отдаёт и то и другое.
  const isEnrolled = isFinishedApplicationStatus(student.applications?.[0]?.status);

  return (
    <div>
      <BackButton fallback="/students" />
      <div className="card">
      <div className="card-header">
        <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {student.fullName}
          {isEnrolled && (
            <span className="enrolled-badge" title={appStatusLabel('SUCCESSFUL_LEAD')}>
              <Icon name="verified" size={16} />
              {appStatusLabel('SUCCESSFUL_LEAD')}
            </span>
          )}
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {canEdit && !edit && <button className="btn btn-secondary btn-sm" onClick={() => setEdit(true)}>{t('common.edit')}</button>}
          {canEdit && edit && <>
            <button className="btn btn-secondary btn-sm" onClick={() => { setEdit(false); reload(); }}>{t('common.cancel')}</button>
            <button className="btn btn-primary btn-sm" onClick={onSave}>{t('common.save')}</button>
          </>}
          {canEdit && <button className="btn btn-danger btn-sm" onClick={onDeleteStudent}>{t('common.delete')}</button>}
        </div>
      </div>
      <div className="card-body">
        <ManagerBar
          manager={student.manager}
          chinaManager={student.chinaManager}
          onReassign={onReassign}
        />

        {/* Блок «Партнёр» — сразу под менеджерами. Рисуется, только если
            бэкенд положил partnerAttribution в ответ: поле приходит ТОЛЬКО
            руководству (FOUNDER/ADMIN/ACCOUNTANT) и только у партнёрских
            клиентов. Клиентскому менеджеру ключа в JSON нет вовсе. */}
        <PartnerAttributionCard attribution={student.partnerAttribution} />

        {student.applications && student.applications.length > 0 ? (
          // Раньше редактор прятался у зачисленных: у степпера просто не было
          // следующего шага. Теперь это дропдаун и «Успешные лиды» — обычный
          // выбираемый статус, поэтому показываем всегда: иначе ошибочно
          // проставленный успех откатить из карточки невозможно.
          <ApplicationStatusSelect
            application={student.applications[0]}
            canEdit={canEdit}
            onChanged={reload}
          />
        ) : (
          canEdit && (
            <div className="app-stepper" style={{ textAlign: 'center' }}>
              <div className="app-stepper-title" style={{ marginBottom: 6 }}>
                {t('studentDetail.stepper.title')}
              </div>
              <div style={{ color: 'var(--text-soft)', fontSize: 13, marginBottom: 12 }}>
                {t('studentDetail.stepper.empty')}
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  try {
                    await ensureStudentApplication(student.id);
                    toast(t('toast.created'), 'success');
                    reload();
                  } catch (e: any) {
                    toast(e?.response?.data?.message || t('toast.error'), 'error');
                  }
                }}
              >
                <Icon name="add" size={16} style={{ marginRight: 4 }} />
                {t('studentDetail.stepper.createApp')}
              </button>
            </div>
          )
        )}

        {isAdmin && (
          <div className="access-bar">
            <div className="access-bar-info">
              <Icon name="lock_person" size={22} />
              <div>
                <div className="access-bar-title">{t('studentDetail.access.title')}</div>
                <div className="access-bar-email">
                  {student.email ? <><b>{student.email}</b></> : '—'}
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
                {regenerating ? t('common.saving') : t('userDetail.action.resetPassword')}
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
                <span style={{ color: '#16a34a' }}>{appStatusLabel('SUCCESSFUL_LEAD')}</span>
              </motion.div>
            )}
            {canEdit && (
              <>
                <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => photoRef.current?.click()}>
                  <Icon name="photo_camera" size={18} style={{ marginRight: 6 }} />
                  {t('studentDetail.action.uploadPhoto')}
                </button>
                <input ref={photoRef} type="file" accept="image/*" hidden onChange={onPhoto} />
              </>
            )}
          </div>
          <div>
            {!edit ? (
              <>
                <div className="detail-row"><div className="detail-label">{t('app.field.fullName')}</div><div className="detail-value">{student.fullName}</div></div>
                <div className="detail-row">
                  <div className="detail-label">{t('app.field.phones')}</div>
                  <div className="detail-value">
                    {student.phones.length === 0
                      ? '—'
                      : student.phones.map((p, i) => (
                          <div key={i}>
                            {p}
                            {student.phoneLabels?.[i] && (
                              <span style={{ color: 'var(--text-soft)', fontSize: 12, marginLeft: 6 }}>
                                · {student.phoneLabels[i]}
                              </span>
                            )}
                          </div>
                        ))}
                  </div>
                </div>
                {student.preferredChannel && (
                  <div className="detail-row">
                    <div className="detail-label">{t('app.field.preferredChannel')}</div>
                    <div className="detail-value">{channelLabel(student.preferredChannel as any)}</div>
                  </div>
                )}
                {student.birthday && (
                  <div className="detail-row">
                    <div className="detail-label">{t('app.field.birthday')}</div>
                    {/* TJ-календарь, а не таймзона браузера — иначе карточка
                        студента и карточка заявки разошлись бы на сутки. */}
                    <div className="detail-value">{tjFormatDate(student.birthday)}</div>
                  </div>
                )}
                <div className="detail-row"><div className="detail-label">{t('userDetail.field.email')}</div><div className="detail-value">{student.email || '—'}</div></div>
                {/* Страна — то, что клиент реально выбрал на сайте. Переезжает
                    на студента при конвертации заявки; для заведённых вручную
                    её нет, поэтому строку показываем только когда есть. */}
                {student.country && (
                  <div className="detail-row">
                    <div className="detail-label">{t('app.field.country')}</div>
                    <div className="detail-value">{countryLabel(student.country)}</div>
                  </div>
                )}
                <div className="detail-row">
                  <div className="detail-label">{t('app.field.direction')}</div>
                  {/* directionConfirmed === false → в direction лежит
                      плейсхолдер, приехавший из заявки с лендинга. Печатать
                      «Бакалавриат» здесь опаснее, чем в списке заявок: карточка
                      студента выглядит как проверенные данные. undefined
                      (старый ответ API) считаем подтверждённым — @default(true). */}
                  <div className="detail-value">
                    {student.directionConfirmed === false ? (
                      <span
                        style={{ color: 'var(--text-light)' }}
                        title={t('app.direction.unconfirmed')}
                      >
                        —
                      </span>
                    ) : (
                      directionLabel(student.direction)
                    )}
                  </div>
                </div>
                <div className="detail-row">
                  <div className="detail-label">{t('app.field.cabinet')}</div>
                  {/* Пока направление не подтверждено, номер кабинета —
                      «приёмник» из конвертации, а не осознанная маршрутизация.
                      Помечаем, иначе кабинет 1 читался бы как назначенный. */}
                  <div className="detail-value">
                    №{student.cabinet}
                    {student.directionConfirmed === false && (
                      <span style={{ color: 'var(--text-light)', fontSize: 12, marginLeft: 6 }}>
                        · {t('student.cabinet.pending')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="detail-row"><div className="detail-label">{t('common.status')}</div><div className="detail-value">{statusLabel(student.status)}</div></div>
                {student.onboardingStage && (
                  <div className="detail-row">
                    <div className="detail-label">{t('app.field.onboarding')}</div>
                    <div className="detail-value">{onboardingLabel(student.onboardingStage)}</div>
                  </div>
                )}
                <div className="detail-row"><div className="detail-label">{t('app.field.comment')}</div><div className="detail-value" style={{ whiteSpace: 'pre-wrap' }}>{student.comment || '—'}</div></div>
                <div className="detail-row"><div className="detail-label">{t('profile.field.createdAt')}</div><div className="detail-value">{new Date(student.createdAt).toLocaleString('ru-RU')}</div></div>
              </>
            ) : (
              <>
                <div className="form-group">
                  <label>{t('app.field.fullName')} *</label>
                  <input
                    value={form.fullName}
                    onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                    onBlur={() => setTouched((tt) => ({ ...tt, fullName: true }))}
                    className={`crm-input${showErr('fullName') ? ' input-error' : ''}`}
                    maxLength={100}
                  />
                  {showErr('fullName') && <div className="form-error-text">{(formErrors as any).fullName}</div>}
                </div>
                <div className="form-group">
                  <label>{t('app.field.phones')}</label>
                  <input
                    value={form.phones}
                    onChange={(e) => setForm({ ...form, phones: e.target.value.replace(/[^\d ,+\-()]/g, '') })}
                    onBlur={() => setTouched((tt) => ({ ...tt, phones: true }))}
                    className={`crm-input${showErr('phones') ? ' input-error' : ''}`}
                    placeholder="+992123456789, +992111222333"
                  />
                  {showErr('phones') && <div className="form-error-text">{(formErrors as any).phones}</div>}
                </div>
                <div className="form-group">
                  <label>{t('studentDetail.field.phoneLabels')}</label>
                  <input
                    className="crm-input"
                    value={form.phoneLabels || ''}
                    onChange={(e) => setForm({ ...form, phoneLabels: e.target.value })}
                  />
                </div>
                <div className="form-grid-2">
                  <div className="form-group">
                    <label>{t('app.field.preferredChannel')}</label>
                    <select
                      className="crm-select"
                      value={form.preferredChannel || ''}
                      onChange={(e) => setForm({ ...form, preferredChannel: e.target.value })}
                    >
                      <option value="">—</option>
                      <option value="WHATSAPP">{channelLabel('WHATSAPP' as any)}</option>
                      <option value="PHONE">{channelLabel('PHONE' as any)}</option>
                      <option value="INSTAGRAM">{channelLabel('INSTAGRAM' as any)}</option>
                      <option value="TELEGRAM">{channelLabel('TELEGRAM' as any)}</option>
                      <option value="EMAIL">{channelLabel('EMAIL' as any)}</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>{t('app.field.birthday')}</label>
                    <CrmDatePicker
                      className="crm-input"
                      value={form.birthday || ''}
                      onChange={(v) => setForm({ ...form, birthday: v })}
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>{t('userDetail.field.email')}</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    onBlur={() => setTouched((tt) => ({ ...tt, email: true }))}
                    className={`crm-input${showErr('email') ? ' input-error' : ''}`}
                  />
                  {showErr('email') && <div className="form-error-text">{(formErrors as any).email}</div>}
                </div>
                <div className="form-grid-2">
                  <div className="form-group">
                    <label>{t('app.field.direction')}</label>
                    <select className="crm-select" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as Direction })}>
                      <DirectionOptions />
                    </select>
                  </div>
                  <div className="form-group">
                    <label>{t('app.field.cabinet')}</label>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={form.cabinet}
                      onChange={(e) => setForm({ ...form, cabinet: e.target.value.replace(/[^\d]/g, '') })}
                      onBlur={() => setTouched((tt) => ({ ...tt, cabinet: true }))}
                      className={`crm-input${showErr('cabinet') ? ' input-error' : ''}`}
                    />
                    {showErr('cabinet') && <div className="form-error-text">{(formErrors as any).cabinet}</div>}
                  </div>
                </div>
                <div className="form-grid-2">
                  <div className="form-group">
                    <label>{t('common.status')}</label>
                    <select className="crm-select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as StudentStatus })}>
                      <option value="ACTIVE">{statusLabel('ACTIVE' as any)}</option>
                      <option value="PAUSED">{statusLabel('PAUSED' as any)}</option>
                      <option value="GRADUATED">{statusLabel('GRADUATED' as any)}</option>
                      <option value="ARCHIVED">{statusLabel('ARCHIVED' as any)}</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>{t('app.field.onboarding')}</label>
                    <select className="crm-select" value={form.onboardingStage || 'WELCOME'} onChange={(e) => setForm({ ...form, onboardingStage: e.target.value })}>
                      <option value="WELCOME">{onboardingLabel('WELCOME' as any)}</option>
                      <option value="DOCS_COLLECTED">{onboardingLabel('DOCS_COLLECTED' as any)}</option>
                      <option value="CABINET_OPENED">{onboardingLabel('CABINET_OPENED' as any)}</option>
                      <option value="ACADEMY_INTRO">{onboardingLabel('ACADEMY_INTRO' as any)}</option>
                      <option value="ACTIVE">{onboardingLabel('ACTIVE' as any)}</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label>{t('app.field.comment')}</label>
                  <textarea
                    value={form.comment}
                    onChange={(e) => setForm({ ...form, comment: e.target.value })}
                    onBlur={() => setTouched((tt) => ({ ...tt, comment: true }))}
                    maxLength={2000}
                    className={`crm-textarea${showErr('comment') ? ' input-error' : ''}`}
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
              <div className="dialog-title">{t('login.password')}</div>
              <div className="dialog-message">
                {t('studentDetail.password.oneTime')}
              </div>
              <div className="creds-box">
                <CredRow label={t('userDetail.field.email')} value={credentials.email} />
                <CredRow label={t('login.password')} value={credentials.password} />
              </div>
              <div className="dialog-actions">
                <button className="btn btn-secondary" onClick={copyCreds}>
                  <Icon name="content_copy" size={16} style={{ marginRight: 4 }} />
                  {t('common.copy')}
                </button>
                <button className="btn btn-primary" onClick={() => setCredentials(null)}>{t('common.ok')}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
