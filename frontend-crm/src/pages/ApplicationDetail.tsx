import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MAX_AGE, MIN_AGE, ageFromBirthday, birthdayBounds, email as emailRule, phoneRule, tjPhoneError } from '../utils/validators';
import CrmDatePicker from '../components/CrmDatePicker';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { assignApplicationManager, deleteApplication, getApplication, leadDeals, updateApplication } from '../api/applications';
import { getStudent, updateStudent, uploadPhoto } from '../api/students';
import type { Application, ApplicationSource, ApplicationStatus, Country, Direction, Student } from '../api/types';
import PhoneInput from '../components/PhoneInput';
import { leadPhoneError, phoneHasOwnDigits } from '../lib/leadPhone';
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
import {
  applicationRight,
  canSeeAllApplicationsByRole,
  canSeeAllClients,
  canSeeAllOfApplication,
  canTransferOthers,
  roleCan,
  transferScopeOf,
} from '../lib/permissions';
import { useT } from '../lib/i18n';
import { useChannelLabel, useCountryLabel, useDirectionLabel, useStudentStatusLabel } from '../lib/labels';
import { tjFormatDate, tjFormatFull } from '../lib/tjTime';
import { canOpenDeals } from '../components/navGroups';
import QueryErrorState from '../components/QueryErrorState';
import { DetailSkeleton } from '../components/Skeleton';
import { ClientOverviewCards, ClientTabsBar, useClientTab, useTimeline } from '../components/ClientTabs';
import { useLookups } from '../lib/lookups';
import { MACHINE_SOURCES } from '../api/lookups';
import LookupOptions from '../components/LookupOptions';
import { useSourceLabel } from '../lib/labels';
import { CustomFieldInputs, CustomFieldRows, draftChanged, draftToPayload, toDraft, useLeadFields, validateDraft, type CustomDraft } from '../components/CustomFields';

/**
 * Карточка заявки. Устроена как карточка сотрудника: шапка (аватар, имя,
 * статус / этап / долг таблетками, контакты, действия), ниже одна панель
 * «Данные клиента» плотной сеткой и рядом «Менеджеры». Правка открывается
 * под данными. Карточка студента (StudentDetail) собрана из тех же деталей.
 */
export default function ApplicationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Вкладка карточки — в ссылке (?tab=history): «назад» и обновление её помнят.
  const [tabRaw, setTab] = useClientTab(true);
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const { t } = useT();
  useFileToken(); // ссылки на файлы — с файловым токеном, перерисовка когда он придёт
  const directionLabel = useDirectionLabel();
  const sourceLabel = useSourceLabel();
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

  const studentId = app?.studentId;
  const studentKey = studentId ? keys.students.one(studentId) : ['students', 'one', null];
  const studentQuery = useQuery<Student>({
    queryKey: studentKey,
    queryFn: () => getStudent(studentId!),
    enabled: !!studentId,
  });
  const student = studentQuery.data ?? null;
  // «Обзор»: лента истории (тот же запрос, что у вкладки «История») и сделки клиента.
  const timelineQ = useTimeline(studentId, !!app && !isNewLeadApplicationStatus(app.status));
  const dealsQ = useQuery({ queryKey: ['applications', 'deals', id], queryFn: () => leadDeals(id!), enabled: !!id });

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
      navigate('/leads');
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

  if (appQuery.isError) {
    return <QueryErrorState error={appQuery.error} backTo="/leads" backLabelKey="errorState.toLeads" onRetry={() => appQuery.refetch()} />;
  }
  if (!app) return <DetailSkeleton testId="lead-skeleton" />;

  // Новые/успешные исходы считаем вместе с legacy-значениями: перенос строк на
  // бэкенде опт-ин (MIGRATE_LEAD_STATUSES, см. api/types.ts и DEPLOY.md), и
  // пока его не прогнали, API отдаёт NEW / ENROLLED.
  const isNew = isNewLeadApplicationStatus(app.status);
  const isEnrolled = isFinishedApplicationStatus(app.status);
  const isAdmin = isElevated(me);
  const assigned = !!app.managerId || !!app.chinaManagerId;
  const isMine = !assigned || app.managerId === me?.id || app.chinaManagerId === me?.id;
  // Админ и назначенный менеджер (TJ/CN) могут вести заявку на любом этапе;
  // с доступом «все лиды» / «все заявки» — и чужую этого вида.
  const canAct = isAdmin || isMine || canSeeAllOfApplication(me, app.status);
  // Права роли: у лида — «Лиды — …», у заявки — «Заявки — …» (Настройки → Роли).
  const canUpdate = canAct && applicationRight(me, app.status, 'update');
  const canAssign = applicationRight(me, app.status, 'assign');
  // Удалить — свою или руководство (сервер — ensureCanDelete); роли нужно
  // удаление своего вида, чужие — с назначением менеджера этого вида.
  const canDeleteAny = roleCan(me, isNew ? 'leads:assign' : 'applications:assign', canSeeAllApplicationsByRole(me));
  const canDelete = applicationRight(me, app.status, 'delete')
    && (canDeleteAny || app.managerId === me?.id || app.chinaManagerId === me?.id);
  // Документы, анкета и история общения — данные студента заявки: чужого
  // студента ведёт тот, кому выданы «все студенты».
  const canActStudent = canAct && (isAdmin || isMine || canSeeAllClients(me, 'students'));
  // Новая заявка (и заявка без студента) показывает и правит свои поля;
  // после создания студента — данные студента. Пока студент грузится,
  // видны поля заявки, а правка ждёт загрузки.
  const showsLead = isNew || !studentId;
  const withStudent = !showsLead && !!student;
  const canEditData = showsLead ? canUpdate : withStudent && canActStudent && roleCan(me, 'students:update');

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

  // QA-3 (BUG-33): менеджеры (TJ и CN) видны и у лида в «Новых лидах» — раньше
  // блок появлялся только после перевода лида в работу.
  const showPeople = true;

  // Макет (часть C): вкладки карточки — только у клиента со студентом (история,
  // документы и анкета принадлежат студенту); у нового лида — один «Обзор».
  const tab = withStudent ? tabRaw : 'overview';
  const canCreateDeal = (isAdmin || isMine) && !isEnrolled && roleCan(me, 'submissions:create') && canOpenDeals(me);
  const goCreateDeal = () => navigate(`/submissions/new?applicationId=${encodeURIComponent(app.id)}`);

  return (
    <div className="client-page">
      <BackButton fallback="/leads" />

      <ClientHero
        eyebrow={`${t('client.eyebrow.lead')} · ${t('client.meta.created').replace('{date}', tjFormatDate(app.createdAt))}${app.source ? ` · ${t('client.meta.source').replace('{source}', sourceLabel(app.source))}` : ''}`}
        name={withStudent ? student!.fullName : app.fullName}
        avatarId={app.studentId || app.id}
        photoUrl={withStudent ? student!.photoUrl : null}
        enrolled={isEnrolled}
        onPhotoPick={withStudent && canActStudent && roleCan(me, 'students:update') ? (file) => photoMut.mutate(file) : undefined}
        photoBusy={photoMut.isPending}
        controls={
          <>
            <StatusPill status={app.status} canEdit={canUpdate} busy={statusMut.isPending} onChange={(s) => statusMut.mutate(s)} />
            <StagePill
              applicationId={app.id}
              pipelineId={app.pipelineId}
              stageId={app.pipelineStageId}
              canEdit={canAct && roleCan(me, 'pipelines:move')}
              onChanged={reload}
            />
            <DebtPill pending={!!app.paymentPending} canEdit={canUpdate} busy={debtMut.isPending} onChange={(v) => debtMut.mutate(v)} />
            <SmsNote status={app.status} />
          </>
        }
        contacts={contacts}
        actions={
          <>
            {telLink(phones[0]) && (
              <a
                className="btn btn-secondary client-call-btn"
                href={telLink(phones[0])!}
                aria-label={`${t('client.call')}: ${phones[0]}`}
                title={phones[0]}
                data-testid="client-call"
              >
                <Icon name="call" size={18} /> <span className="client-call-label">{t('client.call')}</span>
              </a>
            )}
            {/*
              ЕДИНСТВЕННЫЙ вход «заявка → сделка». id заявки уходит в query,
              бэкенд кладёт его в SaleSubmission.sourceApplicationId, и связь
              (а с ней партнёрская атрибуция с лендинга) переживает одобрение.
              Скрыт на «успешных» исходах: такая заявка обычно САМА создана
              одобрением первого платежа, и новая сделка по ней — почти всегда
              ошибка. Через список сделок этот путь по-прежнему доступен.
            */}
            {/* Только своя заявка (или руководство): сделка засчитывается тому,
                кто её оформил, — по чужому клиенту это была бы чужая продажа.
                Доступ «все заявки / лиды» сделок не открывает. */}
            {(isAdmin || isMine) && !isEnrolled && roleCan(me, 'submissions:create') && canOpenDeals(me) && (
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
            {canDelete && (
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

      {withStudent && (
        <ClientTabsBar tab={tab} setTab={setTab} historyCount={timelineQ.data?.length} documents={student!.documents} />
      )}

      {tab === 'overview' && (
        <>
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
                          {/* Номер с ошибкой и повторы — видно сразу (QA №21). */}
                          {tjPhoneError(p) && <div className="client-field-warn" data-testid="phone-warn">{tjPhoneError(p)}</div>}
                          {i === 0 && !withStudent && (app.phoneTwins?.length ?? 0) > 0 && (
                            <div className="client-field-warn" data-testid="phone-twins">
                              {t('app.phoneTwins')}{' '}
                              {app.phoneTwins!.map((tw, k) => (
                                <span key={tw.id}>
                                  {k > 0 && ', '}
                                  {tw.canOpen ? <a className="client-link" href={`/admin/applications/${tw.id}`} onClick={(e) => { e.preventDefault(); navigate(`/applications/${tw.id}`); }}>{tw.fullName}</a> : t('app.phoneTwinsHidden')}
                                </span>
                              ))}
                            </div>
                          )}
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
                  <CustomFieldRows values={withStudent ? student!.customFields : app.customFields} />
                  <Field label={t('client.created.lead')} testId="field-created" value={tjFormatFull(app.createdAt)} />
                  <Field label={t('app.field.comment')} testId="field-comment" wide value={<span className="client-pre">{comment || '—'}</span>} />
                </div>
              </div>
              {showPeople && (
                <div className="profile-group" data-testid="group-people">
                  <div className="profile-group-head">
                    <h3 className="profile-h">{t('client.section.people')}</h3>
                  </div>
                  <ManagerBar
                    manager={app.manager}
                    chinaManager={app.chinaManager}
                    onReassign={onReassign}
                    canAssign={roleCan(me, isNew ? 'leads:assign' : 'applications:assign', isAdmin)}
                    canTransfer={canTransferOthers(me, transferScopeOf(app.status))}
                  />
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


          <ClientOverviewCards
            studentId={withStudent ? student!.id : null}
            documents={student?.documents}
            setTab={setTab}
            deals={dealsQ.data}
            dealsLoading={dealsQ.isLoading}
            canCreateDeal={canCreateDeal}
            onCreateDeal={goCreateDeal}
          />
        </>
      )}

      {withStudent && tab === 'docs' && (
        <section className="card profile-section" data-testid="client-docs">
          <h3 className="profile-h">{t('client.section.docs')}</h3>
          <DocumentsChecklist
            studentId={student!.id}
            studentName={student!.fullName}
            documents={student!.documents || []}
            applicationForm={student!.applicationForm}
            onChange={reload}
            editable={canActStudent && roleCan(me, 'students:documents')}
          />
        </section>
      )}

      {/* Вместо прежнего блока «Комментарии» (он ничего не сохранял) —
          настоящая история общения клиента: звонки, переписка, заметки. */}
      {withStudent && tab === 'history' && <InteractionsLog studentId={student!.id} canEdit={canActStudent} />}

      {withStudent && tab === 'form' && (
        <ApplicationFormSection
          studentId={student!.id}
          initialForm={student!.applicationForm}
          canEdit={canActStudent && roleCan(me, 'students:update')}
          onSaved={reload}
        />
      )}
    </div>
  );
}

/**
 * Правка полей самой заявки — пока по ней не создан студент: ФИО, дата
 * рождения, страна, телефоны, канал связи, email, направление, комментарий.
 *
 * QA №25: ошибки — у полей и по-русски (раньше склеенный английский текст
 * сервера в тосте), ФИО/страну/дату рождения теперь можно поменять.
 * QA №23: на сервер уходят только изменённые поля, поэтому старое значение с
 * ошибкой (номер +992 не той длины, «< >» в комментарии) не мешает правке
 * остального; новое значение проверяется по тем же правилам, что «Новый лид».
 */
function NewApplicationEditor({ app, onSaved, onCancel }: { app: Application; onSaved: () => void; onCancel: () => void }) {
  const { toast } = useUI();
  const { t } = useT();
  const channelLabel = useChannelLabel();
  const countryLabel = useCountryLabel();
  const dobBounds = birthdayBounds();
  const initial = {
    fullName: app.fullName || '',
    birthday: app.birthday ? String(app.birthday).slice(0, 10) : '',
    country: (app.country || '') as Country | '',
    phone: app.phone || '',
    whatsappPhone: app.whatsappPhone || '',
    source: (app.source || 'OTHER') as string,
    secondaryPhone: app.secondaryPhone || '',
    secondaryContactLabel: app.secondaryContactLabel || '',
    preferredChannel: (app.preferredChannel || '') as string,
    email: app.email || '',
    // Неподтверждённое направление показываем как пустой выбор, а не как
    // «Бакалавриат»: в БД там плейсхолдер, и предзаполненный селект заставил бы
    // менеджера подтвердить чужую догадку одним нажатием «Сохранить».
    direction: (app.directionConfirmed === false ? '' : app.direction) as Direction | '',
    comment: app.comment || '',
  };
  const [form, setForm] = useState(initial);
  const [showErrors, setShowErrors] = useState(false);
  // Свои поля анкеты лида.
  const leadFields = useLeadFields();
  const [cfDraft, setCfDraft] = useState<CustomDraft>(() => toDraft([], app.customFields));
  const cfErrors = validateDraft(leadFields, cfDraft, t);
  const [saving, setSaving] = useState(false);
  // QA-3 (BUG-08): WhatsApp правится здесь же. Галочка «тот же номер» — как в
  // «Новом лиде»: сменили основной телефон — WhatsApp меняется вместе с ним.
  const [sameWa, setSameWa] = useState(!app.whatsappPhone || app.whatsappPhone === app.phone);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const changed = (k: keyof typeof form) => form[k].trim() !== initial[k].trim();
  /** «Сайт», «Самозапись», «Реферал» поставила система — источник не меняется. */
  // «Сайт», «Самозапись», «Реферал» поставила система — источник не меняется.
  const sourceLocked = MACHINE_SOURCES.includes(app.source || 'OTHER');
  const L = useLookups();
  const waValue = sameWa ? form.phone : form.whatsappPhone;
  const waChanged = waValue.trim() !== initial.whatsappPhone.trim() && !(sameWa && !initial.whatsappPhone && !changed('phone'));

  // Ошибки только у изменённых полей — старые данные правку не блокируют.
  const errors: Partial<Record<keyof typeof form, string>> = {};
  if (changed('fullName')) {
    const n = form.fullName.trim();
    if (n.length < 2) errors.fullName = t('leads.err.nameRequired');
    else if (/[<>]/.test(n)) errors.fullName = t('leads.err.commentChars');
  }
  if (changed('birthday') && form.birthday) {
    const age = ageFromBirthday(form.birthday);
    if (age === undefined) errors.birthday = t('leads.err.birthdayInvalid');
    else if (age < MIN_AGE || age > MAX_AGE) errors.birthday = t('leads.err.birthdayAge');
  }
  // QA-3 (BUG-09): те же правила и та же маска, что в «Новом лиде» (lib/leadPhone).
  const phoneErr = (v: string) => { const k = leadPhoneError(v); return k ? t(k) : undefined; };
  if (changed('phone')) {
    errors.phone = !phoneHasOwnDigits(form.phone) ? t('leads.err.phoneRequired') : phoneErr(form.phone);
  }
  if (!sameWa && form.whatsappPhone.trim() !== initial.whatsappPhone.trim() && phoneHasOwnDigits(form.whatsappPhone)) {
    errors.whatsappPhone = phoneErr(form.whatsappPhone);
  }
  if (changed('secondaryPhone') && phoneHasOwnDigits(form.secondaryPhone)) errors.secondaryPhone = phoneErr(form.secondaryPhone);
  if (changed('email') && form.email.trim()) errors.email = emailRule()(form.email.trim());
  if (changed('comment')) {
    if (form.comment.length > 2000) errors.comment = t('leads.err.commentLong');
    else if (/[<>]/.test(form.comment)) errors.comment = t('leads.err.commentChars');
  }
  (Object.keys(errors) as (keyof typeof form)[]).forEach((k) => { if (!errors[k]) delete errors[k]; });
  const err = (k: keyof typeof form) => (showErrors ? errors[k] : undefined);

  const save = async () => {
    if (Object.keys(errors).length > 0 || Object.keys(cfErrors).length > 0) {
      setShowErrors(true);
      return;
    }
    const patch: Record<string, unknown> = {};
    if (changed('fullName')) patch.fullName = form.fullName.trim();
    if (changed('birthday')) patch.birthday = form.birthday || '';
    if (changed('country')) patch.country = form.country || null;
    if (changed('phone')) patch.phone = form.phone.trim();
    if (waChanged) patch.whatsappPhone = phoneHasOwnDigits(waValue) ? waValue.trim() : '';
    if (!sourceLocked && changed('source')) patch.source = form.source;
    if (changed('secondaryPhone')) patch.secondaryPhone = phoneHasOwnDigits(form.secondaryPhone) ? form.secondaryPhone.trim() : '';
    if (changed('secondaryContactLabel')) patch.secondaryContactLabel = form.secondaryContactLabel.trim();
    if (changed('preferredChannel') && form.preferredChannel) patch.preferredChannel = form.preferredChannel;
    if (changed('email')) patch.email = form.email.trim();
    // Направление шлём, только когда менеджер его выбрал: бэкенд трактует
    // пришедший direction как подтверждение (directionConfirmed=true).
    if (changed('direction') && form.direction) patch.direction = form.direction;
    if (changed('comment')) patch.comment = form.comment.trim();
    if (leadFields.length && draftChanged(leadFields, cfDraft, app.customFields)) patch.customFields = draftToPayload(leadFields, cfDraft);
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await updateApplication(app.id, patch as any);
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
        <EditField label={t('app.field.comment')} wide error={err('comment')}>
          <textarea
            className={`crm-textarea${err('comment') ? ' input-error' : ''}`}
            value={form.comment}
            onChange={(e) => set({ comment: e.target.value })}
            rows={3}
            maxLength={2000}
            style={{ resize: 'none' }}
            data-testid="edit-comment"
          />
        </EditField>
      }
    >
      <EditField label={t('app.field.fullName')} error={err('fullName')}>
        <input className={`crm-input${err('fullName') ? ' input-error' : ''}`} value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} maxLength={120} data-testid="edit-fullname" />
      </EditField>
      <EditField label={t('app.field.birthday')} error={err('birthday')}>
        <CrmDatePicker
          className={`crm-input${err('birthday') ? ' input-error' : ''}`}
          value={form.birthday}
          onChange={(v) => set({ birthday: v })}
          min={dobBounds.min}
          max={dobBounds.max}
        />
      </EditField>
      <EditField label={t('app.field.country')}>
        <CrmSelect className="crm-select" value={form.country} onChange={(e) => set({ country: e.target.value as Country | '' })} data-testid="edit-country">
          <option value="">—</option>
          <LookupOptions kind="COUNTRY" current={form.country || null} />
        </CrmSelect>
      </EditField>
      <EditField label={t('app.field.mainPhone')} error={err('phone')}>
        <PhoneInput value={form.phone} onChange={(v) => set({ phone: v })} error={!!err('phone')} testId="edit-phone" />
      </EditField>
      <EditField label={t('app.field.whatsapp')} error={err('whatsappPhone')}>
        <label className="crm-checkbox-label" style={{ marginBottom: sameWa ? 0 : 8 }}>
          <input
            type="checkbox"
            className="crm-checkbox"
            checked={sameWa}
            onChange={(e) => {
              setSameWa(e.target.checked);
              if (!e.target.checked && !phoneHasOwnDigits(form.whatsappPhone)) set({ whatsappPhone: '' });
            }}
            data-testid="edit-wa-same"
          />
          {t('leads.field.sameAsPhone')}
        </label>
        {!sameWa && (
          <PhoneInput value={form.whatsappPhone} onChange={(v) => set({ whatsappPhone: v })} error={!!err('whatsappPhone')} testId="edit-whatsapp" />
        )}
      </EditField>
      <EditField label={t('app.field.secondaryPhoneHint')} error={err('secondaryPhone')}>
        <PhoneInput value={form.secondaryPhone} onChange={(v) => set({ secondaryPhone: v })} error={!!err('secondaryPhone')} testId="edit-secondary-phone" />
      </EditField>
      <EditField label={t('app.field.secondaryLabel')}>
        <input
          className="crm-input"
          value={form.secondaryContactLabel}
          onChange={(e) => set({ secondaryContactLabel: e.target.value })}
          placeholder={t('app.field.secondaryLabelPh')}
        />
      </EditField>
      <EditField label={t('app.field.preferredChannel')}>
        <CrmSelect className="crm-select" value={form.preferredChannel} onChange={(e) => set({ preferredChannel: e.target.value })}>
          <option value="">—</option>
          <LookupOptions kind="CONTACT_CHANNEL" />
        </CrmSelect>
      </EditField>
      <EditField label={t('userDetail.field.email')} error={err('email')}>
        <input className={`crm-input${err('email') ? ' input-error' : ''}`} type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} data-testid="edit-email" />
      </EditField>
      {/* Единственное место, где направление лида с лендинга вообще можно
          проставить. Без него заявка навсегда оставалась бы
          directionConfirmed=false и не попадала бы ни в срез дашборда
          «по направлениям», ни в фильтр списка. */}
      <EditField label={t('app.field.direction')}>
        <CrmSelect className="crm-select" value={form.direction} onChange={(e) => set({ direction: e.target.value as Direction | '' })} data-testid="edit-direction">
          <option value="">{t('app.direction.notChosen')}</option>
          <DirectionOptions current={form.direction || null} />
        </CrmSelect>
      </EditField>
      {/* QA-3 (BUG-07): источник — в карточке, как и в «Новом лиде». */}
      <EditField label={t('app.field.source')}>
        <CrmSelect className="crm-select" value={form.source} onChange={(e) => set({ source: e.target.value })} disabled={sourceLocked} data-testid="edit-source">
          <LookupOptions kind="LEAD_SOURCE" current={form.source || null} only={L.staffSources} />
        </CrmSelect>
        {sourceLocked && <div className="form-hint-text">{t('leads.source.locked')}</div>}
      </EditField>
      <CustomFieldInputs
        fields={leadFields}
        draft={cfDraft}
        onChange={(k, v) => setCfDraft((d) => ({ ...d, [k]: v }))}
        errors={cfErrors}
        showErrors={showErrors}
      />
    </EditForm>
  );
}
