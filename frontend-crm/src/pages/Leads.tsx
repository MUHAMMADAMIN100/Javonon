import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignApplicationManager,
  createStaffApplication,
  listApplications,
  listAssignableManagers,
  type CreateStaffApplicationInput,
} from '../api/applications';
import type { Application, ApplicationStatus, Country } from '../api/types';
import { COUNTRIES } from '../api/types';
import { useAuth } from '../store/auth';
import { buildNavCtx } from '../components/navGroups';
import { useT } from '../lib/i18n';
import { useCountryLabel } from '../lib/labels';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import { tjFormatDate } from '../lib/tjTime';
import { useRealtime } from '../realtime';
import { useUI } from '../ui/Dialogs';
import PhoneInput, { COUNTRIES as PHONE_COUNTRIES } from '../components/PhoneInput';
import CrmDatePicker from '../components/CrmDatePicker';
import Pagination from '../components/Pagination';
import Loading from '../components/Loading';
import Icon from '../Icon';
import { MAX_AGE, MIN_AGE, ageFromBirthday, birthdayBounds } from '../utils/validators';

/**
 * Экран «Лиды» — ручной ввод заявок сотрудником (роль «Квалификатор
 * лидов») и раздача их менеджерам.
 *
 * ЛИД — ЭТО ЗАЯВКА (Application), а не отдельная сущность: первый статус
 * заявки так и называется «Новые лиды» (NEW_LEAD). Никакой параллельной
 * таблицы лидов нет и быть не должно — иначе каждый отчёт пришлось бы
 * склеивать из двух источников.
 *
 * Почему отдельный экран, а не кнопка «+» на /applications: человек за
 * этим экраном набирает лиды десятками подряд, со слуха, по телефону. Ему
 * нужна форма, которая после сохранения очищается и возвращает фокус в
 * первое поле, и список, где менеджер назначается прямо в строке — без
 * открытия карточки. Тяжёлый фильтр-стек и широкая таблица /applications
 * этой работе только мешают.
 *
 * Набор полей формы и правила валидации — ТЕ ЖЕ, что у формы лендинга
 * (frontend-landing ApplicationForm + backend CreateApplicationDto), с
 * единственным вычетом: `ref` (реферальный код партнёра). У лида,
 * набранного руками, партнёра нет, и реферальная атрибуция на этом пути
 * не запускается вообще — см. api/applications.ts.
 */

/** Максимумы полей — как на лендинге (там же MAX_NAME/MAX_COMMENT). */
const MAX_NAME = 100;
const MAX_COMMENT = 500;

/**
 * Экран показывает НЕОБРАБОТАННУЮ очередь: статус «Новые лиды». Как только
 * менеджер начал работу, он меняет статус, и строка уходит из очереди
 * сама. Назначение менеджера статус НЕ меняет — назначенный, но ещё не
 * взятый в работу лид остаётся виден, и это правильно.
 *
 * Объект вынесен на уровень модуля: он же участвует в queryKey, и
 * пересоздание на каждый рендер ломало бы кеш react-query.
 */
const LEAD_FILTERS = { status: 'NEW_LEAD' as ApplicationStatus };
const LEADS_KEY = keys.applications.list(LEAD_FILTERS);

const PAGE_SIZE = 25;

/** Коды стран по длине убыв. — «+992» должен выигрывать у «+9…». */
const PHONE_CODES = [...PHONE_COUNTRIES].sort((a, b) => b.code.length - a.code.length);

type FormErrors = Partial<
  Record<'fullName' | 'phone' | 'whatsappPhone' | 'birthday' | 'country' | 'comment', string>
>;

export default function Leads() {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const countryLabel = useCountryLabel();
  const me = useAuth((s) => s.user);

  /**
   * Права считаем ТЕМ ЖЕ предикатом, что и пункт меню (buildNavCtx.show):
   * у пользователя с кастомной ролью решает только permission, у
   * остальных — базовая роль. Второй набор правил завёл бы экран, который
   * в меню скрыт, а по прямой ссылке открывается. Настоящая защита — на
   * сервере (RolesGuard + canCreateApplication / canTouchApplicationManager);
   * это UX-слой.
   */
  const nav = useMemo(() => buildNavCtx(me), [me]);
  const canCreate = nav.show('applications:create', nav.isWorkforce);
  const canAssign = nav.show('applications:assign', nav.isWorkforce);

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  // Как на лендинге: у подавляющего большинства клиентов WhatsApp — тот же
  // номер. Галочка стоит по умолчанию, второе поле не рендерится вовсе.
  const [sameWhatsapp, setSameWhatsapp] = useState(true);
  const [whatsappPhone, setWhatsappPhone] = useState('');
  const [birthday, setBirthday] = useState('');
  const [country, setCountry] = useState<Country | ''>('');
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement | null>(null);

  // Границы 14–60 считаем один раз: за время жизни страницы календарные
  // сутки не сдвинутся так, чтобы это было заметно.
  const dobBounds = useMemo(() => birthdayBounds(), []);

  const errors: FormErrors = useMemo(() => {
    const validatePhoneValue = (value: string): string | undefined => {
      const v = (value || '').trim();
      const matched = PHONE_CODES.find((c) => v.startsWith(c.code));
      if (!matched) return t('leads.err.phoneCode');
      const digits = v.slice(matched.code.length).replace(/\D/g, '');
      if (digits.length < matched.minDigits) return t('leads.err.phoneShort');
      if (digits.length > matched.maxDigits) return t('leads.err.phoneLong');
      return undefined;
    };

    const e: FormErrors = {};

    const name = fullName.trim();
    if (!name) e.fullName = t('leads.err.nameRequired');
    else if (name.length < 2) e.fullName = t('leads.err.nameShort');
    else if (name.length > MAX_NAME) e.fullName = t('leads.err.nameLong');
    // Тот же набор букв, что и на лендинге (латиница + кириллица + тадж.).
    else if (!/[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ]/.test(name)) e.fullName = t('leads.err.nameLetters');
    // NO_HTML_RE на бэке: «<» и «>» в ФИО уедут в письма и Telegram.
    else if (/[<>]/.test(name)) e.fullName = t('leads.err.nameChars');

    if (!phone.trim()) e.phone = t('leads.err.phoneRequired');
    else e.phone = validatePhoneValue(phone);

    // Галочка «тот же номер» — поле скрыто, в payload уходит копия phone.
    // Валидировать нечего: phone уже проверен выше.
    if (!sameWhatsapp) {
      if (!whatsappPhone.trim()) e.whatsappPhone = t('leads.err.whatsappRequired');
      else e.whatsappPhone = validatePhoneValue(whatsappPhone);
    }

    if (!birthday) e.birthday = t('leads.err.birthdayRequired');
    else {
      const age = ageFromBirthday(birthday);
      if (age === undefined) e.birthday = t('leads.err.birthdayInvalid');
      else if (age < MIN_AGE || age > MAX_AGE) e.birthday = t('leads.err.birthdayAge');
    }

    if (!country) e.country = t('leads.err.countryRequired');
    if (comment.length > MAX_COMMENT) e.comment = t('leads.err.commentLong');
    else if (/[<>]/.test(comment)) e.comment = t('leads.err.commentChars');

    (Object.keys(e) as (keyof FormErrors)[]).forEach((k) => {
      if (!e[k]) delete e[k];
    });
    return e;
  }, [fullName, phone, sameWhatsapp, whatsappPhone, birthday, country, comment, t]);

  const invalid = (f: keyof FormErrors) => (touched[f] ? errors[f] : undefined);
  const hasErrors = Object.keys(errors).length > 0;

  const resetForm = () => {
    setFullName('');
    setPhone('');
    setSameWhatsapp(true);
    setWhatsappPhone('');
    setBirthday('');
    setCountry('');
    setComment('');
    setTouched({});
    setServerError(null);
  };

  const createMut = useInvalidatingMutation<Application, CreateStaffApplicationInput>({
    mutationFn: createStaffApplication,
    invalidate: [keys.applications.all],
    onSuccess: () => {
      // Форма очищается и фокус возвращается в ФИО: следующий лид
      // набирается сразу, без мыши.
      resetForm();
      toast(t('leads.toast.created'), 'success');
      nameRef.current?.focus();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message;
      setServerError(Array.isArray(msg) ? msg.join(', ') : msg?.toString() || t('toast.error'));
    },
  });

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    setTouched({
      fullName: true,
      phone: true,
      whatsappPhone: true,
      birthday: true,
      country: true,
      comment: true,
    });
    if (hasErrors) return;
    setServerError(null);
    createMut.mutate({
      fullName: fullName.trim(),
      phone: phone.trim(),
      whatsappPhone: (sameWhatsapp ? phone : whatsappPhone).trim() || undefined,
      birthday: birthday || undefined,
      country: (country || undefined) as Country | undefined,
      comment: comment.trim() || undefined,
      // `source` не шлём: в ApplicationSource нет значения «введено
      // сотрудником», выдумывать новое — destructive-изменение схемы.
      // Бэкенд подставит OTHER (STAFF_DEFAULT_SOURCE).
    });
  };

  /* ============================ список ============================ */

  const [page, setPage] = useState(1);

  const leadsQuery = useQuery({
    queryKey: LEADS_KEY,
    queryFn: () => listApplications(LEAD_FILTERS),
  });
  const leads = leadsQuery.data ?? [];

  const managersQuery = useQuery({
    queryKey: ['applications', 'assignable-managers'] as const,
    queryFn: listAssignableManagers,
    // Без applications:assign эндпоинт ответит 403 — не дёргаем вовсе.
    enabled: canAssign,
    staleTime: 5 * 60_000,
  });
  const managers = managersQuery.data ?? [];

  useRealtime({
    'application:new': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
    'application:updated': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
    'application:deleted': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
  });

  // Очередь сжалась (лид перевели в работу / удалили) — не оставляем
  // пользователя на пустой странице.
  useEffect(() => {
    if (!leadsQuery.isSuccess) return;
    const totalPages = Math.max(1, Math.ceil(leads.length / PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [leadsQuery.isSuccess, leads.length, page]);

  const pageItems = leads.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  /**
   * Назначение менеджера — тем же PATCH /applications/:id/manager, что и
   * карточка заявки. Второй путь назначения развёл бы ActivityLog,
   * зеркалирование менеджера на Student и realtime по двум реализациям.
   *
   * Оптимистично: <select> обязан отвечать мгновенно, иначе на десятке
   * лидов подряд экран «залипает». Откат кеша делает сама обёртка
   * (lib/optimistic), тост об ошибке — onError ниже.
   */
  const assignMut = useOptimisticMutation<
    Application,
    { id: string; managerId: string | null },
    Application[]
  >({
    mutationFn: ({ id, managerId }) => assignApplicationManager(id, { managerId }),
    queryKey: LEADS_KEY,
    applyOptimistic: (cur, vars) =>
      optimistic.updateById<Application>(cur, vars.id, { managerId: vars.managerId }),
    invalidateAlso: [keys.applications.all],
    onError: () => toast(t('leads.toast.assignFailed'), 'error'),
  });

  if (!canCreate) {
    return (
      <div className="card">
        <div className="card-body">
          <div className="empty">
            <div className="empty-icon"><Icon name="lock" size={48} /></div>
            {t('leads.noAccess')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">{t('leads.form.title')}</h2>
        </div>
        <div className="card-body">
          <p style={{ marginTop: 0, color: 'var(--text-soft)', fontSize: 13 }}>
            {t('leads.form.hint')}
          </p>
          {serverError && <div className="error-banner">{serverError}</div>}
          <form onSubmit={submit} noValidate>
            <div className="form-group">
              <label>{t('app.field.fullName')} *</label>
              <input
                ref={nameRef}
                autoFocus
                className={`crm-input${invalid('fullName') ? ' input-error' : ''}`}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                onBlur={() => setTouched((s) => ({ ...s, fullName: true }))}
                maxLength={MAX_NAME}
                autoComplete="off"
              />
              {invalid('fullName') && <div className="form-error-text">{errors.fullName}</div>}
            </div>

            <div className="form-grid-2">
              <div className="form-group">
                <label>{t('app.field.phone')} *</label>
                <PhoneInput
                  value={phone}
                  onChange={(v) => {
                    setPhone(v);
                    setTouched((s) => ({ ...s, phone: true }));
                  }}
                  error={!!invalid('phone')}
                />
                {invalid('phone') && <div className="form-error-text">{errors.phone}</div>}
              </div>
              <div className="form-group">
                <label>{t('app.field.whatsapp')}</label>
                <label className="crm-checkbox-label" style={{ marginBottom: sameWhatsapp ? 0 : 10 }}>
                  <input
                    type="checkbox"
                    className="crm-checkbox"
                    checked={sameWhatsapp}
                    onChange={(e) => {
                      setSameWhatsapp(e.target.checked);
                      // Поле скрывается — гасим и значение, иначе прежний
                      // номер остался бы невидимым блокером сабмита.
                      if (e.target.checked) setWhatsappPhone('');
                    }}
                  />
                  {t('leads.field.sameAsPhone')}
                </label>
                {!sameWhatsapp && (
                  <>
                    <PhoneInput
                      value={whatsappPhone}
                      onChange={(v) => {
                        setWhatsappPhone(v);
                        setTouched((s) => ({ ...s, whatsappPhone: true }));
                      }}
                      error={!!invalid('whatsappPhone')}
                    />
                    {invalid('whatsappPhone') && (
                      <div className="form-error-text">{errors.whatsappPhone}</div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="form-grid-2">
              <div className="form-group">
                <label>{t('app.field.birthday')} *</label>
                <CrmDatePicker
                  className={`crm-input${invalid('birthday') ? ' input-error' : ''}`}
                  value={birthday}
                  onChange={(v) => {
                    setBirthday(v);
                    setTouched((s) => ({ ...s, birthday: true }));
                  }}
                  min={dobBounds.min}
                  max={dobBounds.max}
                />
                {invalid('birthday') && <div className="form-error-text">{errors.birthday}</div>}
              </div>
              <div className="form-group">
                <label>{t('app.field.country')} *</label>
                <select
                  className={`crm-select${invalid('country') ? ' input-error' : ''}`}
                  value={country}
                  onChange={(e) => setCountry(e.target.value as Country | '')}
                  onBlur={() => setTouched((s) => ({ ...s, country: true }))}
                >
                  <option value="">{t('leads.field.countryPlaceholder')}</option>
                  {COUNTRIES.map((c) => (
                    <option key={c} value={c}>{countryLabel(c)}</option>
                  ))}
                </select>
                {invalid('country') && <div className="form-error-text">{errors.country}</div>}
              </div>
            </div>

            <div className="form-group">
              <label>
                {t('app.field.comment')}
                <span style={{ float: 'right', color: 'var(--text-light)', fontWeight: 400 }}>
                  {comment.length}/{MAX_COMMENT}
                </span>
              </label>
              <textarea
                className={`crm-textarea${invalid('comment') ? ' input-error' : ''}`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onBlur={() => setTouched((s) => ({ ...s, comment: true }))}
                maxLength={MAX_COMMENT}
              />
              {invalid('comment') && <div className="form-error-text">{errors.comment}</div>}
            </div>

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={resetForm}>
                {t('common.reset')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={createMut.isPending}>
                {createMut.isPending ? t('common.saving') : t('leads.form.submit')}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">{t('leads.list.title')}</h2>
          <span style={{ color: 'var(--text-soft)', fontSize: 13 }}>{leads.length}</span>
        </div>
        <div className="card-body">
          <AnimatePresence mode="wait">
            {leadsQuery.isLoading ? (
              <Loading />
            ) : leads.length === 0 ? (
              <motion.div
                key="empty"
                className="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div className="empty-icon"><Icon name="inbox" size={48} /></div>
                {t('leads.list.empty')}
              </motion.div>
            ) : (
              <motion.div
                key="table"
                className="table-wrap"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('app.field.fullName')}</th>
                      <th>{t('app.field.phone')}</th>
                      <th>{t('app.field.country')}</th>
                      <th>{t('app.field.manager')}</th>
                      <th>{t('reports.col.date')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((a) => (
                      <tr key={a.id}>
                        <td><strong>{a.fullName}</strong></td>
                        <td>{a.phone}</td>
                        <td>
                          {a.country ? (
                            <span className="badge badge-gray">{countryLabel(a.country)}</span>
                          ) : (
                            <span style={{ color: 'var(--text-light)' }}>—</span>
                          )}
                        </td>
                        <td>
                          {canAssign ? (
                            <select
                              className="crm-select"
                              style={{ minWidth: 170 }}
                              value={a.managerId ?? ''}
                              onChange={(e) =>
                                assignMut.mutate({
                                  id: a.id,
                                  // Пустая строка — «снять менеджера»:
                                  // бэкенд ждёт именно null, не ''.
                                  managerId: e.target.value || null,
                                })
                              }
                            >
                              <option value="">{t('leads.manager.unassigned')}</option>
                              {/* Назначенный менеджер может не входить в
                                  справочник (руководитель, деактивированный
                                  сотрудник) — без этой опции <select> молча
                                  показал бы «не назначен» на назначенном
                                  лиде и первое же движение мышью стёрло бы
                                  назначение. */}
                              {a.managerId && !managers.some((m) => m.id === a.managerId) && (
                                <option value={a.managerId}>
                                  {a.manager?.fullName || a.managerId}
                                </option>
                              )}
                              {managers.map((m) => (
                                <option key={m.id} value={m.id}>{m.fullName}</option>
                              ))}
                            </select>
                          ) : a.manager ? (
                            a.manager.fullName
                          ) : (
                            <span style={{ color: 'var(--text-light)' }}>
                              {t('leads.manager.unassigned')}
                            </span>
                          )}
                        </td>
                        <td>{tjFormatDate(a.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pagination
                  page={page}
                  total={leads.length}
                  pageSize={PAGE_SIZE}
                  onChange={setPage}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
