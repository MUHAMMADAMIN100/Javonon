import { useEffect, useRef, useState } from 'react';
import { absFileUrl, useFileToken } from '../lib/fileUrl';
import CrmSelect from '../components/CrmSelect';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useUI } from '../ui/Dialogs';
import {
  createSubmission,
  previewSubmissionPartner,
  uploadSubmissionFile,
  type CreateSubmissionDto,
  type SubmissionPartnerPreview,
  type SubmissionPaymentMethod,
  SUBMISSION_CURRENCIES,
  SUBMISSION_CURRENCY_LABEL,
} from '../api/submissions';
import { fmtCommissionRate, fmtMoneyCents } from '../api/partners';
import { getStudent, listStudents } from '../api/students';
import { getApplication } from '../api/applications';
import { listPrograms } from '../api/programs';
import type { Student } from '../api/types';
import Icon from '../Icon';
import CrmDatePicker from '../components/CrmDatePicker';
import BackButton from '../components/BackButton';
import { useT } from '../lib/i18n';
import { nextDueError, nextDueMin, tjFormatDate } from '../lib/tjTime';
import { useAuth } from '../store/auth';

type Mode = 'existing' | 'new';

// Метаданные загруженного файла из /submissions/upload — нужны бэку,
// чтобы при APPROVE создать Document с правильным mime/size/originalName.
type UploadMeta = { mime: string; size: number; originalName: string };

export default function SubmissionForm() {
  const navigate = useNavigate();
  const { toast } = useUI();
  const { t } = useT();

  /**
   * Заявка-источник: `/submissions/new?applicationId=…` — кнопка «Создать
   * сделку» в карточке заявки. Единственный способ не потерять партнёра,
   * приведшего клиента: реферальная атрибуция с лендинга висит на ЗАЯВКЕ, а
   * сделка, заведённая с чистого листа вкладкой «Новый», не связана с ней
   * ничем — ни studentId (студент появится только на одобрении), ни
   * applicationId (та заявка создаётся тем же одобрением заново). id уходит на
   * бэкенд как есть и живёт в SaleSubmission.sourceApplicationId.
   */
  const [searchParams] = useSearchParams();
  const sourceApplicationId = (searchParams.get('applicationId') || '').trim();

  // Студент
  const [mode, setMode] = useState<Mode>('existing');
  const [studentId, setStudentId] = useState('');
  const [studentSearch, setStudentSearch] = useState('');
  // BUG #16: debounce 300ms — иначе на каждый keystroke летит запрос
  // findMany с полным include, что вешает сервер на 1000+ студентов.
  const [debouncedStudentSearch, setDebouncedStudentSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedStudentSearch(studentSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [studentSearch]);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  // Массивы файлов паспорта (unlimited). Метаданные идут параллельным массивом
  // той же длины — при APPROVE бэк сопоставляет их по индексу для Document.
  const [passportUrls, setPassportUrls] = useState<string[]>([]);
  const [passportMetas, setPassportMetas] = useState<UploadMeta[]>([]);

  // Программа + контракт
  const [programId, setProgramId] = useState('');
  const [contractUrls, setContractUrls] = useState<string[]>([]);
  const [contractMetas, setContractMetas] = useState<UploadMeta[]>([]);
  const [totalAmount, setTotalAmount] = useState('');
  /** Сумма, подставленная из цены программы (чтобы смена программы её обновляла). */
  const autoTotalRef = useRef('');
  const [currency, setCurrency] = useState('TJS');
  const [notes, setNotes] = useState('');

  // Первый платёж
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<SubmissionPaymentMethod>('TRANSFER');
  const [payDate, setPayDate] = useState(() => {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  });
  const [receiptUrls, setReceiptUrls] = useState<string[]>([]);
  const [receiptMetas, setReceiptMetas] = useState<UploadMeta[]>([]);
  const [depositProofUrls, setDepositProofUrls] = useState<string[]>([]);
  const [depositProofMetas, setDepositProofMetas] = useState<UploadMeta[]>([]);
  const [nextDueDate, setNextDueDate] = useState('');
  const [nextDueAmount, setNextDueAmount] = useState('');

  // Макет (часть E): форма по шагам. Шаги в шапке кликабельны — вернуться и
  // поправить можно любой; «Далее» проверяет текущий, «Отправить» — все.
  const [step, setStep] = useState(1);
  const topRef = useRef<HTMLDivElement>(null);

  // Счётчик активных загрузок файлов (защита от submit во время upload)
  const [pendingUploads, setPendingUploads] = useState(0);
  const onUploadingChange = (isUploading: boolean) => {
    setPendingUploads((n) => Math.max(0, n + (isUploading ? 1 : -1)));
  };

  // BUG #16: enabled только при >= 2 символах + limit=50 — иначе на
  // 1000+ студентов findMany с полным include вешает и сервер, и браузер.
  const studentsQuery = useQuery({
    queryKey: ['students-search', debouncedStudentSearch],
    queryFn: () =>
      listStudents({ search: debouncedStudentSearch, limit: 50 }),
    enabled: mode === 'existing' && debouncedStudentSearch.length >= 2,
  });
  const studentOptions = studentsQuery.data || [];
  const programsQuery = useQuery({
    queryKey: ['programs-all'],
    queryFn: () => listPrograms(),
  });

  // ── Предзаполнение из заявки-источника ───────────────────────────────────
  //
  // Заявка тянется только когда в query есть applicationId (обычный вход
  // «Новая сделка» из списка сделок ничего лишнего не грузит).
  const applicationQuery = useQuery({
    queryKey: ['submission-form-application', sourceApplicationId],
    queryFn: () => getApplication(sourceApplicationId),
    enabled: !!sourceApplicationId,
    // Форма — снимок на момент открытия: перезагрузка заявки под руками
    // менеджера затирала бы уже введённые правки.
    staleTime: Infinity,
    retry: false,
  });
  const sourceApp = applicationQuery.data;
  const me = useAuth((s) => s.user);
  // Менеджер лида, если это не я: сделка, студент и бонус — ему (так же решает сервер).
  const leadOwner = (() => {
    const m = (sourceApp as any)?.manager as { id?: string; fullName?: string; isActive?: boolean } | null | undefined;
    if (!m?.id || !m.fullName || m.isActive === false || m.id === me?.id) return null;
    return { id: m.id, fullName: m.fullName };
  })();

  /**
   * Студент, подставленный из заявки. Список `studentOptions` наполняется
   * только поиском по >= 2 символам, поэтому найти в нём преподставленного
   * студента нечем — держим его отдельно, иначе выбранная строка выглядела бы
   * пустой и менеджер искал бы того же человека руками.
   */
  const [presetStudent, setPresetStudent] = useState<Student | null>(null);
  const selectedStudent =
    studentOptions.find((s) => s.id === studentId) ||
    (presetStudent && presetStudent.id === studentId ? presetStudent : undefined);

  // ── Кто привёл клиента ───────────────────────────────────────────────────
  //
  // Плашка «Клиент от партнёра». Это ИНФОРМАЦИЯ, а не переключатель: связь со
  // старой заявкой (и, значит, с партнёром) находит и записывает бэкенд при
  // создании сделки — по телефону, независимо от того, через какую дверь
  // менеджер вошёл. Здесь мы лишь показываем то, что бэкенд запишет, — и
  // поэтому шлём в превью РОВНО ТОТ ЖЕ набор полей, что уходит в
  // createSubmission ниже, включая sourceApplicationId. Стоит его потерять —
  // и превью пойдёт другим путём: сервер начнёт искать заявку сам («старейшая
  // атрибуция выигрывает») и найдёт не ту, что придёт в адресе формы.
  // Поэтому у плашки нет ни чекбокса, ни крестика: право отменить чужую
  // комиссию одним кликом — не менеджерское.
  //
  // Debounce 400 мс тем же приёмом, что и поиск студента выше: пока телефон
  // набирают, запрос не летит на каждый символ.
  const [debouncedPhone, setDebouncedPhone] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedPhone(newPhone.trim()), 400);
    return () => clearTimeout(timer);
  }, [newPhone]);

  // Бэкенд сравнивает последние 9 цифр (национальная часть +992 XX XXX XX XX)
  // и на более коротком вводе возвращает null. Проверяем только ДЛИНУ, чтобы
  // не гонять заведомо пустые запросы на каждой половине номера; сама
  // нормализация остаётся на сервере в единственном экземпляре.
  const phoneHasEnoughDigits = debouncedPhone.replace(/\D/g, '').length >= 9;
  const previewByStudent = mode === 'existing' && !!studentId;
  const previewByPhone = mode === 'new' && phoneHasEnoughDigits;

  const partnerPreviewQuery = useQuery({
    // Ключ — режим + сама идентичность клиента + заявка-источник. Смена
    // телефона порождает новый ключ, react-query отменяет предыдущий запрос по
    // signal, и ответ на устаревший ввод не может «догнать» и подменить
    // плашку. applicationId в ключе не для кэша, а чтобы ответ по одной
    // заявке-источнику нельзя было показать под другой.
    queryKey: [
      'submission-partner-preview',
      previewByStudent ? `student:${studentId}` : `phone:${debouncedPhone}`,
      `app:${sourceApplicationId}`,
    ],
    queryFn: ({ signal }) =>
      previewSubmissionPartner(
        {
          ...(previewByStudent ? { studentId } : { phone: debouncedPhone }),
          // Тот же параметр и то же условие, что в createSubmission ниже.
          applicationId: sourceApplicationId || undefined,
        },
        signal,
      ),
    // Заявка-источник сама по себе — достаточный ключ клиента: сделку по ней
    // запишут независимо от того, выбран ли уже студент и введён ли телефон.
    enabled: previewByStudent || previewByPhone || !!sourceApplicationId,
    // Партнёрская привязка клиента за время заполнения формы не меняется —
    // перезапрашивать её на каждый возврат фокуса в окно незачем.
    staleTime: 5 * 60_000,
    // Плашка справочная: молча не показать её лучше, чем ретраить и мигать.
    retry: false,
  });
  const partnerPreview = partnerPreviewQuery.data ?? null;

  // Однократная подстановка: `prefilledRef` не даёт перетереть правки
  // менеджера, если react-query отдаст данные повторно (refetch на focus).
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!sourceApp || prefilledRef.current) return;
    prefilledRef.current = true;
    if (sourceApp.studentId) {
      // Лид уже сконвертирован в студента — вкладка «Существующий».
      // Заводить его вторым «новым» нельзя: на одобрении создался бы дубль
      // Student, а при совпадении email одобрение вообще упало бы в 400.
      setMode('existing');
      setStudentId(sourceApp.studentId);
      // Имя в строку поиска — на случай, если карточку студента отдать не
      // смогли (нет прав, студента удалили): менеджер увидит подсказки и
      // выберет человека сам, а не пустое поле при непонятно чем выбранном.
      setStudentSearch(sourceApp.fullName || '');
      getStudent(sourceApp.studentId)
        .then(setPresetStudent)
        .catch(() => {
          // Молча оставить studentId выбранным нельзя: поле выглядело бы
          // пустым, а сделка ушла бы на студента, которого менеджер на
          // экране не видел. Снимаем выбор — связь с заявкой при этом
          // сохраняется отдельным applicationId и партнёр не теряется.
          setStudentId('');
        });
    } else {
      setMode('new');
      setNewName(sourceApp.fullName || '');
      setNewPhone(sourceApp.phone || '');
      setNewEmail(sourceApp.email || '');
    }
  }, [sourceApp]);

  const createMut = useMutation({
    mutationFn: (data: CreateSubmissionDto) => createSubmission(data),
    onSuccess: (s) => {
      toast(t('dealForm.toast.sent'), 'success');
      navigate(`/submissions/${s.id}`);
    },
    // Порядок фоллбеков:
    //   response.data.message  — читаемая ошибка от Nest (BadRequest, Forbidden)
    //   response.status===403  — недостаточно прав (RolesGuard)
    //   userMessage            — network/timeout из interceptor'а client.ts
    //   generic                — «Ошибка отправки»
    onError: (e: any) => {
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.message ||
        (status === 403 ? t('dealForm.err.forbidden') : null) ||
        (status === 413 ? t('dealForm.err.tooLarge') : null) ||
        e?.userMessage ||
        t('dealForm.err.send');
      toast(msg, 'error');
    },
  });

  // Ошибки формы — все сразу и у своих полей (QA №32: раньше по одной в тосте,
  // поля не подсвечивались). Показываются после первой попытки отправить.
  // Ошибки показываются по шагам: после «Далее» — у полей этого шага, после
  // «Отправить» — у всех шагов, где что-то не так.
  const [errSteps, setErrSteps] = useState<Set<number>>(() => new Set());
  const taNum = parseFloat(totalAmount);
  // Набл. 18 (QA-3): цена программы подставляется в сумму контракта; если
  // менеджер ввёл другую сумму в той же валюте — предупреждаем (скидка бывает,
  // поэтому это подсказка, а не запрет). Раньше сделку на программу за 9 000
  // можно было оформить на 2 TJS без единого вопроса.
  const selectedProgram = (programsQuery.data || []).find((p) => p.id === programId) || null;
  const programCost = Number((selectedProgram as any)?.cost) || 0;
  const programCurrency = String((selectedProgram as any)?.currency || '').toUpperCase();
  const priceMismatch =
    selectedProgram && programCost > 0 && programCurrency === currency && isFinite(taNum) && taNum > 0 && Math.abs(taNum - programCost) > 0.004
      ? { cost: programCost, currency: programCurrency }
      : null;
  const onProgramChange = (id: string) => {
    setProgramId(id);
    const p = (programsQuery.data || []).find((x) => x.id === id) as any;
    const cost = Number(p?.cost) || 0;
    const cur = String(p?.currency || '').toUpperCase();
    // Подставляем только в пустое поле или поверх прошлой автоподстановки.
    if (cost > 0 && (totalAmount.trim() === '' || totalAmount === autoTotalRef.current)) {
      const v = String(cost);
      autoTotalRef.current = v;
      setTotalAmount(v);
      if ((SUBMISSION_CURRENCIES as readonly string[]).includes(cur)) setCurrency(cur);
    }
  };
  const paNum = parseFloat(payAmount);
  const fieldErrs = {
    student: mode === 'existing' && !studentId ? t('dealForm.err.student') : '',
    name: mode === 'new' && newName.trim().length < 2 ? t('dealForm.err.name') : '',
    program: !programId ? t('dealForm.err.program') : '',
    contract: contractUrls.length === 0 ? t('deal.err.contractFile') : '',
    total: !isFinite(taNum) || taNum <= 0 ? t('deal.err.contractAmount') : '',
    pay: !isFinite(paNum) || paNum <= 0
      ? t('dealForm.err.payAmount')
      : isFinite(taNum) && paNum > taNum + 0.005 ? t('dealForm.err.payOverTotal') : '',
    receipt: payMethod === 'TRANSFER' && receiptUrls.length === 0 ? t('dealForm.err.receipt') : '',
    deposit: payMethod === 'CASH' && depositProofUrls.length === 0 ? t('dealForm.err.deposit') : '',
    // QA-2 №16: сумма следующего платежа — только с датой и не больше остатка.
    nextDate: nextDueAmount.trim() && !nextDueDate
      ? t('deal.err.nextDate')
      : nextDueError(nextDueDate, payDate) ? t(nextDueError(nextDueDate, payDate)) : '',
    nextAmount: nextDueAmount.trim()
      ? !(parseFloat(nextDueAmount) > 0)
        ? t('deal.err.nextAmount')
        : isFinite(taNum) && isFinite(paNum) && parseFloat(nextDueAmount) > taNum - paNum + 0.005
          ? t('deal.err.nextOver').replace('{left}', String(Math.max(0, Math.round((taNum - paNum) * 100) / 100)))
          : ''
      : '',
  };
  const KEY_STEP: Record<keyof typeof fieldErrs, number> = {
    student: 1, name: 1, program: 2, contract: 2, total: 2, pay: 3, receipt: 3, deposit: 3, nextDate: 3, nextAmount: 3,
  };
  const stepHasErr = (n: number) => (Object.keys(fieldErrs) as (keyof typeof fieldErrs)[]).some((k) => KEY_STEP[k] === n && !!fieldErrs[k]);
  const fe = (k: keyof typeof fieldErrs) => (errSteps.has(KEY_STEP[k]) ? fieldErrs[k] : '');
  const goStep = (n: number) => {
    setStep(n);
    requestAnimationFrame(() => topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const scrollToError = () =>
    requestAnimationFrame(() => {
      document.querySelector('[data-field-error]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  const goNext = () => {
    if (pendingUploads > 0) return toast(t('dealForm.err.waitUploads'), 'error');
    if (stepHasErr(step)) {
      setErrSteps((prev) => new Set(prev).add(step));
      toast(t('dealForm.err.fixFields'), 'error');
      scrollToError();
      return;
    }
    goStep(step + 1);
  };

  const onSubmit = () => {
    // Валидация
    if (pendingUploads > 0) return toast(t('dealForm.err.waitUploads'), 'error');
    if (Object.values(fieldErrs).some(Boolean)) {
      // Все шаги с ошибками подсвечены, открыт первый из них.
      const bad = [1, 2, 3].filter(stepHasErr);
      setErrSteps(new Set(bad));
      setStep(bad[0]);
      toast(t('dealForm.err.fixFields'), 'error');
      scrollToError();
      return;
    }
    const ta = taNum;
    const pa = paNum;

    createMut.mutate({
      studentId: mode === 'existing' ? studentId : null,
      // Мост к партнёрской атрибуции. Отправляем ВСЕГДА, когда сделку открыли
      // из карточки заявки, — в том числе в режиме «Существующий»: студент
      // мог быть заведён вручную, без конвертации лида, и тогда атрибуция
      // по-прежнему висит только на заявке.
      applicationId: sourceApplicationId || undefined,
      // Если existing и email введён — обновляем Student.email на бэке
      // (проверка уникальности + update перед созданием submission).
      existingStudentEmail: mode === 'existing' && newEmail.trim()
        ? newEmail.trim()
        : undefined,
      newStudentName: mode === 'new' ? newName.trim() : undefined,
      newStudentPhone: mode === 'new' ? newPhone.trim() : undefined,
      newStudentEmail: mode === 'new' ? newEmail.trim() : undefined,
      // Массивы паспорта (только для нового студента). Бэк сохранит их
      // на SaleSubmission и подставит в Document'ы при APPROVE.
      newStudentPassportUrls: mode === 'new' && passportUrls.length > 0 ? passportUrls : undefined,
      newStudentPassportMimes: mode === 'new' && passportUrls.length > 0
        ? passportMetas.map((m) => m.mime) : undefined,
      newStudentPassportSizes: mode === 'new' && passportUrls.length > 0
        ? passportMetas.map((m) => m.size) : undefined,
      newStudentPassportOriginalNames: mode === 'new' && passportUrls.length > 0
        ? passportMetas.map((m) => m.originalName) : undefined,
      programId,
      contractUrls,
      contractMimes: contractMetas.map((m) => m.mime),
      contractSizes: contractMetas.map((m) => m.size),
      contractOriginalNames: contractMetas.map((m) => m.originalName),
      totalAmount: ta,
      currency,
      notes: notes.trim() || undefined,
      firstPayment: {
        amount: pa,
        paymentMethod: payMethod,
        paidAt: payDate,
        receiptUrls: receiptUrls.length > 0 ? receiptUrls : undefined,
        depositProofUrls: depositProofUrls.length > 0 ? depositProofUrls : undefined,
        nextDueDate: nextDueDate || null,
        nextDueAmount: nextDueAmount ? parseFloat(nextDueAmount) : null,
      },
    });
  };

  const saving = createMut.isPending;

  const STEP_LABELS = [t('dealForm.step.client'), t('dealForm.step.program'), t('dealForm.step.payment'), t('dealForm.step.review')];
  const fmtSum = (n: number) => `${n.toLocaleString('ru-RU')} ${currency}`;
  const leftAfterPay = isFinite(taNum) && taNum > 0 && isFinite(paNum) && paNum > 0 && paNum <= taNum
    ? Math.round((taNum - paNum) * 100) / 100
    : null;
  const filesN = (n: number) => t('dealForm.review.files').replace('{n}', String(n));
  const reviewClient = (mode === 'existing'
    ? [selectedStudent?.fullName, selectedStudent?.phones?.[0], newEmail.trim() || selectedStudent?.email]
    : [newName.trim(), newPhone.trim(), newEmail.trim(), passportUrls.length ? `${t('dealForm.passport')}: ${filesN(passportUrls.length)}` : '']
  ).filter(Boolean).join(' · ') || '—';
  const reviewProgram = [
    selectedProgram ? `${selectedProgram.name}` : '',
    isFinite(taNum) && taNum > 0 ? fmtSum(taNum) : '',
    contractUrls.length ? `${t('dealForm.contractFiles')}: ${filesN(contractUrls.length)}` : '',
  ].filter(Boolean).join(' · ') || '—';
  const reviewPayment = [
    isFinite(paNum) && paNum > 0 ? fmtSum(paNum) : '',
    t(`deal.method.${payMethod}`).toLowerCase(),
    payDate ? tjFormatDate(payDate) : '',
    (payMethod === 'CASH' ? depositProofUrls.length : receiptUrls.length) ? t('dealForm.review.proof') : '',
    nextDueAmount.trim() && nextDueDate
      ? t('dealForm.review.next').replace('{sum}', fmtSum(parseFloat(nextDueAmount))).replace('{date}', tjFormatDate(nextDueDate))
      : '',
  ].filter(Boolean).join(' · ') || '—';

  return (
    <>
      <BackButton fallback="/submissions" />
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.salesNew')}</span>
        <h2 className="crm-section-title">{t('dealForm.title')}</h2>
      </div>

      <motion.div
        className="card deal-wizard"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 24 }}
      >
        {/* Сделка открыта из карточки заявки. Плашка нужна не для красоты:
            она подтверждает менеджеру, что связь с лидом установлена — от неё
            зависит, найдётся ли партнёр, приведший клиента, при начислении
            комиссии. Ошибку загрузки показываем так же явно: молча потерять
            связь и уйти в обычную «новую сделку» — ровно тот сценарий,
            из-за которого партнёр остаётся неоплаченным. */}
        {sourceApplicationId && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '10px 12px',
              marginBottom: 18,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
          >
            <Icon
              name={applicationQuery.isError ? 'error' : 'link'}
              size={18}
              style={{ color: 'var(--text-soft)', flexShrink: 0 }}
            />
            <div style={{ fontSize: 13, minWidth: 0 }}>
              {applicationQuery.isError ? (
                <span style={{ color: 'var(--danger)' }}>
                  {t('submissionForm.fromApplication.failed')}
                </span>
              ) : applicationQuery.isLoading ? (
                <span style={{ color: 'var(--text-soft)' }}>
                  {t('submissionForm.fromApplication.loading')}
                </span>
              ) : (
                <>
                  <strong>
                    {t('submissionForm.fromApplication')}
                    {sourceApp?.fullName ? `: ${sourceApp.fullName}` : ''}
                  </strong>
                  <div style={{ color: 'var(--text-soft)', marginTop: 2 }}>
                    {t('submissionForm.fromApplication.hint')}
                  </div>
                  {/* QA-3 (BUG-13): сделка из лида записывается на менеджера лида. */}
                  {leadOwner && (
                    <div style={{ marginTop: 6, fontWeight: 600 }} data-testid="deal-owner-note">
                      {t('submissionForm.ownerNote').replace('{name}', leadOwner.fullName)}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <div ref={topRef} className="deal-steps-anchor" />
        <ol className="deal-steps" data-testid="deal-steps" aria-label={t('dealForm.steps')}>
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const state = n === step ? 'is-current' : n < step && !stepHasErr(n) ? 'is-done' : '';
            const bad = errSteps.has(n) && stepHasErr(n);
            return (
              <li key={n} className={`deal-step ${state}${bad ? ' is-bad' : ''}`}>
                <button type="button" onClick={() => goStep(n)} aria-current={n === step ? 'step' : undefined} data-testid={`deal-step-${n}`}>
                  <span className="deal-step-mark" aria-hidden="true">
                    {bad ? '!' : state === 'is-done' ? <Icon name="check" size={16} /> : n}
                  </span>
                  <span className="deal-step-text">
                    <small>{t('dealForm.stepN').replace('{n}', String(n))}</small>
                    <b>{label}</b>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {step === 1 && (
          <div className="deal-step-body" data-testid="deal-step-body-1">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'existing' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode('existing')}
            >
              {t('dealForm.existing')}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'new' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode('new')}
            >
              {t('dealForm.new')}
            </button>
          </div>

          {mode === 'existing' && (
            // BUG #16: typeahead вместо select с 1000+ option. Список
            // подсказок появляется только когда введено >= 2 символа.
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }}>
              {selectedStudent ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="crm-input" style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                    <strong>{selectedStudent.fullName}</strong>
                    {selectedStudent.phones?.[0] ? (
                      <span style={{ marginLeft: 8, color: 'var(--text-soft)' }}>
                        · {selectedStudent.phones[0]}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => {
                      setStudentId('');
                      setStudentSearch('');
                    }}
                  >
                    {t('dealForm.change')}
                  </button>
                </div>
              ) : (
                <>
                  <input
                    className={`crm-input${fe('student') ? ' input-error' : ''}`}
                    placeholder={t('dealForm.searchPlaceholder')}
                    value={studentSearch}
                    onChange={(e) => setStudentSearch(e.target.value)}
                  />
                  {debouncedStudentSearch.length < 2 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                      {t('dealForm.searchMin')}
                    </div>
                  ) : studentsQuery.isLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t('dealForm.searching')}</div>
                  ) : studentOptions.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t('common.empty')}</div>
                  ) : (
                    <ul
                      style={{
                        listStyle: 'none',
                        padding: 0,
                        margin: 0,
                        maxHeight: 240,
                        overflowY: 'auto',
                        border: '1px solid var(--border-soft, #e5e7eb)',
                        borderRadius: 6,
                      }}
                    >
                      {studentOptions.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => setStudentId(s.id)}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              padding: '8px 10px',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              borderBottom: '1px solid var(--border-soft, #f1f5f9)',
                            }}
                          >
                            <strong>{s.fullName}</strong>
                            {s.phones?.[0] ? (
                              <span style={{ marginLeft: 8, color: 'var(--text-soft)' }}>
                                · {s.phones[0]}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                      {studentOptions.length >= 50 && (
                        <li style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-soft)' }}>
                          {t('dealForm.first50')}
                        </li>
                      )}
                    </ul>
                  )}
                </>
              )}
              {fe('student') && <div className="form-error-text" data-field-error="1" data-testid="deal-err-student">{fe('student')}</div>}
            </div>
          )}

          {/* Email — всегда видимое поле:
             - existing: обновляет email существующего студента (уникальность
               проверяется на бэке)
             - new: обычный email нового студента (как раньше) */}
          {mode === 'existing' && (
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <Field label={selectedStudent?.email ? t('dealForm.emailUpdate') : t('dealForm.email')}>
                <input
                  className="crm-input"
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder={selectedStudent?.email || 'name@example.com'}
                />
              </Field>
            </div>
          )}

          {mode === 'new' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <Field label={`${t('common.fullName')} *`} error={fe('name')} testid="deal-field-name">
                <input className={`crm-input${fe('name') ? ' input-error' : ''}`} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('dealForm.namePlaceholder')} />
              </Field>
              <Field label={t('common.phone')}>
                <input className="crm-input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="+992..." />
              </Field>
              <Field label="Email">
                <input className="crm-input" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@example.com" />
              </Field>
              <Field label={t('dealForm.passport')}>
                <MultiFileUpload
                  values={passportUrls}
                  metas={passportMetas}
                  onChange={(u, m) => { setPassportUrls(u); setPassportMetas(m); }}
                  accept="image/*,application/pdf"
                  onUploadingChange={onUploadingChange}
                />
              </Field>
            </div>
          )}

          {/* Ничего не найдено — ничего и не рисуем. Ни «партнёра нет», ни
              спиннера: большинство клиентов приходят сами, и постоянная
              пустая строка приучила бы менеджера не смотреть на это место
              вообще — ровно тогда, когда там однажды появится партнёр. */}
          <PartnerChip preview={partnerPreview} />
          </div>
        )}

        {step === 2 && (
          <div className="deal-step-body" data-testid="deal-step-body-2">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Field label={`${t('deal.program')} *`} error={fe('program')} testid="deal-field-program">
              <CrmSelect className={`crm-select${fe('program') ? ' input-error' : ''}`} value={programId} onChange={(e) => onProgramChange(e.target.value)}>
                <option value="">{t('common.choose')}</option>
                {(programsQuery.data || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.university})
                  </option>
                ))}
              </CrmSelect>
            </Field>
            <Field label={`${t('dealForm.contractFiles')} *`} error={fe('contract')} testid="deal-field-contract">
              <MultiFileUpload
                values={contractUrls}
                metas={contractMetas}
                onChange={(u, m) => { setContractUrls(u); setContractMetas(m); }}
                accept="image/*,application/pdf"
                onUploadingChange={onUploadingChange}
              />
            </Field>
            <Field label={`${t('deal.contractAmount')} *`} error={fe('total')} testid="deal-field-total">
              <input className={`crm-input${fe('total') ? ' input-error' : ''}`} type="number" min={0} step={50} value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} placeholder="3000" />
              {priceMismatch && (
                <div className="deal-price-note" data-testid="deal-price-note">
                  {t('dealForm.priceMismatch').replace('{price}', `${priceMismatch.cost.toLocaleString('ru-RU')} ${priceMismatch.currency}`)}
                </div>
              )}
            </Field>
            <Field label={t('common.currency')}>
              {/* Список — общий с бэком (SUBMISSION_CURRENCIES). Значение вне
                  списка бэк отвергает: по валюте сделки считается бонусная
                  база менеджера. Менять валюту можно только до первого
                  одобрения платежа. */}
              <CrmSelect className="crm-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {SUBMISSION_CURRENCIES.map((c) => (
                  <option key={c} value={c}>{SUBMISSION_CURRENCY_LABEL[c] || c}</option>
                ))}
              </CrmSelect>
            </Field>
          </div>
          </div>
        )}

        {step === 3 && (
          <div className="deal-step-body" data-testid="deal-step-body-3">
            <div className="deal-grid">
              <Field label={`${t('common.amount')} *`} error={fe('pay')} testid="deal-field-pay">
                <input className={`crm-input${fe('pay') ? ' input-error' : ''}`} type="number" min={0} step={50} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="1000" />
                {!fe('pay') && isFinite(taNum) && taNum > 0 && (
                  <div className="profile-field-hint" data-testid="deal-pay-hint">{t('dealForm.payMax').replace('{sum}', fmtSum(taNum))}</div>
                )}
              </Field>
              <Field label={`${t('deal.col.paidAt')} *`}>
                <CrmDatePicker value={payDate} onChange={setPayDate} />
              </Field>
            </div>
            <Field label={`${t('deal.field.method')} *`}>
              <div className="seg-toggle deal-method" role="radiogroup" aria-label={t('deal.field.method')} data-testid="deal-method">
                {(['CASH', 'TRANSFER', 'OTHER'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={payMethod === m}
                    className={payMethod === m ? 'active' : ''}
                    onClick={() => setPayMethod(m)}
                    data-testid={`deal-method-${m}`}
                  >
                    {t(`deal.method.${m}`)}
                  </button>
                ))}
              </div>
            </Field>
            {payMethod === 'TRANSFER' && (
              <Field label={`${t('dealForm.receipt')} *`} error={fe('receipt')} testid="deal-field-receipt">
                <MultiFileUpload
                  values={receiptUrls}
                  metas={receiptMetas}
                  onChange={(u, m) => { setReceiptUrls(u); setReceiptMetas(m); }}
                  accept="image/*,application/pdf"
                  onUploadingChange={onUploadingChange}
                />
              </Field>
            )}
            {payMethod === 'CASH' && (
              <Field label={`${t('dealForm.depositShot')} *`} error={fe('deposit')} testid="deal-field-deposit">
                <MultiFileUpload
                  values={depositProofUrls}
                  metas={depositProofMetas}
                  onChange={(u, m) => { setDepositProofUrls(u); setDepositProofMetas(m); }}
                  accept="image/*,application/pdf"
                  onUploadingChange={onUploadingChange}
                />
              </Field>
            )}
            {payMethod === 'OTHER' && (
              <Field label={t('deal.field.proof')}>
                <MultiFileUpload
                  values={receiptUrls}
                  metas={receiptMetas}
                  onChange={(u, m) => { setReceiptUrls(u); setReceiptMetas(m); }}
                  accept="image/*,application/pdf"
                  onUploadingChange={onUploadingChange}
                />
              </Field>
            )}
            <div className="deal-next-group">
              <div className="deal-next-head">
                <b>{t('dealForm.nextTitle')}</b> <span>{t('dealForm.nextOptional')}</span>
              </div>
              <div className="deal-grid">
                <Field label={t('deal.field.nextAmount')} error={fe('nextAmount')} testid="deal-next-amount">
                  <input className="crm-input" type="number" min={0} step={50} value={nextDueAmount} onChange={(e) => setNextDueAmount(e.target.value)} placeholder="2000" />
                  {!fe('nextAmount') && leftAfterPay !== null && (
                    <div className="profile-field-hint" data-testid="deal-next-left">{t('dealForm.leftToPay').replace('{sum}', fmtSum(leftAfterPay))}</div>
                  )}
                </Field>
                <Field label={t('deal.field.nextDate')} error={fe('nextDate')} testid="deal-next-date">
                  <CrmDatePicker value={nextDueDate} onChange={setNextDueDate} min={nextDueMin(payDate)} />
                </Field>
              </div>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="deal-step-body" data-testid="deal-step-body-4">
            <div className="deal-review">
              {([
                [1, STEP_LABELS[0], reviewClient],
                [2, STEP_LABELS[1], reviewProgram],
                [3, STEP_LABELS[2], reviewPayment],
              ] as const).map(([n, title, text]) => (
                <div key={n} className={`deal-review-row${stepHasErr(n) ? ' is-bad' : ''}`} data-testid={`deal-review-${n}`}>
                  <div className="deal-review-text">
                    <b>{title}</b>
                    <span>{text}</span>
                    {stepHasErr(n) && <span className="deal-review-bad">{t('dealForm.review.fix')}</span>}
                  </div>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => goStep(n)} data-testid={`deal-review-edit-${n}`}>
                    <Icon name="edit" size={14} /> {t('profile.edit')}
                  </button>
                </div>
              ))}
            </div>
            <PartnerChip preview={partnerPreview} />
            <Field label={t('common.comment')}>
              <textarea
                className="crm-textarea"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('dealForm.commentPlaceholder')}
                style={{ resize: 'none' }}
                data-testid="deal-notes"
              />
            </Field>
            <p className="deal-review-note">{t('dealForm.review.note')}</p>
          </div>
        )}

        <div className="deal-wizard-foot">
          <button className="btn btn-secondary" onClick={() => navigate('/submissions')} disabled={saving} data-testid="deal-cancel-form">
            {t('common.cancel')}
          </button>
          <span className="deal-wizard-count" data-testid="deal-step-count">{t('dealForm.stepOf').replace('{n}', String(step))}</span>
          {step > 1 && (
            <button className="btn btn-secondary" onClick={() => goStep(step - 1)} disabled={saving} data-testid="deal-back">
              {t('dealForm.back')}
            </button>
          )}
          {step < 4 ? (
            <button className="btn btn-primary" onClick={goNext} data-testid="deal-next">
              {t('dealForm.next')}
            </button>
          ) : (
            /* Клик всегда доходит до onSubmit — тот скажет, если загрузка ещё идёт. */
            <button className="btn btn-primary" onClick={onSubmit} disabled={saving} data-testid="deal-submit">
              {saving ? t('common.sending') : pendingUploads > 0 ? t('dealForm.uploadingFiles') : t('dealForm.submit')}
            </button>
          )}
        </div>
      </motion.div>
    </>
  );
}

/**
 * «Клиент от партнёра: Имя · КОД — комиссия 500 TJS».
 *
 * Только чтение. Ни чекбокса «не учитывать», ни крестика «убрать»: сама
 * возможность снять галочку означала бы, что комиссию партнёра можно молча
 * отменить одним кликом из формы сделки — а связь всё равно устанавливает
 * сервер при создании, и плашка на неё не влияет.
 *
 * Стиль намеренно совпадает с чипом партнёра в списке сделок
 * (pages/Submissions.tsx): один и тот же факт должен читаться одинаково.
 */
function PartnerChip({ preview }: { preview: SubmissionPartnerPreview | null }) {
  const { t } = useT();
  if (!preview) return null;

  // Те же два форматтера и то же правило выбора, что в PartnerAttributionCard:
  // пришла валюта → сумма из настоящей Commission, рисуем деньгами; не пришла
  // → это прогноз по фикс-ставке партнёра, всегда целые TJS.
  const commissionLabel = preview.commissionCurrency
    ? fmtMoneyCents(preview.commissionAmountCents, preview.commissionCurrency)
    : fmtCommissionRate(preview.commissionAmountCents);

  return (
    <div
      style={{
        marginTop: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        padding: '4px 10px',
        borderRadius: 999,
        background: 'rgba(139, 92, 246, 0.12)',
        color: '#7c3aed',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <Icon name="handshake" size={14} />
      {t('submissionForm.partner')}: {preview.fullName}
      <span style={{ opacity: 0.7, fontWeight: 400 }}>· {preview.referralCode}</span>
      <span style={{ opacity: 0.7, fontWeight: 400 }}>
        — {t('submissionForm.partner.commission')} {commissionLabel}
      </span>
    </div>
  );
}

function Field({ label, children, error, testid }: { label: string; children: any; error?: string; testid?: string }) {
  return (
    <div className={error ? 'deal-field has-error' : 'deal-field'} data-testid={testid}>
      <label style={{ fontSize: 11, color: error ? 'var(--danger)' : 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' }}>
        {label}
      </label>
      {children}
      {error && <div className="form-error-text" data-field-error="1">{error}</div>}
    </div>
  );
}

// Мульти-файловый uploader. Поддерживает:
//   1) выбор нескольких файлов за раз (input multiple)
//   2) итеративное добавление через кнопку «+ Добавить ещё»
//   3) удаление по одному через × рядом с каждой строкой
// Лимитов на количество нет; ограничение на размер (50MB/файл) — на бэке
// (multer в submissions.controller.ts:upload). Пока идёт batch upload,
// компонент держит один тик pendingUploads (родитель считает активные
// загрузки и блокирует сабмит). На unmount тик возвращается в 0.
function MultiFileUpload({
  values,
  metas,
  onChange,
  accept,
  onUploadingChange,
}: {
  values: string[];
  metas: UploadMeta[];
  onChange: (urls: string[], metas: UploadMeta[]) => void;
  accept?: string;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  useFileToken(); // превью — по адресу бэкенда с файловым токеном (QA №32: картинка была битой)
  const [uploading, setUploading] = useState(false);
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Держит ли компонент активный тик pendingUploads. На unmount возвращаем
  // тик в 0 (иначе счётчик застрянет и кнопка сабмита будет вечно «Загружаем…»).
  const uploadingRef = useRef(false);
  useEffect(() => {
    return () => {
      if (uploadingRef.current) {
        uploadingRef.current = false;
        onUploadingChange?.(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setUploading(true);
    if (!uploadingRef.current) {
      uploadingRef.current = true;
      onUploadingChange?.(true);
    }
    const newUrls: string[] = [];
    const newMetas: UploadMeta[] = [];
    let failed = 0;
    try {
      for (const file of files) {
        try {
          const r = await uploadSubmissionFile(file);
          newUrls.push(r.url);
          // Предпочитаем mimeType с сервера (submissions.controller.ts:upload
          // возвращает file.mimetype после multer-валидации). Фоллбек — file.type
          // из браузера; для file.type=='' (редкий .heic в старых браузерах)
          // подставляем octet-stream.
          newMetas.push({
            mime: r.mimeType || file.type || 'application/octet-stream',
            size: r.size ?? file.size,
            originalName: r.originalName || file.name,
          });
        } catch (e: any) {
          failed++;
          toast(e?.response?.data?.message || e?.userMessage || `${t('dealForm.uploadError')}: ${file.name}`, 'error');
        }
      }
      if (newUrls.length > 0) {
        onChange([...values, ...newUrls], [...metas, ...newMetas]);
        if (failed === 0) toast(`${t('dealForm.uploadedFiles')}: ${newUrls.length}`, 'success');
      }
    } finally {
      setUploading(false);
      if (uploadingRef.current) {
        uploadingRef.current = false;
        onUploadingChange?.(false);
      }
      // Сбрасываем value у input'ов чтобы можно было выбрать те же файлы
      // повторно (иначе onChange не сработает на идентичный FileList).
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const removeAt = (idx: number) => {
    const nextUrls = values.filter((_, i) => i !== idx);
    const nextMetas = metas.filter((_, i) => i !== idx);
    onChange(nextUrls, nextMetas);
  };

  // HEIC браузер показать не умеет — для него значок, как для PDF.
  const isImage = (url: string, mime?: string) => {
    if (broken.has(url)) return false;
    if (/heic|heif/i.test(mime || '') || /\.(heic|heif)$/i.test(url)) return false;
    if (mime && mime.startsWith('image/')) return true;
    return /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {values.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {values.map((url, i) => {
            const meta = metas[i];
            const img = isImage(url, meta?.mime);
            return (
              <li
                key={`${url}-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px',
                  border: '1px solid var(--border-soft, #e5e7eb)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                {img ? (
                  <a href={absFileUrl(url)} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', flexShrink: 0 }}>
                    <img
                      src={absFileUrl(url)}
                      alt=""
                      data-testid="deal-file-thumb"
                      onError={() => setBroken((b) => new Set(b).add(url))}
                      style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
                    />
                  </a>
                ) : (
                  <span
                    style={{
                      width: 32,
                      height: 32,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'var(--surface-2, #f1f5f9)',
                      borderRadius: 4,
                      flexShrink: 0,
                      color: 'var(--primary-dark)',
                    }}
                  >
                    <Icon name={/pdf/i.test(meta?.mime || '') || /\.pdf$/i.test(url) ? 'picture_as_pdf' : 'description'} size={18} />
                  </span>
                )}
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--text-soft)',
                  }}
                  title={meta?.originalName || url}
                >
                  {meta?.originalName || url.split('/').pop()}
                </span>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  disabled={uploading}
                  aria-label={t('dealForm.removeFile')}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    color: 'var(--danger, #dc2626)',
                    fontSize: 16,
                    lineHeight: 1,
                    padding: '2px 6px',
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* Макет (часть E): зона загрузки — перетащить файлы или выбрать. Поле
          файла внутри подписи: клик и клавиатура открывают выбор файлов. */}
      <label
        className={`deal-drop${dragOver ? ' is-over' : ''}${uploading ? ' is-busy' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!uploading) handleFiles(e.dataTransfer.files); }}
        data-testid="deal-drop"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept}
          onChange={(e) => handleFiles(e.target.files)}
          disabled={uploading}
          className="deal-drop-input"
        />
        <Icon name={uploading ? 'hourglass_top' : 'upload_file'} size={22} />
        <span className="deal-drop-text">
          {uploading ? t('common.uploading') : (
            <>
              {values.length ? t('dealForm.drop.more') : t('dealForm.drop')} <u>{t('dealForm.drop.pick')}</u>
            </>
          )}
        </span>
        <small>{t('dealForm.drop.hint')}</small>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {!uploading && values.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--primary-dark)' }}>
            <Icon name="check_circle" size={14} /> {t('dealForm.files')}: {values.length}
          </span>
        )}
      </div>
    </div>
  );
}

// Компонент одиночной загрузки — оставлен для обратной совместимости
// с другими экранами (не удалять). В этой форме больше не используется:
// все поля переведены на MultiFileUpload.
function FileUpload({
  value,
  onChange,
  onMetaChange,
  onUploadingChange,
}: {
  value: string;
  onChange: (v: string) => void;
  // Возвращаем mime/size/originalName наверх, чтобы родитель отправил
  // их вместе с createSubmission — иначе Document при APPROVE сохранится
  // с плейсхолдерами (octet-stream / size=0 / originalName='passport').
  onMetaChange?: (meta: UploadMeta | null) => void;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [uploading, setUploading] = useState(false);
  // Хранит, «отдали» ли мы наверх активный тик pendingUploads. Нужно чтобы:
  // (а) если компонент размонтируется во время загрузки (например, менеджер
  //     переключил payMethod TRANSFER→CASH и FileUpload с чеком исчез) — на
  //     unmount вернуть счётчик в 0; иначе кнопка submit останется disabled.
  // (б) не декрементить дважды, если finally уже отработал.
  const uploadingRef = useRef(false);
  useEffect(() => {
    return () => {
      if (uploadingRef.current) {
        uploadingRef.current = false;
        onUploadingChange?.(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    uploadingRef.current = true;
    onUploadingChange?.(true);
    try {
      const r = await uploadSubmissionFile(file);
      onChange(r.url);
      // Предпочитаем mimeType с сервера (submissions.controller.ts:upload
      // теперь возвращает file.mimetype). Фоллбек — file.type из браузера;
      // для file.type=='' (редкий случай для .heic в старых браузерах)
      // подставляем octet-stream.
      onMetaChange?.({
        mime: r.mimeType || file.type || 'application/octet-stream',
        size: r.size ?? file.size,
        originalName: r.originalName || file.name,
      });
      toast(t('dealForm.fileUploaded'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || e?.userMessage || t('dealForm.uploadError'), 'error');
    } finally {
      setUploading(false);
      if (uploadingRef.current) {
        uploadingRef.current = false;
        onUploadingChange?.(false);
      }
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        type="file"
        accept="image/*,application/pdf"
        onChange={(e) => handleFile(e.target.files?.[0] || null)}
        disabled={uploading}
        style={{ fontSize: 13 }}
      />
      {uploading && <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t('common.uploading')}</span>}
      {value && !uploading && (
        <span style={{ fontSize: 12, color: 'var(--primary-dark)' }}>
          <Icon name="check_circle" size={14} /> {t('toast.uploaded')}
        </span>
      )}
    </div>
  );
}
