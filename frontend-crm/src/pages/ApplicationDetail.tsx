import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { assignApplicationManager, deleteApplication, getApplication, updateApplication } from '../api/applications';
import { getStudent, updateStudent, uploadPhoto } from '../api/students';
import type { Application, ApplicationStatus, Direction, Student } from '../api/types';
import { isFinishedApplicationStatus, isNewLeadApplicationStatus } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import { keys } from '../lib/queryKeys';
import { useFileToken } from '../lib/fileUrl';
import Loading from '../components/Loading';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import DocumentsChecklist from '../components/DocumentsChecklist';
import DirectionOptions from '../components/DirectionOptions';
import ManagerBar from '../components/ManagerBar';
import PartnerAttributionCard from '../components/PartnerAttributionCard';
import ApplicationFormSection from '../components/ApplicationFormSection';
import InteractionsLog from '../components/InteractionsLog';
import StudentEditForm, { type StudentPatch } from '../components/StudentEditForm';
import BackButton from '../components/BackButton';
import CrmSelect from '../components/CrmSelect';
import Icon from '../Icon';
import { EditButton, EditField, EditForm, Field } from '../components/ProfileParts';
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
import { useChannelLabel, useCountryLabel, useDirectionLabel, useStudentStatusLabel } from '../lib/labels';
import { tjFormatFull } from '../lib/tjTime';

/**
 * Карточка заявки. Устроена как карточка сотрудника: шапка (аватар, имя,
 * статус / этап / долг таблетками, контакты, действия), ниже одна панель
 * «Данные клиента» плотной сеткой и рядом «Менеджеры». Правка открывается
 * под данными. Карточка студента (StudentDetail) собрана из тех же деталей.
 */
export default function ApplicationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const { t } = useT();
  useFileToken(); // ссылки на файлы — с файловым токеном, перерисовка когда он придёт
  const directionLabel = useDirectionLabel();
  const studentStatusLabel = useStudentStatusLabel();
  const channelLabel = useChannelLabel();
  const countryLabel = useCountryLabel();
  const [editing, setEditing] = useState(false);

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

  const reload = () => {
    qc.invalidateQueries({ queryKey: appKey });
    if (studentId) qc.invalidateQueries({ queryKey: studentKey });
  };

  useRealtime({
    'application:updated': (data: any) => {
      if (data?.application?.id === id || data?.studentId === studentId) reload();
    },
    // Массовое назначение менеджера: в событии только id затронутых заявок.
    'applications:bulk-updated': (data: any) => {
      if (id && Array.isArray(data?.applicationIds) && data.applicationIds.includes(id)) reload();
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
    onSuccess: () => {
      // Раньше тост показывался только для двух legacy-значений — в новой
      // схеме этих статусов не существует, и подтверждение исчезло бы совсем.
      toast(t('toast.updated'), 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  // ЗАДОЛЖЕННОСТЬ — отдельный флаг, а не статус.
  //
  // Раньше «ждёт оплаты» был пунктом воронки (AWAITING_PAYMENT), и финансы
  // читали именно статус. В новом наборе статусов — исходы квалификации лида,
  // и «ждёт оплаты» среди них нет: долг ортогонален квалификации (должник
  // одновременно «Успешный лид»). Поэтому признак живёт в поле
  // Application.paymentPending, а раздел «Задолженность студентов» на /finance
  // и карточка дашборда строятся по нему. Без этого переключателя колонку
  // могла бы заполнить только миграция — список должников замер бы снимком.
  const debtMut = useOptimisticMutation<Application, boolean, Application>({
    mutationFn: (paymentPending) => updateApplication(id!, { paymentPending }),
    queryKey: appKey,
    applyOptimistic: (cur, paymentPending) => optimistic.patch(cur, { paymentPending }),
    // Инвалидируем ещё и финансы: карточка «Студентов с задолженностью» и
    // таблица долгов кэшируются под keys.finance.pending() — без этого
    // менеджер снимает долг, а Финансы продолжают показывать студента.
    invalidateAlso: [keys.applications.all, keys.students.all, keys.finance.pending()],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const reassignMut = useOptimisticMutation<Application, { managerId?: string | null; chinaManagerId?: string | null }, Application>({
    mutationFn: (patch) => assignApplicationManager(id!, patch),
    queryKey: appKey,
    applyOptimistic: (cur, patch) => optimistic.patch(cur, patch as Partial<Application>),
    invalidateAlso: [keys.applications.all, keys.students.all],
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteMut = useInvalidatingMutation({
    mutationFn: () => deleteApplication(id!),
    invalidate: [keys.applications.all, keys.students.all],
    onSuccess: () => {
      toast(t('toast.deleted'), 'success');
      navigate('/applications');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const updateStudentMut = useOptimisticMutation<Student, StudentPatch, Student>({
    mutationFn: (patch) => updateStudent(studentId!, patch),
    queryKey: studentKey,
    applyOptimistic: (cur, patch) => optimistic.patch(cur, patch as Partial<Student>),
    invalidateAlso: [keys.students.all, keys.applications.all],
    onSuccess: () => {
      toast(t('toast.updated'), 'success');
      setEditing(false);
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const photoMut = useInvalidatingMutation({
    mutationFn: (file: File) => uploadPhoto(studentId!, file),
    invalidate: [studentKey, keys.students.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onReassign = async (patch: { managerId?: string | null; chinaManagerId?: string | null }): Promise<void> => {
    if (!id) return;
    await reassignMut.mutateAsync(patch);
  };

  const onDeleteApp = async () => {
    if (!id) return;
    const ok = await confirm({
      title: t('common.delete') + ' · ' + t('applicationDetail.title'),
      message: '',
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(undefined as any);
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!app) return <Loading />;

  // Новые/успешные исходы считаем вместе с legacy-значениями: перенос строк на
  // бэкенде опт-ин (MIGRATE_LEAD_STATUSES, см. api/types.ts и DEPLOY.md), и
  // пока его не прогнали, API отдаёт NEW / ENROLLED.
  const isNew = isNewLeadApplicationStatus(app.status);
  const isEnrolled = isFinishedApplicationStatus(app.status);
  const isAdmin = isElevated(me);
  const assigned = !!app.managerId || !!app.chinaManagerId;
  const isMine = !assigned || app.managerId === me?.id || app.chinaManagerId === me?.id;
  // Админ и назначенный менеджер (TJ/CN) могут вести заявку на любом этапе.
  const canAct = isAdmin || isMine;
  // Новая заявка (и заявка без студента) показывает и правит свои поля;
  // после создания студента — данные студента. Пока студент грузится,
  // видны поля заявки, а правка ждёт загрузки.
  const showsLead = isNew || !studentId;
  const withStudent = !showsLead && !!student;
  const canEditData = canAct && (showsLead || withStudent);

  // Контакты и поля — без повторов: у новой заявки из самой заявки, у заявки
  // со студентом — из студента, плюс ответы клиента с сайта (страна, WhatsApp).
  const phones = withStudent ? student!.phones : [app.phone, app.secondaryPhone].filter((p): p is string => !!p);
  const email = withStudent ? student!.email : app.email;
  const birthday = (withStudent && student!.birthday) || app.birthday;
  const country = app.country ?? (withStudent ? student!.country : null);
  const wa = waLink(app.whatsappPhone);
  const direction = withStudent ? student!.direction : app.direction;
  const directionConfirmed = withStudent ? student!.directionConfirmed : app.directionConfirmed;
  const channel = withStudent ? student!.preferredChannel : app.preferredChannel;
  const comment = withStudent ? student!.comment : app.comment;

  const contacts: ClientContact[] = [];
  if (phones[0]) contacts.push({ icon: 'call', text: phones[0], href: telLink(phones[0]), testId: 'contact-phone' });
  if (wa) contacts.push({ icon: 'chat', text: 'WhatsApp', href: wa, external: true, title: app.whatsappPhone || undefined, testId: 'contact-whatsapp' });
  if (email) contacts.push({ icon: 'mail', text: email, href: `mailto:${email}`, testId: 'contact-email' });
  if (country) contacts.push({ icon: 'public', text: countryLabel(country), testId: 'contact-country' });

  const showPeople = !isNew || !!app.partnerAttribution;

  return (
    <div className="client-page">
      <BackButton fallback="/applications" />

      <ClientHero
        eyebrow={t('client.eyebrow.lead')}
        name={withStudent ? student!.fullName : app.fullName}
        avatarId={app.studentId || app.id}
        photoUrl={withStudent ? student!.photoUrl : null}
        enrolled={isEnrolled}
        onPhotoPick={withStudent && canAct ? (file) => photoMut.mutate(file) : undefined}
        photoBusy={photoMut.isPending}
        controls={
          <>
            <StatusPill status={app.status} canEdit={canAct} busy={statusMut.isPending} onChange={(s) => statusMut.mutate(s)} />
            <StagePill
              applicationId={app.id}
              pipelineId={app.pipelineId}
              stageId={app.pipelineStageId}
              canEdit={canAct}
              onChanged={reload}
            />
            <DebtPill pending={!!app.paymentPending} canEdit={canAct} busy={debtMut.isPending} onChange={(v) => debtMut.mutate(v)} />
            <SmsNote status={app.status} />
          </>
        }
        contacts={contacts}
        actions={
          <>
            {/*
              ЕДИНСТВЕННЫЙ вход «заявка → сделка». id заявки уходит в query,
              бэкенд кладёт его в SaleSubmission.sourceApplicationId, и связь
              (а с ней партнёрская атрибуция с лендинга) переживает одобрение.
              Скрыт на «успешных» исходах: такая заявка обычно САМА создана
              одобрением первого платежа, и новая сделка по ней — почти всегда
              ошибка. Через список сделок этот путь по-прежнему доступен.
            */}
            {canAct && !isEnrolled && (
              <button
                type="button"
                className="btn btn-secondary client-deal-btn"
                title={t('applicationDetail.createDeal.hint')}
                onClick={() => navigate(`/submissions/new?applicationId=${encodeURIComponent(app.id)}`)}
                data-testid="client-create-deal"
              >
                <Icon name="handshake" size={18} /> {t('applicationDetail.createDeal')}
              </button>
            )}
            {canEditData && (
              <button type="button" className="btn btn-primary" onClick={() => setEditing((v) => !v)} data-testid="client-edit">
                <Icon name="edit" size={18} /> {t('profile.edit')}
              </button>
            )}
            {canAct && (
              <button
                type="button"
                className="btn btn-secondary client-delete-btn"
                onClick={onDeleteApp}
                title={t('common.delete')}
                aria-label={t('common.delete')}
                data-testid="client-delete"
              >
                <Icon name="delete" size={18} />
              </button>
            )}
          </>
        }
      />

      <section className="card profile-section" data-testid="client-main">
        <div className={`profile-cols${showPeople ? '' : ' is-single'}`}>
          <div className="profile-group" data-testid="group-client">
            <div className="profile-group-head">
              <h3 className="profile-h">{t('client.section.data')}</h3>
              {canEditData && <EditButton active={editing} testId="edit-client" onClick={() => setEditing((v) => !v)} />}
            </div>
            <div className="profile-grid client-grid">
              <Field
                label={phones.length > 1 ? t('app.field.phones') : t('app.field.phone')}
                testId="field-phone"
                value={
                  phones.length === 0 ? '—' : phones.map((p, i) => (
                    <div key={i}>
                      {p}
                      {withStudent
                        ? student!.phoneLabels?.[i] && <span className="client-field-sub"> · {student!.phoneLabels[i]}</span>
                        : i === 1 && app.secondaryContactLabel && <span className="client-field-sub"> · {app.secondaryContactLabel}</span>}
                    </div>
                  ))
                }
              />
              <Field
                label={t('app.field.whatsapp')}
                testId="field-whatsapp"
                value={wa ? <a href={wa} target="_blank" rel="noopener noreferrer" className="client-link">{app.whatsappPhone}</a> : '—'}
              />
              <Field label={t('userDetail.field.email')} testId="field-email" value={email || '—'} />
              <Field label={t('app.field.birthday')} testId="field-birthday" value={<BirthdayValue iso={birthday} />} />
              <Field label={t('app.field.country')} testId="field-country" value={countryLabel(country)} />
              {/* Неподтверждённое направление — плейсхолдер бэкенда, а не выбор
                  клиента: форма на сайте спрашивает страну. Показываем «—». */}
              <Field
                label={t('app.field.direction')}
                testId="field-direction"
                value={directionConfirmed === false
                  ? <span className="client-muted" title={t('app.direction.unconfirmed')}>—</span>
                  : directionLabel(direction)}
              />
              {withStudent && (
                <Field
                  label={t('app.field.cabinet')}
                  testId="field-cabinet"
                  value={<>№{student!.cabinet}</>}
                  hint={student!.directionConfirmed === false ? t('student.cabinet.pending') : undefined}
                />
              )}
              {withStudent && <Field label={t('common.status')} testId="field-student-status" value={studentStatusLabel(student!.status)} />}
              {channel && <Field label={t('app.field.preferredChannel')} testId="field-channel" value={channelLabel(channel)} />}
              <Field label={t('client.created.lead')} testId="field-created" value={tjFormatFull(app.createdAt)} />
              <Field label={t('app.field.comment')} testId="field-comment" wide value={<span className="client-pre">{comment || '—'}</span>} />
            </div>
          </div>
          {showPeople && (
            <div className="profile-group" data-testid="group-people">
              <div className="profile-group-head">
                <h3 className="profile-h">{t('client.section.people')}</h3>
              </div>
              {!isNew && <ManagerBar manager={app.manager} chinaManager={app.chinaManager} onReassign={onReassign} />}
              {/* Партнёр — только руководству и только у партнёрских клиентов:
                  решает бэкенд, у менеджера по продажам ключа в JSON нет. */}
              <PartnerAttributionCard attribution={app.partnerAttribution} variant="field" />
            </div>
          )}
        </div>

        {editing && canEditData && (
          <div className="profile-edit">
            {withStudent ? (
              <StudentEditForm
                student={student!}
                saving={updateStudentMut.isPending}
                onSave={(patch) => updateStudentMut.mutate(patch)}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <NewApplicationEditor app={app} onSaved={() => { setEditing(false); reload(); }} onCancel={() => setEditing(false)} />
            )}
          </div>
        )}
      </section>

      {withStudent && (
        <>
          <section className="card profile-section" data-testid="client-docs">
            <h3 className="profile-h">{t('client.section.docs')}</h3>
            <DocumentsChecklist
              studentId={student!.id}
              studentName={student!.fullName}
              documents={student!.documents || []}
              applicationForm={student!.applicationForm}
              onChange={reload}
              editable={canAct}
            />
          </section>

          {/* Вместо прежнего блока «Комментарии» (он ничего не сохранял) —
              настоящая история общения клиента: звонки, переписка, заметки. */}
          <InteractionsLog studentId={student!.id} canEdit={canAct} />

          <ApplicationFormSection
            studentId={student!.id}
            initialForm={student!.applicationForm}
            canEdit={canAct}
            onSaved={reload}
          />
        </>
      )}
    </div>
  );
}

/**
 * Правка полей самой заявки — пока по ней не создан студент: телефоны,
 * канал связи, email, направление, комментарий (поля Application из ТЗ §8b).
 */
function NewApplicationEditor({ app, onSaved, onCancel }: { app: Application; onSaved: () => void; onCancel: () => void }) {
  const { toast } = useUI();
  const { t } = useT();
  const channelLabel = useChannelLabel();
  const [phone, setPhone] = useState(app.phone || '');
  const [secondaryPhone, setSecondaryPhone] = useState(app.secondaryPhone || '');
  const [secondaryContactLabel, setSecondaryContactLabel] = useState(app.secondaryContactLabel || '');
  const [preferredChannel, setPreferredChannel] = useState<string>(app.preferredChannel || '');
  const [email, setEmail] = useState(app.email || '');
  // Неподтверждённое направление показываем как пустой выбор, а не как
  // «Бакалавриат»: в БД там плейсхолдер, и предзаполненный селект заставил бы
  // менеджера подтвердить чужую догадку одним нажатием «Сохранить».
  const [direction, setDirection] = useState<Direction | ''>(app.directionConfirmed === false ? '' : app.direction);
  const [comment, setComment] = useState(app.comment || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateApplication(app.id, {
        phone: phone.trim() || undefined,
        secondaryPhone: secondaryPhone.trim() || undefined,
        secondaryContactLabel: secondaryContactLabel.trim() || undefined,
        preferredChannel: (preferredChannel || undefined) as any,
        email: email.trim() || undefined,
        // Отправляем направление, только когда менеджер его выбрал. Пустое
        // значение не шлём: бэкенд трактует пришедший direction как
        // подтверждение (directionConfirmed=true) и снял бы пометку зря.
        direction: (direction || undefined) as any,
        comment: comment.trim() || undefined,
      } as any);
      toast(t('toast.saved'), 'success');
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditForm
      title={t('client.section.data')}
      saving={saving}
      onSave={save}
      onCancel={onCancel}
      testId="client-edit-form"
      footer={
        <EditField label={t('app.field.comment')} wide>
          <textarea
            className="crm-textarea"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            style={{ resize: 'none' }}
            data-testid="edit-comment"
          />
        </EditField>
      }
    >
      <EditField label={t('app.field.mainPhone')}>
        <input className="crm-input" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="edit-phone" />
      </EditField>
      <EditField label={t('app.field.secondaryPhoneHint')}>
        <input className="crm-input" value={secondaryPhone} onChange={(e) => setSecondaryPhone(e.target.value)} placeholder="+992 ..." />
      </EditField>
      <EditField label={t('app.field.secondaryLabel')}>
        <input
          className="crm-input"
          value={secondaryContactLabel}
          onChange={(e) => setSecondaryContactLabel(e.target.value)}
          placeholder={t('app.field.secondaryLabelPh')}
        />
      </EditField>
      <EditField label={t('app.field.preferredChannel')}>
        <CrmSelect className="crm-select" value={preferredChannel} onChange={(e) => setPreferredChannel(e.target.value)}>
          <option value="">—</option>
          <option value="WHATSAPP">{channelLabel('WHATSAPP')}</option>
          <option value="PHONE">{channelLabel('PHONE')}</option>
          <option value="INSTAGRAM">{channelLabel('INSTAGRAM')}</option>
          <option value="TELEGRAM">{channelLabel('TELEGRAM')}</option>
          <option value="EMAIL">{channelLabel('EMAIL')}</option>
        </CrmSelect>
      </EditField>
      <EditField label={t('userDetail.field.email')}>
        <input className="crm-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="edit-email" />
      </EditField>
      {/* Единственное место, где направление лида с лендинга вообще можно
          проставить. Без него заявка навсегда оставалась бы
          directionConfirmed=false и не попадала бы ни в срез дашборда
          «по направлениям», ни в фильтр списка. */}
      <EditField label={t('app.field.direction')}>
        <CrmSelect className="crm-select" value={direction} onChange={(e) => setDirection(e.target.value as Direction | '')}>
          <option value="">{t('app.direction.notChosen')}</option>
          <DirectionOptions />
        </CrmSelect>
      </EditField>
    </EditForm>
  );
}
