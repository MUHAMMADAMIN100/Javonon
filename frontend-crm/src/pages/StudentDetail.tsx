import { useFileToken } from '../lib/fileUrl';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { assignStudentManager, deleteStudent, ensureStudentApplication, getStudent, regenerateStudentPassword, updateStudent, uploadPhoto } from '../api/students';
import { updateApplication } from '../api/applications';
import { motion, AnimatePresence } from 'framer-motion';
import type { Application, ApplicationStatus, Student } from '../api/types';
import { isFinishedApplicationStatus } from '../api/types';
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
import StudentEditForm, { type StudentPatch } from '../components/StudentEditForm';
import BackButton from '../components/BackButton';
import Icon from '../Icon';
import { EditButton, Field } from '../components/ProfileParts';
import {
  BirthdayValue,
  ClientHero,
  DebtPill,
  SmsNote,
  StagePill,
  StatusPill,
  telLink,
  waLink,
  type ClientContact,
} from '../components/ClientCard';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useDirectionLabel, useStudentStatusLabel, useOnboardingLabel, useChannelLabel, useCountryLabel } from '../lib/labels';
import { tjFormatFull } from '../lib/tjTime';

function CredRow({ label, value }: { label: string; value: string }) {
  const { t } = useT();
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
        title={copied ? t('common.copied') : t('common.copy')}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={15} />
      </button>
    </div>
  );
}

/** Правка первой (самой новой) заявки студента прямо в кеше карточки. */
function patchFirstApp(cur: Student | undefined, patch: Partial<Application>): Student | undefined {
  if (!cur) return cur;
  return { ...cur, applications: (cur.applications || []).map((a, i) => (i === 0 ? { ...a, ...patch } : a)) };
}

/**
 * Карточка студента. Собрана из тех же деталей, что карточка заявки
 * (ApplicationDetail): шапка с таблетками статуса / этапа / долга его
 * заявки, «Данные клиента» сеткой, «Менеджеры», ниже документы, оплаты,
 * история общения и анкета.
 */
export default function StudentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const { t } = useT();
  useFileToken(); // ссылки на файлы — с файловым токеном, перерисовка когда он придёт
  const directionLabel = useDirectionLabel();
  const statusLabel = useStudentStatusLabel();
  const onboardingLabel = useOnboardingLabel();
  const channelLabel = useChannelLabel();
  const countryLabel = useCountryLabel();
  const [editing, setEditing] = useState(false);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);

  const studentKey = id ? keys.students.one(id) : ['students', 'one', null];
  const studentQuery = useQuery<Student>({
    queryKey: studentKey,
    queryFn: () => getStudent(id!),
    enabled: !!id,
  });
  const student = studentQuery.data ?? null;
  // Заявка студента — самая новая (сервер отдаёт их без удалённых, новые первыми).
  const app0 = student?.applications?.[0] ?? null;

  const reload = () => qc.invalidateQueries({ queryKey: studentKey });

  useRealtime({
    'student:updated': (data: any) => { if (data?.studentId === id) reload(); },
    'document:uploaded': (data: any) => { if (data?.studentId === id) reload(); },
    'document:deleted': (data: any) => { if (data?.studentId === id) reload(); },
    'form:updated': (data: any) => { if (data?.studentId === id) reload(); },
    'application:updated': (data: any) => {
      if (data?.application?.studentId === id) reload();
    },
    // Массовое назначение менеджера: в событии только id затронутых.
    'applications:bulk-updated': (data: any) => {
      if (id && Array.isArray(data?.studentIds) && data.studentIds.includes(id)) reload();
    },
  });

  // UPDATE — оптимистично патчим student в кеше.
  const updateMut = useOptimisticMutation<Student, StudentPatch, Student>({
    mutationFn: (patch) => updateStudent(id!, patch),
    queryKey: studentKey,
    applyOptimistic: (cur, patch) => optimistic.patch(cur, patch as Partial<Student>),
    invalidateAlso: [keys.students.all],
    onSuccess: () => {
      toast(t('toast.updated'), 'success');
      setEditing(false);
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  // Статус и долг заявки — как в карточке заявки, оптимистично.
  const appStatusMut = useOptimisticMutation<Application, ApplicationStatus, Student>({
    mutationFn: (status) => updateApplication(app0!.id, { status }),
    queryKey: studentKey,
    applyOptimistic: (cur, status) => patchFirstApp(cur, { status }),
    invalidateAlso: [keys.applications.all, keys.students.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const debtMut = useOptimisticMutation<Application, boolean, Student>({
    mutationFn: (paymentPending) => updateApplication(app0!.id, { paymentPending }),
    queryKey: studentKey,
    applyOptimistic: (cur, paymentPending) => patchFirstApp(cur, { paymentPending }),
    // Финансы строят «Задолженность студентов» по этому флагу — сбрасываем и их.
    invalidateAlso: [keys.applications.all, keys.students.all, keys.finance.pending()],
    onSuccess: () => toast(t('toast.updated'), 'success'),
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

  const [creatingApp, setCreatingApp] = useState(false);
  const onCreateApp = async () => {
    if (!student) return;
    setCreatingApp(true);
    try {
      await ensureStudentApplication(student.id);
      toast(t('toast.created'), 'success');
      reload();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setCreatingApp(false);
    }
  };

  const onReassign = async (patch: { managerId?: string | null; chinaManagerId?: string | null }): Promise<void> => {
    if (!id) return;
    await reassignMut.mutateAsync(patch);
  };

  const onRegenerate = async () => {
    if (!id) return;
    // Кнопка подтверждения называет действие (по-таджикски common.reset — «Бекор кардан», «отменить»).
    const ok = await confirm({
      title: t('userDetail.action.resetPassword'),
      message: '',
      confirmText: t('userDetail.action.resetPassword'),
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

  if (!student) return <Loading />;

  const isAdmin = isElevated(me);
  const assigned = !!student.managerId || !!student.chinaManagerId;
  const isMine = !assigned || student.managerId === me?.id || student.chinaManagerId === me?.id;
  const canEdit = isAdmin || isMine;

  // «Успех» — новое SUCCESSFUL_LEAD ИЛИ старые ENROLLED/COMPLETED: пока
  // миграция строк не отработала, API отдаёт и то и другое.
  const isEnrolled = isFinishedApplicationStatus(app0?.status);
  const wa = waLink(app0?.whatsappPhone);
  const country = student.country ?? app0?.country ?? null;
  const birthday = student.birthday || app0?.birthday || null;

  const contacts: ClientContact[] = [];
  if (student.phones[0]) contacts.push({ icon: 'call', text: student.phones[0], href: telLink(student.phones[0]), testId: 'contact-phone' });
  if (wa) contacts.push({ icon: 'chat', text: 'WhatsApp', href: wa, external: true, title: app0?.whatsappPhone || undefined, testId: 'contact-whatsapp' });
  if (student.email) contacts.push({ icon: 'mail', text: student.email, href: `mailto:${student.email}`, testId: 'contact-email' });
  if (country) contacts.push({ icon: 'public', text: countryLabel(country), testId: 'contact-country' });

  return (
    <div className="client-page">
      <BackButton fallback="/students" />

      <ClientHero
        eyebrow={t('client.eyebrow.student')}
        name={student.fullName}
        avatarId={student.id}
        photoUrl={student.photoUrl}
        enrolled={isEnrolled}
        onPhotoPick={canEdit ? (file) => photoMut.mutate(file) : undefined}
        photoBusy={photoMut.isPending}
        controls={
          app0 ? (
            <>
              <StatusPill status={app0.status} canEdit={canEdit} busy={appStatusMut.isPending} onChange={(s) => appStatusMut.mutate(s)} />
              <StagePill
                applicationId={app0.id}
                pipelineId={app0.pipelineId}
                stageId={app0.pipelineStageId}
                canEdit={canEdit}
                onChanged={reload}
              />
              <DebtPill pending={!!app0.paymentPending} canEdit={canEdit} busy={debtMut.isPending} onChange={(v) => debtMut.mutate(v)} />
              <SmsNote status={app0.status} />
            </>
          ) : canEdit ? (
            // Заявки нет (студент заведён вручную) — статус вести негде: создаём её.
            <>
              <span className="client-muted">{t('studentDetail.stepper.empty')}</span>
              <button type="button" className="btn btn-sm btn-primary" onClick={onCreateApp} disabled={creatingApp} data-testid="client-create-app">
                <Icon name="add" size={16} /> {t('studentDetail.stepper.createApp')}
              </button>
            </>
          ) : undefined
        }
        contacts={contacts}
        actions={
          canEdit ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => setEditing((v) => !v)} data-testid="client-edit">
                <Icon name="edit" size={18} /> {t('profile.edit')}
              </button>
              <button
                type="button"
                className="btn btn-secondary client-delete-btn"
                onClick={onDeleteStudent}
                title={t('common.delete')}
                aria-label={t('common.delete')}
                data-testid="client-delete"
              >
                <Icon name="delete" size={18} />
              </button>
            </>
          ) : undefined
        }
      />

      <section className="card profile-section" data-testid="client-main">
        <div className="profile-cols">
          <div className="profile-group" data-testid="group-client">
            <div className="profile-group-head">
              <h3 className="profile-h">{t('client.section.data')}</h3>
              {canEdit && <EditButton active={editing} testId="edit-client" onClick={() => setEditing((v) => !v)} />}
            </div>
            <div className="profile-grid client-grid">
              <Field
                label={student.phones.length > 1 ? t('app.field.phones') : t('app.field.phone')}
                testId="field-phone"
                value={
                  student.phones.length === 0 ? '—' : student.phones.map((p, i) => (
                    <div key={i}>
                      {p}
                      {student.phoneLabels?.[i] && <span className="client-field-sub"> · {student.phoneLabels[i]}</span>}
                    </div>
                  ))
                }
              />
              <Field
                label={t('app.field.whatsapp')}
                testId="field-whatsapp"
                value={wa ? <a href={wa} target="_blank" rel="noopener noreferrer" className="client-link">{app0?.whatsappPhone}</a> : '—'}
              />
              <Field label={t('userDetail.field.email')} testId="field-email" value={student.email || '—'} />
              <Field label={t('app.field.birthday')} testId="field-birthday" value={<BirthdayValue iso={birthday} />} />
              <Field label={t('app.field.country')} testId="field-country" value={countryLabel(country)} />
              {/* directionConfirmed === false → в direction лежит плейсхолдер из
                  заявки с лендинга; карточка студента выглядит как проверенные
                  данные, поэтому «Бакалавриат» тут не печатаем. */}
              <Field
                label={t('app.field.direction')}
                testId="field-direction"
                value={student.directionConfirmed === false
                  ? <span className="client-muted" title={t('app.direction.unconfirmed')}>—</span>
                  : directionLabel(student.direction)}
              />
              <Field
                label={t('app.field.cabinet')}
                testId="field-cabinet"
                value={<>№{student.cabinet}</>}
                hint={student.directionConfirmed === false ? t('student.cabinet.pending') : undefined}
              />
              <Field label={t('common.status')} testId="field-student-status" value={statusLabel(student.status)} />
              {student.onboardingStage && (
                <Field label={t('app.field.onboarding')} testId="field-onboarding" value={onboardingLabel(student.onboardingStage)} />
              )}
              {student.preferredChannel && (
                <Field label={t('app.field.preferredChannel')} testId="field-channel" value={channelLabel(student.preferredChannel)} />
              )}
              {/* Вход в кабинет студента — только руководству, как и раньше. */}
              {isAdmin && (
                <Field
                  label={t('studentDetail.access.title')}
                  testId="field-access"
                  value={student.email || '—'}
                  extra={student.email ? (
                    <div className="profile-role-actions">
                      <button type="button" className="profile-link-btn" onClick={onRegenerate} disabled={regenerating} data-testid="client-reset-password">
                        <Icon name="refresh" size={14} /> {regenerating ? t('common.saving') : t('userDetail.action.resetPassword')}
                      </button>
                    </div>
                  ) : undefined}
                />
              )}
              <Field label={t('client.created.student')} testId="field-created" value={tjFormatFull(student.createdAt)} />
              <Field label={t('app.field.comment')} testId="field-comment" wide value={<span className="client-pre">{student.comment || '—'}</span>} />
            </div>
          </div>
          <div className="profile-group" data-testid="group-people">
            <div className="profile-group-head">
              <h3 className="profile-h">{t('client.section.people')}</h3>
            </div>
            <ManagerBar manager={student.manager} chinaManager={student.chinaManager} onReassign={onReassign} />
            {/* Партнёр — только руководству и только у партнёрских клиентов:
                решает бэкенд, у менеджера по продажам ключа в JSON нет. */}
            <PartnerAttributionCard attribution={student.partnerAttribution} variant="field" />
          </div>
        </div>

        {editing && canEdit && (
          <div className="profile-edit">
            <StudentEditForm
              student={student}
              withOnboarding
              saving={updateMut.isPending}
              onSave={(patch) => updateMut.mutate(patch)}
              onCancel={() => setEditing(false)}
            />
          </div>
        )}
      </section>

      <section className="card profile-section" data-testid="client-docs">
        <h3 className="profile-h">{t('client.section.docs')}</h3>
        <DocumentsChecklist
          studentId={student.id}
          studentName={student.fullName}
          documents={student.documents || []}
          applicationForm={student.applicationForm}
          onChange={reload}
          editable={canEdit}
        />
      </section>

      <StudentPaymentsSection studentId={student.id} />

      <InteractionsLog studentId={student.id} canEdit={canEdit} />

      <ApplicationFormSection
        studentId={student.id}
        initialForm={student.applicationForm}
        canEdit={canEdit}
        onSaved={reload}
      />

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
  );
}
