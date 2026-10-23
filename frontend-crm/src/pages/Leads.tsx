import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import CrmSelect from '../components/CrmSelect';
import { AnimatePresence, motion } from 'framer-motion';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  asBulkReassignConflict,
  assignApplicationManager,
  bulkAssignApplicationManager,
  createStaffApplication,
  deleteApplication,
  listApplicationsPage,
  restoreApplication,
  updateApplication,
  listAssignableManagers,
  type AssignableManager,
  type BulkAssignManagerInput,
  type BulkAssignManagerResult,
  type CreateStaffApplicationInput,
  type CreateStaffApplicationResult,
} from '../api/applications';
import type { Application, ApplicationStatus, Country } from '../api/types';
import { APPLICATION_STATUSES, COUNTRIES, STATUS_BADGE, isLegacyApplicationStatus } from '../api/types';
import { useAuth } from '../store/auth';
import { buildNavCtx } from '../components/navGroups';
import {
  applicationRight,
  canAssignToAnyone,
  canSeeAllApplicationsByRole,
  canTransferOthers,
  isLeadStatus,
  roleCan,
  transferScopeOf,
} from '../lib/permissions';
import { useT } from '../lib/i18n';
import { useApplicationStatusLabel, useCountryLabel } from '../lib/labels';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import { tjFormatDate } from '../lib/tjTime';
import { isTouchDevice } from '../lib/touch';
import { useRealtime } from '../realtime';
import { useUI } from '../ui/Dialogs';
import PhoneInput, { COUNTRIES as PHONE_COUNTRIES } from '../components/PhoneInput';
import CrmDatePicker from '../components/CrmDatePicker';
import Pagination from '../components/Pagination';
import Loading from '../components/Loading';
import Icon from '../Icon';
import PeriodFilter from '../components/PeriodFilter';
import ActiveFilterChips, { fmtDay } from '../components/ActiveFilterChips';
import { labelRanks, SortSelect, SortTh, useTableSort } from '../components/TableSort';
import SearchField, { useUrlSearch } from '../components/SearchField';
import ListTotal from '../components/ListTotal';
import { dateParam, enumParam, stringParam, useUrlListState } from '../lib/useUrlListState';
import { MAX_AGE, MIN_AGE, ageFromBirthday, birthdayBounds } from '../utils/validators';
import DismissedMark from '../components/DismissedMark';

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
 * С 23.10.2026 (решения основателя):
 *  • в окне лида — «Менеджер» (кому лид; не выбрали — лид автора) и
 *    «Статус» (сразу перевести дальше «Новый лид»);
 *  • список показывает лиды ВСЕХ статусов, с фильтром «Статус», и грузится
 *    постранично с сервера, как «Заявки»: записей — тысячи;
 *  • лид, закреплённый за другим менеджером, меняют только основатель и
 *    роли с «… — передача чужих» (lib/permissions canTransferOthers).
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

const PAGE_SIZE = 25;

/** То же значение, что понимает бэкенд: заявки вообще без менеджера. */
const UNASSIGNED_MANAGER = 'none';

/** Все значения статуса, включая старые, — для порядка сортировки по подписи. */
const STATUS_SORT_VALUES = Object.keys(STATUS_BADGE) as ApplicationStatus[];

/** Коды стран по длине убыв. — «+992» должен выигрывать у «+9…». */
const PHONE_CODES = [...PHONE_COUNTRIES].sort((a, b) => b.code.length - a.code.length);

type FormErrors = Partial<
  Record<'fullName' | 'phone' | 'whatsappPhone' | 'birthday' | 'country' | 'comment', string>
>;

/** Страница списка с сервера. */
type LeadsPage = { items: Application[]; total: number };

/** Правка лида: поля (без контактов у ставшего студентом), менеджер — отдельным запросом. */
type EditVars = {
  id: string;
  patch: Partial<Application>;
  /** undefined — менеджер не меняется; null — снять. */
  managerId?: string | null;
  /** «Снять себя»: тогда сначала поля — без себя свой лид потом не виден. */
  dropSelf?: boolean;
};

export default function Leads() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const countryLabel = useCountryLabel();
  const statusLabel = useApplicationStatusLabel();
  const me = useAuth((s) => s.user);

  /**
   * Права считаем ТЕМ ЖЕ предикатом, что и пункт меню (buildNavCtx.show):
   * у пользователя с кастомной ролью решает только permission, у
   * остальных — базовая роль. Второй набор правил завёл бы экран, который
   * в меню скрыт, а по прямой ссылке открывается. Настоящая защита — на
   * сервере (RolesGuard + canCreateApplication / managerSlotChangeError);
   * это UX-слой.
   */
  const nav = useMemo(() => buildNavCtx(me), [me]);
  // Права «Лиды — …» (Настройки → Роли); у сотрудника без роли — должность.
  const canView = nav.show('leads:read', nav.isWorkforce);
  const canCreate = nav.show('leads:create', nav.isWorkforce);
  // Список — лиды всех статусов: дальше «Нового лида» запись — заявка, и
  // права у неё «Заявки — …». Назначать — хоть по одному из видов.
  const canAssignAny = nav.show('leads:assign', nav.isWorkforce) || roleCan(me, 'applications:assign', false);
  const canDeleteAnyKind = roleCan(me, ['leads:delete', 'applications:delete']);
  /** Видны ли не только «Новые лиды»: без «Заявки — просмотр» сервер их не отдаёт. */
  const seesApplications = roleCan(me, 'applications:read');
  // В окне: отдать новый лид другому — тот, кто раздаёт лиды (сервер —
  // canReassignApplicationManager); остальные создают лид на себя.
  const canPickManager = canAssignToAnyone(me, 'NEW_LEAD');
  // Статус в окне — кто переводит лиды в работу и потом увидит заявку: иначе
  // лид с другим статусом для его роли уже заявка, и он пропал бы из виду.
  const canPickStatus = roleCan(me, 'leads:update') && seesApplications;

  const isMineRow = (a: Application) =>
    !!me?.id && (a.managerId === me.id || a.chinaManagerId === me.id);
  /**
   * Менять менеджера строки: «Назначение менеджера» её вида; лид,
   * закреплённый за коллегой, — только с «Передачей чужих» (сервер —
   * managerSlotChangeError).
   */
  const canAssignRow = (a: Application) =>
    applicationRight(me, a.status, 'assign') &&
    (!a.managerId || a.managerId === me?.id || canTransferOthers(me, transferScopeOf(a.status)));
  const canEditRow = (a: Application) => applicationRight(me, a.status, 'update');
  /** Удалить — свой или с назначением его вида (руководство); сервер — ensureCanDelete. */
  const canDeleteRow = (a: Application) =>
    applicationRight(me, a.status, 'delete') &&
    (roleCan(me, `${transferScopeOf(a.status)}:assign`, canSeeAllApplicationsByRole(me)) || isMineRow(a));

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  // Как на лендинге: у подавляющего большинства клиентов WhatsApp — тот же
  // номер. Галочка стоит по умолчанию, второе поле не рендерится вовсе.
  const [sameWhatsapp, setSameWhatsapp] = useState(true);
  const [whatsappPhone, setWhatsappPhone] = useState('');
  const [birthday, setBirthday] = useState('');
  const [country, setCountry] = useState<Country | ''>('');
  const [comment, setComment] = useState('');
  /** Кому лид: '' — при создании «мне», при правке — «не назначен». */
  const [managerPick, setManagerPick] = useState('');
  const [leadStatus, setLeadStatus] = useState<ApplicationStatus>('NEW_LEAD');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  /** Форма нового лида живёт в окне: страница начинается сразу со списка. */
  const [formOpen, setFormOpen] = useState(false);
  /** Лид, который правим (то же окно, что «Новый лид»); null — создаём новый. */
  const [editing, setEditing] = useState<Application | null>(null);
  /**
   * Лид уже стал студентом: его контакты живут в карточке студента, и правка
   * полей заявки разошлась бы с ней. В окне — менеджер и статус.
   */
  const contactsLocked = !!editing?.studentId;

  const nameRef = useRef<HTMLInputElement | null>(null);
  const leadsKeyRef = useRef<readonly unknown[]>(['applications', 'list']);

  /**
   * ПОТЕРЯННЫЙ КЛИК. Форма стоит НАД списком, а поле ФИО берёт фокус при
   * загрузке. Клик по галочке (или по <select> менеджера) в списке снимал
   * фокус с ФИО → onBlur помечал поле touched → под ним вырастала ошибка
   * «Введите ФИО» → форма становилась выше, и список уезжал вниз МЕЖДУ
   * mousedown и mouseup. Браузер в таком случае шлёт click не в галочку, а
   * в общего предка (<td>): первый клик по списку после открытия страницы
   * молча пропадал. Найдено браузерным тестом, воспроизводится и руками.
   *
   * Лечится в двух местах:
   *  1) нетронутое пустое поле по blur не валидируем вовсе — ошибку
   *     «обязательное поле» человек увидит при отправке формы (submit
   *     помечает touched всё разом). Ругаться на поле, в которое ничего не
   *     вводили, — и так плохой тон;
   *  2) если blur случился, пока кнопка мыши зажата, показ ошибки
   *     откладываем до её отпускания — к этому моменту click уже доставлен
   *     по адресу, и сдвиг вёрстки ему не страшен.
   */
  const afterPointerRelease = usePointerSafeBlur();

  // Границы 14–60 считаем один раз: за время жизни страницы календарные
  // сутки не сдвинутся так, чтобы это было заметно.
  const dobBounds = useMemo(() => birthdayBounds(), []);

  const errors: FormErrors = useMemo(() => {
    // Контакты студента в этом окне не правятся — и не проверяются.
    if (contactsLocked) return {};
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

    // Правка старого лида: номер, который уже сохранён (с сайта он мог прийти
    // в другом виде), не перепроверяем — проверяем только изменённый.
    const unchanged = (v: string, orig?: string | null) => !!editing && v.trim() === (orig || '').trim();
    if (!phone.trim()) e.phone = t('leads.err.phoneRequired');
    else if (!unchanged(phone, editing?.phone)) e.phone = validatePhoneValue(phone);

    // Галочка «тот же номер» — поле скрыто, в payload уходит копия phone.
    // Валидировать нечего: phone уже проверен выше.
    if (!sameWhatsapp) {
      if (!whatsappPhone.trim()) e.whatsappPhone = t('leads.err.whatsappRequired');
      else if (!unchanged(whatsappPhone, editing?.whatsappPhone)) e.whatsappPhone = validatePhoneValue(whatsappPhone);
    }

    // У нового лида дата и страна обязательны. У старого, где их не было,
    // — нет: иначе исправить опечатку в имени было бы невозможно.
    if (!birthday) {
      if (!editing || editing.birthday) e.birthday = t('leads.err.birthdayRequired');
    } else {
      const age = ageFromBirthday(birthday);
      if (age === undefined) e.birthday = t('leads.err.birthdayInvalid');
      else if (age < MIN_AGE || age > MAX_AGE) e.birthday = t('leads.err.birthdayAge');
    }

    if (!country && (!editing || editing.country)) e.country = t('leads.err.countryRequired');
    if (comment.length > MAX_COMMENT) e.comment = t('leads.err.commentLong');
    else if (/[<>]/.test(comment)) e.comment = t('leads.err.commentChars');

    (Object.keys(e) as (keyof FormErrors)[]).forEach((k) => {
      if (!e[k]) delete e[k];
    });
    return e;
  }, [fullName, phone, sameWhatsapp, whatsappPhone, birthday, country, comment, editing, contactsLocked, t]);

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
    setManagerPick('');
    setLeadStatus('NEW_LEAD');
    setTouched({});
    setServerError(null);
  };

  /**
   * Введено ли в форму хоть что-то. От этого зависит, закрывать окно молча
   * или переспросить: лид набирают со слуха по телефону, и случайный клик
   * мимо окна не должен стирать набранное. У телефона считаем цифры ПОСЛЕ
   * кода страны — сам код («+992») подставляет поле, это не ввод человека.
   */
  const formDirty = useMemo(() => {
    const ownDigits = (value: string) => {
      const v = (value || '').trim();
      const code = PHONE_CODES.find((c) => v.startsWith(c.code));
      return (code ? v.slice(code.code.length) : v).replace(/\D/g, '').length > 0;
    };
    return (
      !!fullName.trim() ||
      ownDigits(phone) ||
      ownDigits(whatsappPhone) ||
      !!birthday ||
      !!country ||
      !!comment.trim()
    );
  }, [fullName, phone, whatsappPhone, birthday, country, comment]);

  const openForm = () => {
    resetForm();
    setEditing(null);
    setFormOpen(true);
  };

  /** Изменить лид: то же окно, поля заполнены текущими данными. */
  const openEdit = (a: Application) => {
    resetForm();
    setEditing(a);
    setFullName(a.fullName || '');
    setPhone(a.phone || '');
    const wa = a.whatsappPhone || '';
    setSameWhatsapp(!wa || wa === a.phone);
    setWhatsappPhone(wa && wa !== a.phone ? wa : '');
    // Дата рождения хранится UTC-полуночью — календарный день берём срезом.
    setBirthday(a.birthday ? String(a.birthday).slice(0, 10) : '');
    setCountry((a.country as Country) || '');
    setComment(a.comment || '');
    setManagerPick(a.managerId ?? '');
    setLeadStatus(a.status);
    setFormOpen(true);
  };

  /** Esc, клик мимо, крестик и «Отмена» — все закрытия идут через это. */
  const requestCloseForm = async () => {
    if (createMut.isPending || updateMut.isPending) return;
    if (formDirty) {
      const ok = await confirm({
        title: t('leads.form.closeConfirm.title'),
        message: t('leads.form.closeConfirm.message'),
        confirmText: t('leads.form.closeConfirm.ok'),
        danger: true,
      });
      if (!ok) return;
    }
    resetForm();
    setFormOpen(false);
  };

  const updateMut = useInvalidatingMutation<unknown, EditVars>({
    mutationFn: async ({ id, patch, managerId, dropSelf }) => {
      // Менеджера — раньше статуса: пока запись — лид, его меняют по
      // «Лиды — назначение менеджера». Кроме «снять себя»: без себя свой лид
      // уже не виден, поэтому сначала поля и статус.
      const savePatch = () => (Object.keys(patch).length > 0 ? updateApplication(id, patch) : Promise.resolve(null));
      if (managerId !== undefined && !dropSelf) await assignApplicationManager(id, { managerId });
      const res = await savePatch();
      if (managerId !== undefined && dropSelf) await assignApplicationManager(id, { managerId });
      return res;
    },
    invalidate: [keys.applications.all],
    onSuccess: () => {
      resetForm();
      setEditing(null);
      setFormOpen(false);
      toast(t('leads.toast.updated'), 'success');
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message;
      setServerError(Array.isArray(msg) ? msg.join(', ') : msg?.toString() || err?.userMessage || t('toast.error'));
    },
  });

  // Удаление — сразу убираем строку (оптимистично), ошибка — вернётся.
  const dropFromPage = (cur: LeadsPage | undefined, id: string): LeadsPage | undefined =>
    cur && {
      items: optimistic.removeById(cur.items, id),
      total: Math.max(0, cur.total - (cur.items.some((a) => a.id === id) ? 1 : 0)),
    };
  const deleteMut = useOptimisticMutation<unknown, string, LeadsPage>({
    mutationFn: deleteApplication,
    queryKey: () => leadsKeyRef.current,
    applyOptimistic: dropFromPage,
    onSuccess: () => toast(t('leads.toast.deleted'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
    invalidateAlso: [keys.applications.all],
  });
  const restoreMut = useOptimisticMutation<unknown, string, LeadsPage>({
    mutationFn: restoreApplication,
    queryKey: () => leadsKeyRef.current,
    applyOptimistic: dropFromPage,
    onSuccess: () => toast(t('leads.toast.restored'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
    invalidateAlso: [keys.applications.all],
  });
  const onDelete = async (a: Application) => {
    const ok = await confirm({
      title: t('leads.delete.title'),
      message: t('leads.delete.message').replace('{name}', a.fullName),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    unselect(a.id);
    deleteMut.mutate(a.id);
  };

  const createMut = useInvalidatingMutation<CreateStaffApplicationResult, CreateStaffApplicationInput>({
    mutationFn: createStaffApplication,
    invalidate: [keys.applications.all],
    onSuccess: (res) => {
      // Сохранили — окно закрывается, новая строка появляется в списке.
      resetForm();
      setFormOpen(false);
      if (res.duplicate) {
        // С этим номером уже есть открытая заявка — новая не создана, в
        // старую добавлено «повторное обращение»; её менеджер и статус прежние.
        const owner = res.manager?.fullName;
        toast(owner ? t('leads.toast.duplicateOwner').replace('{name}', owner) : t('leads.toast.duplicate'), 'success');
        return;
      }
      if (res.statusError) {
        toast(t('leads.toast.statusFailed').replace('{reason}', res.statusError), 'error');
        return;
      }
      const to = res.managerId && res.managerId !== me?.id
        ? res.manager?.fullName || managers.find((m) => m.id === res.managerId)?.fullName || ''
        : '';
      const st = res.status && !isLeadStatus(res.status) ? statusLabel(res.status) : '';
      const key = to && st ? 'leads.toast.createdToStatus'
        : to ? 'leads.toast.createdTo'
        : st ? 'leads.toast.createdStatus'
        : 'leads.toast.created';
      toast(t(key).replace('{name}', to).replace('{status}', st), 'success');
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message;
      // Нет ответа сервера (сеть, перезапуск) — объясняем, а не «Ошибка».
      setServerError(Array.isArray(msg) ? msg.join(', ') : msg?.toString() || err?.userMessage || t('toast.error'));
    },
  });

  // Поля окна «Менеджер» и «Статус».
  const showManagerField = editing ? applicationRight(me, editing.status, 'assign') : canPickManager;
  /** Лид коллеги без «Передачи чужих»: менеджер виден, но не меняется. */
  const managerLocked = !!editing && !canAssignRow(editing);
  const showStatusField = editing ? canEditRow(editing) && seesApplications : canPickStatus;

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
    const payload = {
      fullName: fullName.trim(),
      phone: phone.trim(),
      whatsappPhone: (sameWhatsapp ? phone : whatsappPhone).trim() || undefined,
      birthday: birthday || undefined,
      country: (country || undefined) as Country | undefined,
      comment: comment.trim() || undefined,
    };
    if (editing) {
      const nextManager = managerPick || null;
      const managerChanged = showManagerField && !managerLocked && nextManager !== (editing.managerId ?? null);
      const statusChanged = showStatusField && leadStatus !== editing.status;
      updateMut.mutate({
        id: editing.id,
        patch: {
          // Правка: пустые поля — очистить (иначе удалить дату или комментарий было бы нельзя).
          ...(contactsLocked
            ? {}
            : {
                ...payload,
                birthday: birthday || '',
                comment: comment.trim(),
                country: (country || null) as Country | null,
              }),
          ...(statusChanged ? { status: leadStatus } : {}),
        } as Partial<Application>,
        managerId: managerChanged ? nextManager : undefined,
        dropSelf: managerChanged && nextManager === null && editing.managerId === me?.id,
      });
      return;
    }
    createMut.mutate({
      ...payload,
      // Не выбрали менеджера — лид того, кто его создаёт (сервер — так же).
      ...(canPickManager && managerPick ? { managerId: managerPick } : {}),
      ...(canPickStatus && leadStatus !== 'NEW_LEAD' ? { status: leadStatus } : {}),
      // `source` не шлём: в ApplicationSource нет значения «введено
      // сотрудником», выдумывать новое — destructive-изменение схемы.
      // Бэкенд подставит OTHER (STAFF_DEFAULT_SOURCE).
    });
  };

  // Esc закрывает окно. Если поверх открыт календарь, список кодов стран или
  // окно подтверждения, Esc принадлежит им — иначе одно нажатие закрывало бы
  // и календарь, и всю форму.
  //
  // Слушаем в фазе ПЕРЕХВАТА (capture) намеренно: календарь и список стран
  // ловят Esc на document и закрываются раньше, чем до window дойдёт всплытие,
  // — обычный обработчик видел бы попап уже закрытым и закрывал окно следом.
  // Найдено браузерным тестом.
  const requestCloseRef = useRef(requestCloseForm);
  requestCloseRef.current = requestCloseForm;
  useEffect(() => {
    if (!formOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const popupOpen = [
        ...document.querySelectorAll('.crm-datepicker-popover, .crm-select-popover, .phone-dropdown, .dialog-card'),
      ].some((el) => !el.classList.contains('lead-modal-card'));
      if (popupOpen) return;
      requestCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [formOpen]);

  /* ============================ список ============================ */

  const [page, setPage] = useState(1);

  // Период — в ссылке: экран лидов открывают из уведомления и с дашборда,
  // и выборка обязана переживать переход в карточку и «назад».
  const { values: periodValues, setValue: setPeriod, reset: resetPeriod } = useUrlListState({
    from: dateParam(),
    to: dateParam(),
    // id менеджера белым списком не проверить (сотрудники грузятся
    // асинхронно) — ограничиваем длину, как в списке заявок.
    manager: stringParam('', 64),
    country: enumParam(COUNTRIES),
    // Список — лиды всех статусов; фильтр сужает до одного.
    status: enumParam(APPLICATION_STATUSES),
    // Потолок — как у бэкенда (200 символов, иначе 400).
    search: stringParam('', 200),
    // «Удалённые» — корзина лидов.
    view: enumParam(['deleted'] as const),
  });
  const trash = periodValues.view === 'deleted';
  // В корзине — только «Восстановить»: без галочек и назначения менеджера.
  const bulkOn = canAssignAny && !trash;
  const { from, to, manager } = periodValues;
  // `country` в этом компоненте уже занято полем формы нового лида,
  // поэтому фильтр списка зовём filterCountry.
  const filterCountry = periodValues.country;
  const filterStatus = periodValues.status;
  const urlSearch = periodValues.search;

  const setUrlSearch = useCallback((v: string) => setPeriod('search', v), [setPeriod]);
  const { input: searchInput, setInput: setSearchInput, clear: clearSearch } = useUrlSearch(urlSearch, setUrlSearch);

  const leadFilters = {
    status: filterStatus || undefined,
    deleted: trash || undefined,
    from: from || undefined,
    to: to || undefined,
    manager: manager || undefined,
    country: filterCountry || undefined,
    search: urlSearch || undefined,
  };
  /** Список сужен фильтром (корзина — режим просмотра, а не фильтр). */
  const narrowed = !!(filterStatus || from || to || manager || filterCountry || urlSearch);

  // Страница, порядок и счётчик — на сервере (как «Заявки»): лидов всех
  // статусов — тысячи. Порядок берём из ссылки (?sort=), где его хранит
  // заголовок таблицы; колонки-списки сервер сортирует по подписям на языке
  // интерфейса — передаём ему их порядок.
  const [searchParams] = useSearchParams();
  const sortParam = searchParams.get('sort') || undefined;
  const sortKey = sortParam?.replace(/^-/, '');
  const ranks =
    sortKey === 'status' ? labelRanks(STATUS_SORT_VALUES, statusLabel)
    : sortKey === 'country' ? labelRanks(COUNTRIES, countryLabel)
    : undefined;
  const pageQuery = { ...leadFilters, page, pageSize: PAGE_SIZE, sort: sortParam, ranks };
  const leadsKey = keys.applications.list(pageQuery);
  // Мутации удаления объявлены выше списка — ключ передаём через ref.
  leadsKeyRef.current = leadsKey;
  const leadsQuery = useQuery({
    queryKey: leadsKey,
    queryFn: () => listApplicationsPage(pageQuery),
    // Каждая буква поиска — новый ключ. Без плейсхолдера таблица на время
    // запроса сменялась бы крутилкой и мигала на каждом нажатии.
    placeholderData: keepPreviousData,
  });
  const leads = leadsQuery.data?.items ?? [];
  const found = leadsQuery.data?.total ?? 0;

  // Для счётчика «Найдено: 12 из 93» — сколько всего без фильтров.
  const totalFilters = { deleted: trash || undefined, page: 1, pageSize: 1 };
  const totalQuery = useQuery({
    queryKey: keys.applications.list(totalFilters),
    queryFn: () => listApplicationsPage(totalFilters),
    enabled: narrowed,
  });

  // Другой фильтр — другая выборка: смотреть её надо с первой страницы.
  // При открытии экрана страница и так первая — лишний вызов безвреден.
  const filtersSig = [filterStatus, from, to, manager, filterCountry, urlSearch, trash].join('|');
  useEffect(() => {
    setPage(1);
  }, [filtersSig]);

  const managersQuery = useQuery({
    queryKey: ['applications', 'assignable-managers'] as const,
    queryFn: listAssignableManagers,
    // Без applications:assign эндпоинт ответит 403 — не дёргаем вовсе.
    enabled: canAssignAny,
    staleTime: 5 * 60_000,
  });
  const managers = managersQuery.data ?? [];

  /**
   * Кого можно выбрать менеджером: раздающему — всех менеджеров, себя тоже
   * (основатель и квалификатор в справочник менеджеров не входят); кто
   * только берёт себе — лишь себя.
   */
  const meOption: AssignableManager | null = me?.id
    ? { id: me.id, fullName: me.fullName || '', role: String((me as any).role || '') }
    : null;
  const pickable = (anyone: boolean): AssignableManager[] => {
    const list = anyone ? managers : [];
    return meOption && !list.some((m) => m.id === meOption.id) ? [meOption, ...list] : list;
  };
  const youSuffix = ` (${t('common.youLower')})`;
  const optionLabel = (m: AssignableManager) => (m.id === me?.id ? m.fullName + youSuffix : m.fullName);

  useRealtime({
    'application:new': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
    'application:updated': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
    'application:deleted': (p: { id?: string } | undefined) => {
      // Удалённый лид выпадает из выбора: иначе пачку отверг бы сервер.
      if (p?.id) unselect(p.id);
      qc.invalidateQueries({ queryKey: keys.applications.all });
    },
    // Массовое назначение шлёт ОДНО событие на пачку (а не application:updated
    // на каждый лид) — иначе 25 лидов = 25 перезапросов списка у каждого.
    'applications:bulk-updated': () => qc.invalidateQueries({ queryKey: keys.applications.all }),
  });

  // Выборка сжалась (лид удалили, сменили фильтр) — не оставляем
  // пользователя на пустой странице.
  useEffect(() => {
    if (!leadsQuery.isSuccess) return;
    const totalPages = Math.max(1, Math.ceil(found / PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [leadsQuery.isSuccess, found, page]);

  const sort = useTableSort<Application>(
    leads,
    [
      { key: 'fullName', label: t('app.field.fullName'), value: (a) => a.fullName },
      { key: 'phone', label: t('app.field.phone'), value: (a) => a.phone },
      { key: 'country', label: t('app.field.country'), value: (a) => (a.country ? countryLabel(a.country) : null) },
      { key: 'status', label: t('common.status'), value: (a) => statusLabel(a.status) },
      { key: 'manager', label: t('app.field.manager'), value: (a) => a.manager?.fullName || null },
      { key: 'createdAt', label: t('reports.col.date'), type: 'date', value: (a) => a.createdAt },
    ],
    { onChange: () => setPage(1) },
  );
  // Строки уже отсортированы и нарезаны сервером; заголовки только меняют ?sort=.
  const pageItems = leads;

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
    LeadsPage
  >({
    mutationFn: ({ id, managerId }) => assignApplicationManager(id, { managerId }),
    queryKey: leadsKey,
    applyOptimistic: (cur, vars) =>
      cur && { ...cur, items: optimistic.updateById<Application>(cur.items, vars.id, { managerId: vars.managerId }) },
    invalidateAlso: [keys.applications.all],
    onError: (e: any) => {
      const msg = e?.response?.data?.message;
      toast(typeof msg === 'string' && msg ? msg : t('leads.toast.assignFailed'), 'error');
    },
  });

  /* ======================= массовое назначение ======================= */

  /**
   * Отмеченные лиды: id → строка, какой её видели при отметке. Храним ID, а
   * не индексы строк: список пересортировывается realtime-событиями, и
   * «строка №3» через секунду — уже другой человек. Выбор живёт поверх
   * страниц: отметил 10 на первой, перешёл на вторую, отметил ещё 5 — в
   * пачке 15. Строку держим целиком: страница приходит с сервера, других
   * строк на экране нет, а вопросу «у кого забираем» нужен менеджер каждой.
   */
  const [selected, setSelected] = useState<Map<string, Application>>(() => new Map());
  const [bulkManagerId, setBulkManagerId] = useState('');
  /** Якорь для Shift+клик — последняя строка, отмеченная вручную. */
  const lastToggledRef = useRef<string | null>(null);

  const unselect = (id: string) =>
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });

  // Пришла свежая страница: отмеченные на ней строки обновляем (менеджер
  // мог смениться), а ту, что стала чужой без «Передачи чужих», из выбора
  // убираем — иначе сервер отверг бы всю пачку из-за неё одной.
  useEffect(() => {
    if (leadsQuery.isPlaceholderData) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const a of leads) {
        if (!next.has(a.id)) continue;
        if (!canAssignRow(a)) next.delete(a.id);
        else next.set(a.id, a);
        changed = true;
      }
      // Тот же объект при отсутствии изменений — иначе эффект крутил бы
      // перерисовку на каждое обновление списка.
      return changed ? next : prev;
    });
    // canAssignRow зависит только от me — он меняется вместе со страницей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, leadsQuery.isPlaceholderData]);

  /** Строки страницы, которые можно отметить: менеджера меняет этот сотрудник. */
  const selectableRows = pageItems.filter(canAssignRow);
  const selectableIds = selectableRows.map((a) => a.id);
  const pageSelectedCount = selectableIds.reduce((n, id) => n + (selected.has(id) ? 1 : 0), 0);
  const pageAllSelected = selectableIds.length > 0 && pageSelectedCount === selectableIds.length;
  const pageSomeSelected = pageSelectedCount > 0 && !pageAllSelected;
  const selectedElsewhere = selected.size - pageSelectedCount;

  const toggleOne = (row: Application, withRange: boolean) => {
    // Якорь читаем ДО setSelected: функция-апдейтер выполнится позже, и
    // к тому моменту ref уже указывал бы на текущую строку.
    const anchorId = lastToggledRef.current;
    setSelected((prev) => {
      const next = new Map(prev);
      const willSelect = !prev.has(row.id);
      // Shift+клик — диапазон от якоря до текущей строки В ПРЕДЕЛАХ страницы.
      if (withRange && anchorId && anchorId !== row.id) {
        const fromIdx = selectableIds.indexOf(anchorId);
        const toIdx = selectableIds.indexOf(row.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const lo = Math.min(fromIdx, toIdx);
          const hi = Math.max(fromIdx, toIdx);
          for (let i = lo; i <= hi; i++) {
            const r = selectableRows[i];
            if (willSelect) next.set(r.id, r);
            else next.delete(r.id);
          }
          return next;
        }
      }
      if (willSelect) next.set(row.id, row);
      else next.delete(row.id);
      return next;
    });
    lastToggledRef.current = row.id;
  };

  /** Галочка в шапке: вся ТЕКУЩАЯ страница, выбор на других не трогаем. */
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      const allOn = selectableRows.length > 0 && selectableRows.every((a) => prev.has(a.id));
      selectableRows.forEach((a) => (allOn ? next.delete(a.id) : next.set(a.id, a)));
      return next;
    });
    lastToggledRef.current = null;
  };

  const clearSelection = () => {
    setSelected(new Map());
    lastToggledRef.current = null;
  };

  /** «Саид — 2, Шахноза — 1»: у кого сейчас лиды, которые собираемся забрать. */
  const formatOwners = (rows: { name: string; count: number }[]) =>
    rows
      .sort((a, b) => b.count - a.count)
      .map((r) => `${r.name} — ${r.count}`)
      .join(', ');

  const askReassign = (opts: { reassign: number; total: number; owners: string; manager: string }) =>
    confirm({
      title: t('leads.bulk.confirm.title'),
      message: t('leads.bulk.confirm.message')
        .replace('{k}', String(opts.reassign))
        .replace('{n}', String(opts.total))
        .replace('{list}', opts.owners)
        .replace('{manager}', opts.manager),
      confirmText: t('leads.bulk.confirm.ok'),
      danger: true,
    });

  // Кому раздавать пачку: раздающему лиды или заявки — всем, иначе себе.
  const bulkOptions = pickable(canAssignToAnyone(me, 'NEW_LEAD') || canAssignToAnyone(me, 'IN_PROCESSING'));

  /**
   * Оптимистично, как и одиночное назначение: строки перекрашиваются сразу,
   * откат при ошибке делает обёртка. Запрос один на всю пачку — см.
   * bulkAssignApplicationManager.
   */
  const bulkMut = useOptimisticMutation<BulkAssignManagerResult, BulkAssignManagerInput, LeadsPage>({
    mutationFn: bulkAssignApplicationManager,
    queryKey: leadsKey,
    applyOptimistic: (cur, vars) => {
      if (!cur) return cur;
      const ids = new Set(vars.ids);
      const m = bulkOptions.find((x) => x.id === vars.managerId);
      return {
        ...cur,
        items: cur.items.map((a) =>
          ids.has(a.id)
            ? {
                ...a,
                managerId: vars.managerId,
                // email в справочнике не приходит; до перечитывания списка он
                // нигде на этом экране не показывается.
                manager: m ? { id: m.id, fullName: m.fullName, email: a.manager?.email ?? '' } : a.manager,
              }
            : a,
        ),
      };
    },
    invalidateAlso: [keys.applications.all],
    onSuccess: (res) => {
      clearSelection();
      // Менеджера сбрасываем намеренно: следующая пачка почти всегда идёт
      // ДРУГОМУ человеку, и оставленное значение — готовая ошибка «отметил
      // и не глядя нажал Назначить».
      setBulkManagerId('');
      toast(
        res.changed > 0
          ? t('leads.bulk.toast.done')
              .replace('{n}', String(res.changed))
              .replace('{manager}', res.manager.fullName)
          : t('leads.bulk.toast.nothing').replace('{manager}', res.manager.fullName),
        'success',
      );
    },
    onError: async (err: any, vars) => {
      // Кеш отстал: пока ставили галочки, коллега назначил часть этих лидов.
      // Сервер ничего не изменил и прислал точную разбивку — спрашиваем по
      // ней и повторяем уже с подтверждением.
      const conflict = asBulkReassignConflict(err);
      if (conflict && !vars.confirmReassign) {
        const ok = await askReassign({
          reassign: conflict.reassignCount,
          total: conflict.total,
          owners: formatOwners(conflict.conflicts.map((c) => ({ name: c.managerName, count: c.count }))),
          manager: bulkOptions.find((m) => m.id === vars.managerId)?.fullName || '',
        });
        if (ok) bulkMut.mutate({ ...vars, confirmReassign: true });
        return;
      }
      const msg = err?.response?.data?.message;
      toast(
        (Array.isArray(msg) ? msg.join(', ') : typeof msg === 'string' ? msg : '') ||
          t('leads.bulk.toast.failed'),
        'error',
      );
    },
  });

  const runBulkAssign = async () => {
    if (!bulkManagerId || selected.size === 0 || bulkMut.isPending) return;
    const target = bulkOptions.find((m) => m.id === bulkManagerId);
    if (!target) return;
    // Отмеченные могут быть на других страницах — берём их из выбора.
    const picked = [...selected.values()];
    if (picked.length === 0) return;

    // Уже закреплённые за ДРУГИМ менеджером — спрашиваем до отправки.
    const taken = picked.filter((a) => a.managerId && a.managerId !== bulkManagerId);
    let confirmReassign = false;
    if (taken.length > 0) {
      const byOwner = new Map<string, { name: string; count: number }>();
      for (const a of taken) {
        const key = a.managerId as string;
        const row = byOwner.get(key) || {
          name: a.manager?.fullName || managers.find((m) => m.id === key)?.fullName || '—',
          count: 0,
        };
        row.count += 1;
        byOwner.set(key, row);
      }
      const ok = await askReassign({
        reassign: taken.length,
        total: picked.length,
        owners: formatOwners([...byOwner.values()]),
        manager: target.fullName,
      });
      if (!ok) return;
      confirmReassign = true;
    }

    bulkMut.mutate({ ids: picked.map((a) => a.id), managerId: bulkManagerId, confirmReassign });
  };

  if (!canView) {
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

  // Варианты менеджера в окне. Создание: «Мне — …» (по умолчанию) и
  // остальные менеджеры. Правка: «Не назначен», нынешний и кого можно выбрать.
  const editOptions = editing ? pickable(canAssignToAnyone(me, editing.status)) : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <AnimatePresence>
        {formOpen && (
          <motion.div
            key="lead-modal"
            className="dialog-backdrop lead-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            // mousedown, а не click: выделил текст в поле и отпустил мышь за
            // краем окна — это не «клик мимо», закрывать нельзя.
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) requestCloseForm();
            }}
          >
            <motion.div
              className="dialog-card lead-modal-card"
              role="dialog"
              aria-modal="true"
              aria-label={editing ? t('leads.form.editTitle') : t('leads.form.title')}
              initial={{ opacity: 0, scale: 0.96, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 16 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="lead-modal-head">
                <h2 className="card-title" style={{ margin: 0 }}>{editing ? t('leads.form.editTitle') : t('leads.form.title')}</h2>
                <button
                  type="button"
                  className="lead-modal-close"
                  aria-label={t('common.close')}
                  data-testid="lead-modal-close"
                  onClick={requestCloseForm}
                >
                  <Icon name="close" size={20} />
                </button>
              </div>
          {contactsLocked && editing ? (
            <div className="lead-student-note" data-testid="lead-student-note">
              <Icon name="school" size={18} />
              <div>
                <strong>{editing.fullName}</strong>
                {editing.phone ? ` · ${editing.phone}` : ''}
                <div>
                  {t('leads.edit.studentNote')}{' '}
                  <Link to={`/applications/${editing.id}`} data-testid="lead-open-card">
                    {t('leads.edit.openCard')}
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <p style={{ marginTop: 0, color: 'var(--text-soft)', fontSize: 13 }}>
              {t('leads.form.hint')}
            </p>
          )}
          {serverError && <div className="error-banner">{serverError}</div>}
          <form onSubmit={submit} noValidate>
            {!contactsLocked && (
              <>
            <div className="form-group">
              <label>{t('app.field.fullName')} *</label>
              <input
                ref={nameRef}
                autoFocus={!isTouchDevice()}
                className={`crm-input${invalid('fullName') ? ' input-error' : ''}`}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                onBlur={() => {
                  if (!fullName.trim()) return;
                  afterPointerRelease(() => setTouched((s) => ({ ...s, fullName: true })));
                }}
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
                <CrmSelect
                  className={`crm-select${invalid('country') ? ' input-error' : ''}`}
                  value={country}
                  onChange={(e) => setCountry(e.target.value as Country | '')}
                  onBlur={() => {
                    if (!country) return;
                    afterPointerRelease(() => setTouched((s) => ({ ...s, country: true })));
                  }}
                >
                  <option value="">{t('leads.field.countryPlaceholder')}</option>
                  {COUNTRIES.map((c) => (
                    <option key={c} value={c}>{countryLabel(c)}</option>
                  ))}
                </CrmSelect>
                {invalid('country') && <div className="form-error-text">{errors.country}</div>}
              </div>
            </div>
              </>
            )}

            {(showManagerField || showStatusField) && (
              <div className="form-grid-2">
                {showManagerField && (
                  <div className="form-group">
                    <label>{t('app.field.manager')}</label>
                    <CrmSelect
                      className="crm-select"
                      value={managerPick}
                      onChange={(e) => setManagerPick(e.target.value)}
                      disabled={managerLocked}
                      data-testid="lead-manager"
                    >
                      {editing ? (
                        <>
                          <option value="">{t('leads.manager.unassigned')}</option>
                          {/* Нынешний менеджер может не входить в справочник
                              (основатель, уволенный) — без него поле молча
                              показало бы «не назначен». */}
                          {editing.managerId && !editOptions.some((m) => m.id === editing.managerId) && (
                            <option value={editing.managerId}>
                              {editing.manager?.fullName || editing.managerId}
                            </option>
                          )}
                          {editOptions.map((m) => (
                            <option key={m.id} value={m.id}>{optionLabel(m)}</option>
                          ))}
                        </>
                      ) : (
                        <>
                          <option value="">{t('leads.field.managerMe').replace('{name}', me?.fullName || '')}</option>
                          {managers.filter((m) => m.id !== me?.id).map((m) => (
                            <option key={m.id} value={m.id}>{m.fullName}</option>
                          ))}
                        </>
                      )}
                    </CrmSelect>
                    {managerLocked && (
                      <div className="form-hint-text" data-testid="lead-manager-locked-hint">{t('managerBar.locked')}</div>
                    )}
                  </div>
                )}
                {showStatusField && (
                  <div className="form-group">
                    <label>{t('common.status')}</label>
                    <CrmSelect
                      className="crm-select"
                      value={leadStatus}
                      onChange={(e) => setLeadStatus(e.target.value as ApplicationStatus)}
                      data-testid="lead-status"
                    >
                      {/* Старый статус выбрать заново нельзя — только увидеть. */}
                      {editing && isLegacyApplicationStatus(editing.status) && (
                        <option value={editing.status} disabled>{statusLabel(editing.status)}</option>
                      )}
                      {APPLICATION_STATUSES.map((s) => (
                        <option key={s} value={s}>{statusLabel(s)}</option>
                      ))}
                    </CrmSelect>
                  </div>
                )}
              </div>
            )}

            {!contactsLocked && (
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
                onBlur={() => {
                  if (!comment) return;
                  afterPointerRelease(() => setTouched((s) => ({ ...s, comment: true })));
                }}
                maxLength={MAX_COMMENT}
              />
              {invalid('comment') && <div className="form-error-text">{errors.comment}</div>}
            </div>
            )}

            <div className="form-actions">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="lead-modal-cancel"
                onClick={requestCloseForm}
                disabled={createMut.isPending}
              >
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-primary" data-testid="lead-modal-save" disabled={createMut.isPending || updateMut.isPending}>
                {createMut.isPending || updateMut.isPending ? t('common.saving') : editing ? t('common.save') : t('leads.form.submit')}
              </button>
            </div>
          </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="card">
        <div className="card-header is-titleless">
          {/* Название страницы стоит в шапке; здесь — счётчик слева и кнопка справа. */}
          <ListTotal
            noun="leads"
            found={found}
            total={totalQuery.data?.total}
            filtered={narrowed}
            testId="leads-total"
          />
          {canCreate && (
            <button type="button" className="btn btn-primary" data-testid="lead-new" onClick={openForm}>
              <Icon name="add" size={18} />
              {t('leads.form.title')}
            </button>
          )}
        </div>
        <div className="card-body">
          <div className="filters">
            {(canDeleteAnyKind || trash) && (
              <CrmSelect
                className="crm-select"
                value={trash ? 'deleted' : ''}
                onChange={(e) => setPeriod('view', (e.target.value || '') as 'deleted' | '')}
                title={t('leads.view.deleted')}
                data-testid="leads-filter-view"
              >
                <option value="">{t('leads.view.active')}</option>
                <option value="deleted">{t('leads.view.deleted')}</option>
              </CrmSelect>
            )}
            {(seesApplications || filterStatus) && (
              <CrmSelect
                className="crm-select"
                value={filterStatus}
                onChange={(e) => setPeriod('status', e.target.value as ApplicationStatus | '')}
                title={t('common.status')}
                data-testid="leads-filter-status"
              >
                <option value="">{t('app.filter.status')}</option>
                {APPLICATION_STATUSES.map((s) => (
                  <option key={s} value={s}>{statusLabel(s)}</option>
                ))}
              </CrmSelect>
            )}
            <CrmSelect
              className="crm-select"
              value={manager}
              onChange={(e) => setPeriod('manager', e.target.value)}
              title={t('app.filter.manager')}
              data-testid="leads-filter-manager"
            >
              <option value="">{t('app.filter.manager')}</option>
              <option value={UNASSIGNED_MANAGER}>{t('leads.manager.none')}</option>
              {pickable(true).map((u) => (
                <option key={u.id} value={u.id}>{optionLabel(u)}</option>
              ))}
            </CrmSelect>
            <CrmSelect
              className="crm-select"
              value={filterCountry}
              onChange={(e) => setPeriod('country', e.target.value as typeof COUNTRIES[number] | '')}
              title={t('app.field.country')}
              data-testid="leads-filter-country"
            >
              <option value="">{t('app.filter.country')}</option>
              {COUNTRIES.map((c) => (
                <option key={c} value={c}>{countryLabel(c)}</option>
              ))}
            </CrmSelect>
            <PeriodFilter
              from={from}
              to={to}
              onFrom={(v) => setPeriod('from', v)}
              onTo={(v) => setPeriod('to', v)}
            />
            {/* Поиск здесь — в строке фильтров, а не отдельной строкой над
                ними, как на других списках: у лидов фильтров немного, и
                справа оставалось пустое место. */}
            <SearchField
              value={searchInput}
              onChange={setSearchInput}
              onClear={clearSearch}
              placeholder={t('leads.search.placeholder')}
              testId="leads-search"
            />
            {(filterStatus || from || to || manager || filterCountry || searchInput) && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  // Поле гасим сразу: недобежавший дебаунс иначе вернул бы
                  // текст обратно в ссылку.
                  setSearchInput('');
                  resetPeriod(['status', 'from', 'to', 'manager', 'country', 'search']);
                }}
              >
                <Icon name="close" size={14} /> {t('common.reset')}
              </button>
            )}
          </div>

          <ActiveFilterChips
            chips={[
              ...(urlSearch
                ? [{
                    key: 'search',
                    label: `${t('list.chip.search')}: «${urlSearch}»`,
                    onClear: clearSearch,
                  }]
                : []),
              ...(filterStatus
                ? [{ key: 'status', label: statusLabel(filterStatus), onClear: () => resetPeriod(['status']) }]
                : []),
              ...(from || to
                ? [{
                    key: 'period',
                    label: from && to
                      ? `${t('list.chip.period')}: ${fmtDay(from)} — ${fmtDay(to)}`
                      : from
                        ? `${t('list.chip.periodFrom')} ${fmtDay(from)}`
                        : `${t('list.chip.periodTo')} ${fmtDay(to)}`,
                    onClear: () => resetPeriod(['from', 'to']),
                  }]
                : []),
              ...(manager
                ? [{
                    key: 'manager',
                    label: manager === UNASSIGNED_MANAGER
                      ? t('leads.manager.none')
                      : pickable(true).find((u) => u.id === manager)?.fullName || t('app.filter.manager'),
                    onClear: () => resetPeriod(['manager']),
                  }]
                : []),
              ...(filterCountry
                ? [{ key: 'country', label: countryLabel(filterCountry), onClear: () => resetPeriod(['country']) }]
                : []),
            ]}
          />

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
                <div className="empty-icon"><Icon name={narrowed ? 'search_off' : 'inbox'} size={48} /></div>
                {/* «Лидов нет» под поиском врало бы: лиды есть, не
                    нашлись именно эти. */}
                <span data-testid="leads-empty">{trash ? t('leads.trash.empty') : narrowed ? t('common.empty') : t('leads.list.empty')}</span>
              </motion.div>
            ) : (
              <motion.div
                key="table"
                className={leadsQuery.isPlaceholderData ? 'list-stale' : undefined}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {/* Панель массового действия. Вне .table-wrap намеренно: у того
                    overflow, а sticky внутри overflow-контейнера липнет к нему,
                    а не к окну, — панель уезжала бы вместе с таблицей.

                    Слот панели есть ВСЕГДА, меняется только содержимое. Если
                    панель появлялась бы с первой галочкой, она сдвигала бы
                    список на свою высоту прямо под курсором: человек отметил
                    строку, а под мышью уже соседняя. Пустой слот заодно
                    подсказывает, что пачку вообще можно назначить разом. */}
                {bulkOn && (
                  // Слот держит место в потоке, панель внутри него на узких
                  // экранах становится fixed (см. index.css): sticky там не
                  // работает — у .main/.app-layout/body стоит overflow-x:hidden.
                  <div className={`leads-bulk-slot${selected.size > 0 ? '' : ' is-idle'}`}>
                  <div
                    className={`leads-bulk-bar${selected.size > 0 ? '' : ' is-idle'}`}
                    role="region"
                    aria-label={t('leads.bulk.region')}
                  >
                    {selected.size === 0 ? (
                      <span className="leads-bulk-hint" data-testid="bulk-hint">
                        <Icon name="checklist" size={18} />
                        {t('leads.bulk.hint')}
                      </span>
                    ) : (
                      <>
                        <span className="leads-bulk-count" data-testid="bulk-count">
                          {t('leads.bulk.selected').replace('{n}', String(selected.size))}
                        </span>
                        {selectedElsewhere > 0 && (
                          <span className="leads-bulk-note">
                            {t('leads.bulk.otherPages').replace('{n}', String(selectedElsewhere))}
                          </span>
                        )}
                        <CrmSelect
                          className="crm-select"
                          aria-label={t('leads.bulk.pickManager')}
                          data-testid="bulk-manager"
                          value={bulkManagerId}
                          onChange={(e) => setBulkManagerId(e.target.value)}
                          disabled={bulkMut.isPending}
                        >
                          <option value="">{t('leads.bulk.pickManager')}</option>
                          {bulkOptions.map((m) => (
                            <option key={m.id} value={m.id}>{optionLabel(m)}</option>
                          ))}
                        </CrmSelect>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm leads-bulk-assign"
                          data-testid="bulk-assign"
                          onClick={runBulkAssign}
                          disabled={!bulkManagerId || bulkMut.isPending}
                        >
                          {bulkMut.isPending ? t('leads.bulk.assigning') : t('leads.bulk.assign')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm leads-bulk-clear"
                          data-testid="bulk-clear"
                          onClick={clearSelection}
                          disabled={bulkMut.isPending}
                        >
                          {t('leads.bulk.clear')}
                        </button>
                      </>
                    )}
                  </div>
                  </div>
                )}

                {/* На телефоне таблица превращается в карточки и <thead> скрыт —
                    галочке «вся страница» нужно своё место. */}
                {bulkOn && selectableIds.length > 0 && (
                  <label className="crm-checkbox-label leads-select-page-mobile">
                    <SelectAllCheckbox
                      checked={pageAllSelected}
                      indeterminate={pageSomeSelected}
                      onChange={togglePage}
                      label={t('leads.bulk.selectPage')}
                    />
                    <span>{t('leads.bulk.selectPage')}</span>
                  </label>
                )}

                <SortSelect sort={sort} />
                <div className="table-wrap">
                <table className="table client-list">
                  <thead>
                    <tr>
                      <SortTh
                        sort={sort}
                        col="fullName"
                        wrapClassName="lead-name-cell"
                        before={
                          bulkOn && (
                            <SelectAllCheckbox
                              checked={pageAllSelected}
                              indeterminate={pageSomeSelected}
                              onChange={togglePage}
                              label={t('leads.bulk.selectPage')}
                              disabled={selectableIds.length === 0}
                            />
                          )
                        }
                      />
                      <SortTh sort={sort} col="phone" />
                      <SortTh sort={sort} col="country" />
                      <SortTh sort={sort} col="status" />
                      <SortTh sort={sort} col="manager" />
                      <SortTh sort={sort} col="createdAt" />
                      <th aria-label={t('common.actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((a) => {
                      const rowAssign = !trash && canAssignRow(a);
                      // Лид коллеги без «Передачи чужих»: менеджер виден, но не меняется.
                      const rowLocked = !trash && !!a.managerId && applicationRight(me, a.status, 'assign') && !rowAssign;
                      const rowOptions = pickable(canAssignToAnyone(me, a.status));
                      return (
                      <tr key={a.id} className={`client-row${selected.has(a.id) ? ' is-selected' : ''}`} data-testid={`lead-row-${a.id}`}>
                        {/* Галочка живёт ВНУТРИ первой ячейки, а не отдельной
                            колонкой: на телефоне td:first-child — это заголовок
                            карточки, и колонка из одних галочек заняла бы его
                            место вместо ФИО. */}
                        <td className="cl-name">
                          <div className="lead-name-cell">
                            {bulkOn && (
                              <input
                                type="checkbox"
                                className="crm-checkbox"
                                checked={selected.has(a.id)}
                                disabled={!rowAssign}
                                title={rowLocked ? t('managerBar.locked') : undefined}
                                aria-label={`${t('leads.bulk.selectRow')}: ${a.fullName}`}
                                // Shift+клик по умолчанию тянет текстовое
                                // выделение через всю таблицу.
                                onMouseDown={(e) => {
                                  if (e.shiftKey) e.preventDefault();
                                }}
                                onChange={(e) =>
                                  toggleOne(a, (e.nativeEvent as MouseEvent).shiftKey === true)
                                }
                              />
                            )}
                            <strong>{a.fullName}</strong>
                          </div>
                        </td>
                        <td data-label={t('app.field.phone')} className="cl-phone">{a.phone || '—'}</td>
                        <td data-label={t('app.field.country')} className={`cl-chip${a.country ? '' : ' is-empty'}`}>
                          {a.country ? (
                            <span className="badge badge-gray">{countryLabel(a.country)}</span>
                          ) : (
                            <span style={{ color: 'var(--text-light)' }}>—</span>
                          )}
                        </td>
                        <td data-label={t('common.status')} className="cl-top">
                          <span className={`badge ${STATUS_BADGE[a.status] ?? 'badge-gray'}`} data-testid="lead-status-badge">
                            {statusLabel(a.status)}
                          </span>
                        </td>
                        <td data-label={t('app.field.manager')} className="td-stack cl-mgr cl-with-label">
                          {bulkOn && rowAssign ? (
                            <CrmSelect
                              className="crm-select"
                              style={{ minWidth: 170 }}
                              value={a.managerId ?? ''}
                              data-testid="lead-row-manager"
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
                              {a.managerId && !rowOptions.some((m) => m.id === a.managerId) && (
                                <option value={a.managerId}>
                                  {a.manager?.fullName || a.managerId}
                                </option>
                              )}
                              {rowOptions.map((m) => (
                                <option key={m.id} value={m.id}>{optionLabel(m)}</option>
                              ))}
                            </CrmSelect>
                          ) : a.manager ? (
                            <span
                              className={rowLocked ? 'lead-manager-locked' : undefined}
                              title={rowLocked ? t('managerBar.locked') : undefined}
                              data-testid={rowLocked ? 'lead-manager-locked' : 'lead-manager-name'}
                            >
                              {a.manager.fullName}
                              <DismissedMark person={a.manager} />
                              {rowLocked && <Icon name="lock" size={14} />}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-light)' }}>
                              {t('leads.manager.unassigned')}
                            </span>
                          )}
                        </td>
                        <td data-label={t('reports.col.date')} className="cl-right">{tjFormatDate(a.createdAt)}</td>
                        <td className="lead-actions cl-actions" data-label={t('common.actions')}>
                          {trash ? (
                            applicationRight(me, a.status, 'delete') && (
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                data-testid="lead-restore"
                                onClick={() => restoreMut.mutate(a.id)}
                              >
                                <Icon name="restore_from_trash" size={16} /> {t('leads.restore')}
                              </button>
                            )
                          ) : (
                            <>
                              {canEditRow(a) && (
                                <button
                                  type="button"
                                  className="icon-btn"
                                  data-testid="lead-edit"
                                  title={t('common.edit')}
                                  aria-label={`${t('common.edit')}: ${a.fullName}`}
                                  onClick={() => openEdit(a)}
                                >
                                  <Icon name="edit" size={16} />
                                </button>
                              )}
                              {/* Удалить — свой лид или руководство: доступ «все лиды»
                                  удаление чужих не даёт (сервер — ensureCanDelete). */}
                              {canDeleteRow(a) && (
                                <button
                                  type="button"
                                  className="icon-btn danger"
                                  data-testid="lead-delete"
                                  title={t('common.delete')}
                                  aria-label={`${t('common.delete')}: ${a.fullName}`}
                                  onClick={() => onDelete(a)}
                                >
                                  <Icon name="delete" size={16} />
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
                <Pagination
                  page={page}
                  total={found}
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

/**
 * Галочка «вся страница» с третьим состоянием. `indeterminate` — свойство
 * DOM-узла, атрибута в HTML у него нет, поэтому через ref.
 */
function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="crm-checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      disabled={disabled}
    />
  );
}


/**
 * Возвращает функцию «выполни после отпускания кнопки мыши». Если кнопка не
 * зажата (фокус ушёл по Tab) — выполняет сразу. Зачем — см. комментарий у
 * места вызова в форме лида («ПОТЕРЯННЫЙ КЛИК»).
 */
function usePointerSafeBlur() {
  const pointerDownRef = useRef(false);
  const pendingRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    const onDown = () => {
      pointerDownRef.current = true;
    };
    const onUp = () => {
      pointerDownRef.current = false;
      const queue = pendingRef.current;
      pendingRef.current = [];
      if (queue.length === 0) return;
      // pointerup → mouseup → click приходят одной пачкой; макрозадача
      // гарантирует, что click уже доставлен, когда вёрстка сдвинется.
      window.setTimeout(() => queue.forEach((fn) => fn()), 0);
    };
    // capture: pointerdown должен выставить флаг ДО того, как blur
    // (он идёт следом, на mousedown) спросит его значение.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }, []);

  return (fn: () => void) => {
    if (pointerDownRef.current) pendingRef.current.push(fn);
    else fn();
  };
}
