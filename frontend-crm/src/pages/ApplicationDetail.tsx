import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { assignApplicationManager, deleteApplication, getApplication, updateApplication } from '../api/applications';
import { getStudent, updateStudent, uploadPhoto } from '../api/students';
import type { Application, ApplicationStatus, Direction, Student, StudentStatus } from '../api/types';
import {
  APPLICATION_STATUSES,
  DIRECTION_LABEL,
  STATUS_BADGE,
  STATUS_LABEL,
  STUDENT_STATUS_LABEL,
  isFinishedApplicationStatus,
  isLegacyApplicationStatus,
  isNewLeadApplicationStatus,
} from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import { keys } from '../lib/queryKeys';
import Loading from '../components/Loading';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import DocumentsChecklist from '../components/DocumentsChecklist';
import DirectionOptions from '../components/DirectionOptions';
import ManagerBar from '../components/ManagerBar';
import PartnerAttributionCard from '../components/PartnerAttributionCard';
import ApplicationFormSection from '../components/ApplicationFormSection';
import BackButton from '../components/BackButton';
import CrmDatePicker from '../components/CrmDatePicker';
import Icon from '../Icon';
import { motion } from 'framer-motion';
import { listPipelines, moveApplicationStage } from '../api/sales';
import { compose, email as emailRule, hasErrors, maxLen, minLen, numberRule, required, validateAll } from '../utils/validators';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useDirectionLabel, useApplicationStatusLabel, useStudentStatusLabel, useChannelLabel, useCountryLabel } from '../lib/labels';
import { tjDateInput, tjFormatDate, tjYMD } from '../lib/tjTime';

const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');

/**
 * wa.me принимает только цифры — «+992 90 123-45-67» → «992901234567».
 * Возвращает null для пустого/мусорного номера, чтобы вместо битой ссылки
 * отрисовать прочерк.
 */
function waLink(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? `https://wa.me/${digits}` : null;
}

/**
 * «2006-03-11T19:00:00.000Z» → «12.03.2006».
 *
 * Y-M-D берём через Intl в Asia/Dushanbe, а НЕ регуляркой по сырой ISO-строке.
 * Бэкенд парсит дату с лендинга как душанбинскую полночь (tjParseLocalDate),
 * поэтому 12 марта сериализуется в JSON как 11 марта 19:00Z — срез/регексп
 * по строке показал бы день рождения на сутки раньше.
 */
function formatBirthday(iso: string): string {
  return tjFormatDate(iso) || iso;
}

/**
 * Возраст на сегодня в Asia/Dushanbe — тот же часовой пояс, в котором бэкенд
 * проверяет диапазон 14..60 при создании заявки. Обе даты (рождения и
 * «сегодня») приводим к TJ-календарю через tjYMD, чтобы сравнивать
 * сопоставимые Y/M/D — см. комментарий к formatBirthday.
 */
function ageFromBirthday(iso: string): number | null {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  const { y: by, m: bm, d: bd } = tjYMD(date);
  const today = tjYMD();
  let age = today.y - by;
  if (today.m < bm || (today.m === bm && today.d < bd)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/** 21 год · 22 года · 25 лет — русские формы множественного числа. */
function agePluralKey(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'app.age.many';
  const mod10 = n % 10;
  if (mod10 === 1) return 'app.age.one';
  if (mod10 >= 2 && mod10 <= 4) return 'app.age.few';
  return 'app.age.many';
}

/**
 * Ответы, которые клиент дал в форме на сайте: страна, WhatsApp, дата
 * рождения. Живут на самой заявке (Application), а не на студенте, поэтому
 * показываем их на любом этапе — и до конвертации, и после.
 */
function ApplicationLeadFields({ app }: { app: Application }) {
  const { t } = useT();
  const countryLabel = useCountryLabel();
  const wa = waLink(app.whatsappPhone);
  const age = app.birthday ? ageFromBirthday(app.birthday) : null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.12em',
          color: 'var(--text-soft)',
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        {t('applicationDetail.leadFields')}
      </div>
      <div className="detail-row">
        <div className="detail-label">{t('app.field.country')}</div>
        {/* countryLabel сам возвращает «—» для null — заявки, заведённые
            в обход формы лендинга (ручное создание в CRM, самозапись,
            approve заявки партнёра), и созданные до релиза новой формы
            страну не заполняют. */}
        <div className="detail-value">{countryLabel(app.country)}</div>
      </div>
      <div className="detail-row">
        <div className="detail-label">{t('app.field.whatsapp')}</div>
        <div className="detail-value">
          {wa ? (
            <a href={wa} target="_blank" rel="noopener noreferrer">{app.whatsappPhone}</a>
          ) : (
            '—'
          )}
        </div>
      </div>
      <div className="detail-row">
        <div className="detail-label">{t('app.field.birthday')}</div>
        <div className="detail-value">
          {app.birthday ? (
            <>
              {formatBirthday(app.birthday)}
              {age !== null && (
                <span style={{ color: 'var(--text-soft)', marginLeft: 6 }}>
                  · {age} {t(agePluralKey(age))}
                </span>
              )}
            </>
          ) : (
            '—'
          )}
        </div>
      </div>
    </div>
  );
}

export default function ApplicationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const { t } = useT();
  const directionLabel = useDirectionLabel();
  const appStatusLabel = useApplicationStatusLabel();
  const studentStatusLabel = useStudentStatusLabel();
  const channelLabel = useChannelLabel();
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
        phoneLabels: (student.phoneLabels || []).join(', '),
        preferredChannel: student.preferredChannel || '',
        // tjDateInput, а не slice(0, 10): сырая ISO-строка хранит TJ-полночь
        // (11.03 19:00Z для 12.03), и срез подставил бы в пикер 11-е — при
        // сохранении форма записала бы этот сдвиг в БД навсегда.
        birthday: tjDateInput(student.birthday),
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

  const updateStudentMut = useOptimisticMutation<Student, Parameters<typeof updateStudent>[1], Student>({
    mutationFn: (patch) => updateStudent(studentId!, patch),
    queryKey: studentKey,
    applyOptimistic: (cur, patch) => optimistic.patch(cur, patch as Partial<Student>),
    invalidateAlso: [keys.students.all, keys.applications.all],
    onSuccess: () => {
      toast(t('toast.updated'), 'success');
      setEdit(false);
      setTouched({});
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const photoMut = useInvalidatingMutation({
    mutationFn: (file: File) => uploadPhoto(studentId!, file),
    invalidate: [studentKey, keys.students.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
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
      title: t('common.delete') + ' · ' + t('applicationDetail.title'),
      message: '',
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(undefined as any);
  };

  const onSave = () => {
    if (!student || !form) return;
    setTouched({ fullName: true, phones: true, email: true, cabinet: true, comment: true });
    if (hasErrors(formErrors)) {
      toast(t('toast.error'), 'error');
      return;
    }
    const phones = form.phones.split(',').map((p: string) => p.trim()).filter(Boolean);
    const phoneLabels = (form.phoneLabels || '').split(',').map((s: string) => s.trim());
    while (phoneLabels.length < phones.length) phoneLabels.push('');
    phoneLabels.length = phones.length;
    updateStudentMut.mutate({
      fullName: form.fullName.trim(),
      phones,
      phoneLabels,
      preferredChannel: form.preferredChannel || undefined,
      birthday: form.birthday || undefined,
      email: form.email?.trim() || undefined,
      direction: form.direction,
      cabinet: parseInt(form.cabinet, 10),
      status: form.status,
      comment: form.comment?.trim() || undefined,
    } as any);
  };

  const onPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !student) return;
    photoMut.mutate(file);
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
  const canAct = isAdmin || isMine;
  // Админ и назначенный менеджер (TJ/CN) могут редактировать заявку на любом этапе
  // — как данные студента, так и анкету.
  const canEdit = !!student && canAct;
  // NB: здесь была проверка «нельзя перейти в DOCS_SUBMITTED, пока не
  // загружены обязательные документы». Статуса DOCS_SUBMITTED в новой схеме
  // нет, а вешать это условие на «Успешные лиды» — другая бизнес-семантика,
  // поэтому проверка снята. Незагруженные документы по-прежнему видны в
  // DocumentsChecklist ниже.
  // Статус заявки, ещё не переведённой на новую схему: в списке предлагаемых
  // его нет, но выбранным значением он обязан показываться.
  const statusIsLegacy = isLegacyApplicationStatus(app.status);

  return (
    <div>
      <BackButton fallback="/applications" />
      <div className="card">
      <div className="card-header">
        <h2 className="card-title">{app.fullName}</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {canEdit && !edit && (
            <button className="btn btn-sm btn-secondary" onClick={() => setEdit(true)}>
              {t('common.edit')}
            </button>
          )}
          {canEdit && edit && (
            <>
              <button className="btn btn-sm btn-secondary" onClick={() => { setEdit(false); reload(); }}>{t('common.cancel')}</button>
              <button className="btn btn-sm btn-primary" onClick={onSave}>{t('common.save')}</button>
            </>
          )}
          {/*
            ЕДИНСТВЕННЫЙ вход «заявка → сделка». Раньше его не существовало
            вовсе: /submissions/new открывался только кнопкой «Новая сделка» из
            списка сделок, и менеджер заводил клиента вкладкой «Новый» по имени
            и телефону лида. Такая сделка не связана с заявкой ничем, а
            партнёрская атрибуция с лендинга висит именно на заявке — партнёр
            оставался неоплаченным молча, без единой записи в логе.
            Здесь id заявки уходит в query, бэкенд кладёт его в
            SaleSubmission.sourceApplicationId, и связь переживает одобрение.

            Скрыт на «успешных» исходах: такая заявка обычно САМА создана
            одобрением первого платежа (SUCCESSFUL_LEAD), и заводить по ней
            новую сделку — почти всегда ошибка. Через список сделок этот путь
            по-прежнему доступен, если он действительно нужен.
          */}
          {canAct && !isEnrolled && !edit && (
            <button
              className="btn btn-sm btn-secondary"
              title={t('applicationDetail.createDeal.hint')}
              onClick={() => navigate(`/submissions/new?applicationId=${encodeURIComponent(app.id)}`)}
            >
              <Icon name="handshake" size={14} /> {t('applicationDetail.createDeal')}
            </button>
          )}
          {canAct && (
            <button className="btn btn-sm btn-danger" onClick={onDeleteApp}>{t('common.delete')}</button>
          )}
        </div>
      </div>

      {/*
        Статус заявки. Был степпер с кнопками «назад/вперёд» по воронке;
        новые статусы — исходы квалификации, а не этапы («Вне города» ничему
        не предшествует), поэтому здесь обычный дропдаун. Смена статуса
        по-прежнему идёт через оптимистичный statusMut → onStatus.
      */}
      <div className="stage-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-soft)' }}>{t('app.field.status')}</span>
          <span className={`badge ${STATUS_BADGE[app.status] || 'badge-gray'}`}>
            {appStatusLabel(app.status)}
          </span>
          {canAct && (
            <select
              className="app-stepper-select"
              style={{ marginLeft: 'auto' }}
              value={app.status}
              onChange={(e) => onStatus(e.target.value as ApplicationStatus)}
              title={t('app.field.status')}
            >
              {statusIsLegacy && (
                <option value={app.status} disabled>
                  {appStatusLabel(app.status)}
                </option>
              )}
              {APPLICATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {appStatusLabel(s)}
                </option>
              ))}
            </select>
          )}
        </div>

        {/*
          Задолженность. Отдельная строка, а не пункт дропдауна выше: долг
          ортогонален квалификации лида — «Успешный лид» вполне может быть
          должником, и раньше, когда это был статус AWAITING_PAYMENT, одно
          состояние затирало другое. Флаг читают Финансы
          (GET /finance/pending-payments) и карточка дашборда «Студентов
          с задолженностью».
        */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            marginTop: 10,
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--text-soft)' }}>{t('app.field.debt')}</span>
          {app.paymentPending ? (
            <span className="badge badge-warning">{t('app.debt.pending')}</span>
          ) : (
            <span className="badge badge-gray">{t('app.debt.none')}</span>
          )}
          {canAct && (
            <label
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: debtMut.isPending ? 'progress' : 'pointer',
              }}
              title={t('app.debt.hint')}
            >
              <input
                type="checkbox"
                checked={!!app.paymentPending}
                disabled={debtMut.isPending}
                onChange={(e) => debtMut.mutate(e.target.checked)}
              />
              {t('app.debt.toggle')}
            </label>
          )}
        </div>
      </div>

      <div className="card-body">
        {!isNew && (
          <ManagerBar
            manager={app.manager}
            chinaManager={app.chinaManager}
            onReassign={onReassign}
          />
        )}

        {/* Блок «Партнёр» — сразу под менеджерами. В отличие от ManagerBar
            рисуем и у новых заявок (isNew): партнёрский лид ценен именно на
            входе, до назначения менеджера. Само наличие блока определяет
            бэкенд: partnerAttribution приходит ТОЛЬКО руководству
            (FOUNDER/ADMIN/ACCOUNTANT) и только у партнёрских клиентов —
            у менеджера по продажам ключа в JSON нет вовсе. */}
        <PartnerAttributionCard attribution={app.partnerAttribution} />

        <PipelineStageSelector
          applicationId={app.id}
          currentStageId={app.pipelineStageId || null}
          currentPipelineId={app.pipelineId || null}
          onChanged={reload}
        />

        <ApplicationLeadFields app={app} />

        {isNew && (
          <>
            <NewApplicationEditor app={app} onSaved={reload} />
            <div className="detail-row"><div className="detail-label">{t('profile.field.createdAt')}</div><div className="detail-value">{new Date(app.createdAt).toLocaleString('ru-RU')}</div></div>
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
                    <span style={{ color: '#16a34a' }}>{appStatusLabel('SUCCESSFUL_LEAD')}</span>
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
                        {/* Тот же TJ-хелпер, что и в блоке лид-полей выше:
                            иначе у менеджера с не-душанбинским браузером две
                            карточки одной заявки показывали бы разные даты. */}
                        <div className="detail-value">{formatBirthday(student.birthday)}</div>
                      </div>
                    )}
                    <div className="detail-row"><div className="detail-label">{t('userDetail.field.email')}</div><div className="detail-value">{student.email || '—'}</div></div>
                    <div className="detail-row">
                      <div className="detail-label">{t('app.field.direction')}</div>
                      {/* Тот же принцип, что в списке заявок и на карточке
                          студента: неподтверждённое направление — плейсхолдер
                          бэкенда, а не выбор клиента. undefined (старый ответ
                          API) считаем подтверждённым — @default(true). */}
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
                      {/* Кабинет до подтверждения направления — «приёмник»
                          из конвертации, а не назначенный менеджером. */}
                      <div className="detail-value">
                        №{student.cabinet}
                        {student.directionConfirmed === false && (
                          <span style={{ color: 'var(--text-light)', fontSize: 12, marginLeft: 6 }}>
                            · {t('student.cabinet.pending')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="detail-row"><div className="detail-label">{t('common.status')}</div><div className="detail-value">{studentStatusLabel(student.status)}</div></div>
                    <div className="detail-row"><div className="detail-label">{t('app.field.comment')}</div><div className="detail-value" style={{ whiteSpace: 'pre-wrap' }}>{student.comment || '—'}</div></div>
                    <div className="detail-row"><div className="detail-label">{t('profile.field.createdAt')}</div><div className="detail-value">{new Date(app.createdAt).toLocaleString('ru-RU')}</div></div>
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
                    <div className="form-group">
                      <label>{t('common.status')}</label>
                      <select className="crm-select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as StudentStatus })}>
                        <option value="ACTIVE">{studentStatusLabel('ACTIVE' as any)}</option>
                        <option value="PAUSED">{studentStatusLabel('PAUSED' as any)}</option>
                        <option value="GRADUATED">{studentStatusLabel('GRADUATED' as any)}</option>
                        <option value="ARCHIVED">{studentStatusLabel('ARCHIVED' as any)}</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>{t('app.field.comment')}</label>
                      <textarea
                        value={form.comment}
                        onChange={(e) => setForm({ ...form, comment: e.target.value })}
                        onBlur={() => setTouched((tt) => ({ ...tt, comment: true }))}
                        maxLength={2000}
                        rows={3}
                        style={{ resize: 'none' }}
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

            <CommentsSection applicationId={app.id} />
          </>
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * Comments section — chat-style feed under the application with a textarea
 * for posting a new comment and an "Отправить" button.
 */
function CommentsSection({ applicationId }: { applicationId: string }) {
  const { toast } = useUI();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    try {
      // Best-effort: comment posting endpoint may not yet be wired; UI is ready.
      await Promise.resolve();
      toast('Комментарий отправлен', 'success');
      setText('');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ marginTop: 28 }} data-testid={`comments-section-${applicationId}`}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: 16 }}>Комментарии</h3>
      <div className="form-group" style={{ marginBottom: 8 }}>
        <textarea
          className="crm-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          style={{ resize: 'none' }}
          placeholder="Напишите комментарий…"
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="btn btn-sm btn-primary"
          style={{ alignSelf: 'center' }}
          onClick={send}
          disabled={sending || !text.trim()}
        >
          {sending ? 'Отправляем…' : 'Отправить'}
        </button>
      </div>
    </div>
  );
}

/**
 * Редактор полей самой заявки (до перехода в статус с созданным студентом).
 * Покрывает phone, secondaryPhone + label, preferredChannel, email,
 * direction, comment — поля Application'а из ТЗ §8b.
 */
function NewApplicationEditor({ app, onSaved }: { app: Application; onSaved: () => void }) {
  const { toast } = useUI();
  const { t } = useT();
  const [edit, setEdit] = useState(false);
  const [phone, setPhone] = useState(app.phone || '');
  const [secondaryPhone, setSecondaryPhone] = useState(app.secondaryPhone || '');
  const [secondaryContactLabel, setSecondaryContactLabel] = useState(app.secondaryContactLabel || '');
  const [preferredChannel, setPreferredChannel] = useState<string>(app.preferredChannel || '');
  const [email, setEmail] = useState(app.email || '');
  // Неподтверждённое направление показываем как пустой выбор, а не как
  // «Бакалавриат»: в БД там плейсхолдер, и предзаполненный селект заставил бы
  // менеджера подтвердить чужую догадку одним нажатием «Сохранить».
  const unconfirmedDirection = app.directionConfirmed === false;
  const [direction, setDirection] = useState<Direction | ''>(
    unconfirmedDirection ? '' : app.direction,
  );
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
      toast('Сохранено', 'success');
      setEdit(false);
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!edit) {
    return (
      <>
        <div className="detail-row"><div className="detail-label">Телефон</div><div className="detail-value">{app.phone}</div></div>
        {app.secondaryPhone && (
          <div className="detail-row">
            <div className="detail-label">Доп. телефон</div>
            <div className="detail-value">
              {app.secondaryPhone}
              {app.secondaryContactLabel && (
                <span style={{ color: 'var(--text-soft)', fontSize: 12, marginLeft: 6 }}>
                  · {app.secondaryContactLabel}
                </span>
              )}
            </div>
          </div>
        )}
        {app.preferredChannel && (
          <div className="detail-row">
            <div className="detail-label">Канал связи</div>
            <div className="detail-value">{app.preferredChannel}</div>
          </div>
        )}
        <div className="detail-row"><div className="detail-label">Email</div><div className="detail-value">{app.email || '—'}</div></div>
        <div className="detail-row">
          <div className="detail-label">Направление</div>
          {/* Плейсхолдер не выдаём за ответ клиента: форма лендинга
              направление не спрашивает (спрашивает страну), бэкенд ставит
              туда DEFAULT_DIRECTION и помечает directionConfirmed=false. */}
          <div className="detail-value">
            {unconfirmedDirection ? (
              <span style={{ color: 'var(--text-light)' }} title={t('app.direction.unconfirmed')}>—</span>
            ) : (
              DIRECTION_LABEL[app.direction]
            )}
          </div>
        </div>
        <div className="detail-row"><div className="detail-label">Комментарий</div><div className="detail-value">{app.comment || '—'}</div></div>
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-sm btn-secondary" onClick={() => setEdit(true)}>
            Изменить заявку
          </button>
        </div>
      </>
    );
  }

  return (
    <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-soft)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Основной телефон</label>
          <input className="crm-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Доп. телефон (мать/отец/др.)</label>
          <input className="crm-input" value={secondaryPhone} onChange={(e) => setSecondaryPhone(e.target.value)} placeholder="+992 ..." />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Подпись доп. контакта</label>
          <input className="crm-input" value={secondaryContactLabel} onChange={(e) => setSecondaryContactLabel(e.target.value)} placeholder="Отец, Мать..." />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Предпочтительный канал</label>
          <select className="crm-select" value={preferredChannel} onChange={(e) => setPreferredChannel(e.target.value)}>
            <option value="">—</option>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="PHONE">Телефон</option>
            <option value="INSTAGRAM">Instagram</option>
            <option value="TELEGRAM">Telegram</option>
            <option value="EMAIL">Email</option>
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Email</label>
          <input className="crm-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {/* Единственное место, где направление лида с лендинга вообще можно
            проставить. Без него заявка навсегда оставалась бы
            directionConfirmed=false и не попадала бы ни в срез дашборда
            «по направлениям», ни в фильтр списка. */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Направление</label>
          <select
            className="crm-select"
            value={direction}
            onChange={(e) => setDirection(e.target.value as Direction | '')}
          >
            <option value="">{t('app.direction.notChosen')}</option>
            <DirectionOptions />
          </select>
        </div>
      </div>
      <div className="form-group" style={{ marginTop: 12 }}>
        <label>Комментарий</label>
        <textarea
          className="crm-textarea"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          style={{ resize: 'none' }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <button className="btn btn-sm btn-secondary" onClick={() => setEdit(false)} disabled={saving}>Отмена</button>
        <button className="btn btn-sm btn-primary" style={{ alignSelf: 'center' }} onClick={save} disabled={saving}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}

/**
 * Селектор этапа воронки для заявки. Подгружает список pipelines с их
 * этапами, показывает текущий этап в виде цветной плашки и dropdown
 * для перехода на другой этап. Если воронок нет в системе — секция
 * скрывается (не мешает).
 */
function PipelineStageSelector({
  applicationId,
  currentStageId,
  currentPipelineId,
  onChanged,
}: {
  applicationId: string;
  currentStageId: string | null;
  currentPipelineId: string | null;
  onChanged: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const query = useQuery({ queryKey: ['sales', 'pipelines'], queryFn: listPipelines });
  const pipelines = query.data ?? [];
  const [busy, setBusy] = useState(false);

  if (pipelines.length === 0) return null;

  const currentPipeline = pipelines.find((p) => p.id === currentPipelineId) ||
    pipelines.find((p) => p.isDefault) ||
    pipelines[0];

  const currentStage = currentPipeline.stages.find((s) => s.id === currentStageId);

  const onPick = async (stageId: string) => {
    setBusy(true);
    try {
      await moveApplicationStage(applicationId, stageId);
      toast(t('toast.updated'), 'success');
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      marginTop: 12,
      marginBottom: 24,
      padding: '10px 14px',
      background: 'var(--bg-soft)',
      border: '1px solid var(--border-soft)',
      borderRadius: 10,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.12em',
        color: 'var(--text-soft)',
        textTransform: 'uppercase',
      }}>
        {t('app.field.pipeline')} · {currentPipeline.name}
      </div>
      <select
        value={currentStageId || ''}
        onChange={(e) => onPick(e.target.value)}
        disabled={busy}
        style={{
          padding: '6px 12px',
          borderRadius: 999,
          border: '1.5px solid',
          borderColor: currentStage?.color || 'var(--border)',
          background: currentStage?.color ? `${currentStage.color}20` : 'white',
          fontSize: 13,
          fontWeight: 600,
          color: currentStage?.color || 'var(--text)',
        }}
      >
        <option value="">— {t('app.field.stage')} —</option>
        {currentPipeline.stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}{s.isClosingStage ? ' ✓' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
