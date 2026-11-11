import { useEffect, useRef, useState } from 'react';
import CrmSelect from '../CrmSelect';
import { useQuery } from '@tanstack/react-query';
import { Transaction, TransactionType, TransactionCategory, TRANSACTION_CATEGORY_LABEL, INCOME_CATEGORIES, EXPENSE_CATEGORIES, CreateTransactionDto, createTransaction, updateTransaction, IncomeSource, ProductCategoryEnum, PaymentPhaseStatus, listAccounts } from '../../api/finance';
import { listStudents } from '../../api/students';
import { listUsers } from '../../api/users';
import { keys } from '../../lib/queryKeys';
import { useUI } from '../../ui/Dialogs';
import CrmDatePicker from '../CrmDatePicker';
import FormModal from '../FormModal';
import { tjDateInput, tjToday } from '../../lib/tjTime';
import { fmtDate } from './financeShared';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../store/auth';
import { isElevated, isTeacherOnly } from '../../lib/roles';
import { roleCan } from '../../lib/permissions';

export let preselectedStudent: any = null;
export function setPreselectedStudent(v: any) { preselectedStudent = v; }

// ============================================================
// Form for new transaction
// ============================================================
export default function TransactionForm({
  students: studentsProp,
  users: usersProp,
  preselect,
  canExpense,
  editTx,
  initialType,
  initialDate,
  initialProduct,
  onClose,
  onCreated,
}: {
  /** Списки для выбора; не переданы — форма загрузит их сама при открытии. */
  students?: any[];
  users?: any[];
  preselect: any;
  /** «+ Доход» / «+ Расход» — тип сразу выбран. */
  initialType?: TransactionType;
  /** «+» в дне календаря — дата этого дня. */
  initialDate?: string;
  /** «Доход → Академия / Мастер-классы / Прочее → + Оплата» — продукт сразу выбран. */
  initialProduct?: ProductCategoryEnum;
  /** Правим существующую запись, а не создаём новую. */
  editTx?: Transaction | null;
  // Разрешено ли пользователю выбирать EXPENSE. Backend режет POST
  // /finance/transactions с type=EXPENSE для не-FOUNDER/ADMIN/ACCOUNTANT
  // (finance.controller.ts:291) — форма должна повторять этот контракт,
  // иначе SALES_MANAGER выбирает «Расход», грузит файл через uploadReceipt
  // и получает 403 при createTransaction. Файл остаётся orphan'ом в
  // /uploads/, пользователь видит непонятный error toast.
  canExpense: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  // Current actor: нужно, чтобы для не-elevated ролей (SALES_MANAGER /
  // CLIENT_MANAGER) заблокировать выбор чужого managerId. Backend всё равно
  // форсит `managerId = caller.id` для менеджеров (finance.service.ts,
  // ветка `else` в блоке ниже line ~479) — но раньше UI показывал полный
  // список пользователей в <select>, менеджер мог выбрать «Босса», форма
  // молча уходила с его выбором, а бекенд перезаписывал на self. С точки
  // зрения оператора это выглядело как data-loss: «я оформил продажу на
  // Ивана, а строчка в леджере на моём имени». Теперь блокируем выбор на
  // клиенте, чтобы UI совпадал с фактическим поведением backend'а.
  const me = useAuth((s) => s.user);
  // Свой менеджер в операции и даты задним числом: должность — руководство;
  // роль — «Финансы — изменение операций» (как financeElevated на сервере).
  const elevated = roleCan(me, 'finance:update', isElevated(me));
  const startType: TransactionType = editTx?.type ?? (initialType === 'EXPENSE' && canExpense ? 'EXPENSE' : 'INCOME');
  const [type, setType] = useState<TransactionType>(startType);
  // «Оплата за обучение» пишет только одобрение платежа по сделке — вручную её
  // не выбрать (сервер отвечает 400), поэтому по умолчанию «Прочий доход».
  const [category, setCategory] = useState<TransactionCategory>(editTx?.category ?? (startType === 'EXPENSE' ? 'SALARY' : 'OTHER_INCOME'));

  // Студенты и сотрудники для выбора — грузим здесь, только когда форма открыта.
  const studentsQ = useQuery({ queryKey: keys.students.list(), queryFn: () => listStudents({}), enabled: !studentsProp });
  const usersQ = useQuery({ queryKey: keys.users.list(), queryFn: () => listUsers(), enabled: !usersProp });
  const students = studentsProp ?? studentsQ.data ?? [];
  // Учитель академии продаж не ведёт — в выборе менеджера прихода его нет.
  const users = usersProp ?? (usersQ.data ?? []).filter((u: any) => !isTeacherOnly(u));
  // Счета видят те, кому открыт раздел; остальным счёт определится по способу оплаты.
  const canSeeAccounts = roleCan(me, 'finance:read', isElevated(me));
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts, enabled: canSeeAccounts });
  const allAccounts = accountsQ.data?.accounts ?? [];
  const [amount, setAmount] = useState<string>(
    editTx ? String(editTx.amount) : preselect?.amount ? String(preselect.amount) : '',
  );
  const [currency, setCurrency] = useState(editTx?.currency || preselect?.currency || 'TJS');
  // '' — не выбран: счёт определится по способу оплаты (Финансы → Настройки).
  const [accountId, setAccountId] = useState<string>(editTx?.accountId || '');
  const accountTouched = useRef(!!editTx);
  // Новая операция: по умолчанию — первый действующий счёт в валюте операции.
  useEffect(() => {
    if (accountTouched.current || accountId || !allAccounts.length) return;
    const first = allAccounts.find((a) => !a.archived && a.currency === currency);
    if (first) setAccountId(first.id);
  }, [allAccounts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const accountOptions = allAccounts.filter((a) => !a.archived || a.id === editTx?.accountId);
  const selectedAccount = allAccounts.find((a) => a.id === accountId) || null;
  const [studentId, setStudentId] = useState<string>(editTx?.studentId || preselect?.studentId || '');
  const [managerId, setManagerId] = useState<string>(() => {
    // Для не-elevated: preselect?.managerId (напр., пришёл из карточки
    // студента с чужим владельцем) игнорируем и сразу форсим self —
    // тогда UI показывает то же, что запишет backend.
    if (!elevated && me?.id) return me.id;
    return editTx?.managerId || preselect?.managerId || '';
  });
  const [comment, setComment] = useState(editTx?.comment || '');
  // Сегодня — по Asia/Dushanbe (toISOString даёт UTC-день, что после 19:00
  // ТJT уже завтра по UTC и форма открывалась бы с завтрашним числом).
  const [date, setDate] = useState(editTx ? tjDateInput(editTx.date) : initialDate || tjToday());
  const [submitting, setSubmitting] = useState(false);
  // Синхронный guard от повторной отправки: `setSubmitting(true)` применяется
  // только на следующем React-render, поэтому двойной клик по «Сохранить»
  // (или Enter×2) в пределах одного тика видит `submitting=false` в обоих
  // обработчиках и оба уходят в `await createTransaction(dto)` → дубль-POST
  // и дубль-строка в ledger. `disabled` у кнопки срабатывает только после
  // flush render'а, между двумя синхронными click-обработчиками этого не
  // происходит. `useRef` меняется синхронно и закрывает окно гонки.
  const inFlight = useRef(false);

  // Расширенные поля для финансового модуля
  const [paymentChannel, setPaymentChannel] = useState<string>((editTx as any)?.paymentChannel || 'CASH');
  const [paymentKind, setPaymentKind] = useState<string>((editTx as any)?.paymentKind || 'FULL');
  const [payerName, setPayerName] = useState((editTx as any)?.payerName || '');
  const [receiptKind, setReceiptKind] = useState<string>('RECEIPT');
  const [noReceiptReason, setNoReceiptReason] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  // Google Sheet parity — новые enum-поля
  const [incomeSource, setIncomeSource] = useState<IncomeSource | ''>((editTx as any)?.incomeSource || '');
  const [productCategoryEnum, setProductCategoryEnum] = useState<ProductCategoryEnum | ''>((editTx as any)?.productCategoryEnum || initialProduct || '');
  const [paymentPhase, setPaymentPhase] = useState<PaymentPhaseStatus | ''>((editTx as any)?.paymentPhase || '');
  const [paidViaId, setPaidViaId] = useState<string>((editTx as any)?.paidViaId || '');
  // Ошибка суммы — у поля и словами (QA №53: на минус было просто «Ошибка»).
  const [amountErr, setAmountErr] = useState('');
  // Платёж по сделке: сумма, валюта и дата — из сделки, здесь только смотрим.
  const lockMoney = editTx?.category === 'TUITION_PAYMENT';

  // Зарезервированная «Оплата за обучение» видна только у уже существующей
  // операции этой категории (её открыли на правку) — выбрать её нельзя.
  const incomeCats = INCOME_CATEGORIES.filter((c) => c !== 'TUITION_PAYMENT' || editTx?.category === 'TUITION_PAYMENT');
  const cats = type === 'INCOME' ? incomeCats : EXPENSE_CATEGORIES;

  // managerId имеет двойную семантику: (INCOME → менеджер-получатель клиента)
  // и (EXPENSE + SALARY → сотрудник-получатель зарплаты). Поле разделяет
  // одну state-переменную, поэтому нужен явный guard, чтобы id одной роли
  // не «протёк» в транзакцию другой роли при переключении type/category.
  const needsManager = (t: TransactionType, c: TransactionCategory): boolean =>
    t === 'INCOME' || (t === 'EXPENSE' && c === 'SALARY');

  // Реcинк managerId → me.id для не-elevated при каждом переключении
  // type/category, потому что handlers `setType`/`setCategory` в блоках
  // выше делают `setManagerId('')` при любом переключении (сброс двойной
  // семантики managerId между INCOME-manager и SALARY-employee). Без этого
  // effect'а после переключения на не-показывающую select категорию
  // и обратно value осталось бы пустым, а backend всё равно записал бы
  // self — UI снова расходился бы с фактом. Effect делает форс явным и
  // видимым в disabled-select (см. ниже).
  useEffect(() => {
    if (elevated || !me?.id) return;
    if (!needsManager(type, category)) return;
    setManagerId((prev) => (prev === me.id ? prev : me.id));
  }, [elevated, me?.id, type, category]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Синхронный re-entry guard. Проверяем в самом верху, чтобы второй
    // одновременный клик по «Сохранить» (или Enter×2 в одном тике) вышел
    // раньше, чем стартует второй `createTransaction`. Устанавливаем флаг
    // *после* синхронной валидации — иначе неуспешная валидация оставила бы
    // флаг взведённым навсегда, и форма стала бы неотправляемой. JS однопо-
    // точный: между валидацией и первым `await` другой обработчик не
    // вклинится, поэтому окно гонки закрывается до первого микро-таска.
    if (inFlight.current) return;
    const amt = parseFloat(amount);
    // QA-2: ошибка «Введите сумму» оставалась выше экрана — ведём к полю.
    const toAmount = () => requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="tx-amount"]');
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus({ preventScroll: true });
    });
    if (!amount.trim() || !isFinite(amt)) {
      setAmountErr(t('finance.err.amountEmpty'));
      toAmount();
      return;
    }
    if (amt <= 0) {
      setAmountErr(t('finance.err.amountPositive'));
      toAmount();
      return;
    }
    setAmountErr('');
    // Role-guard: EXPENSE запрещён backend'ом для не-elevated ролей
    // (finance.controller.ts:291 → 403). Ловим ДО uploadReceipt, чтобы
    // не оставить orphan-файл в /uploads/ при последующем 403 на
    // createTransaction. В нормальном UI EXPENSE-опция уже спрятана
    // (см. type-select выше), но double-check страхует от гонки, когда
    // роль пользователя поменялась между открытием формы и submit'ом.
    if (type === 'EXPENSE' && !canExpense) {
      toast(t('finance.err.noExpenseRight'), 'error');
      return;
    }
    // Чек обязателен только при СОЗДАНИИ расхода. При правке он у записи
    // уже есть — требовать приложить файл заново значит запретить
    // исправить опечатку в сумме.
    if (type === 'EXPENSE' && !editTx) {
      if (receiptKind === 'REASON_ONLY') {
        if (!noReceiptReason.trim() || noReceiptReason.trim().length < 5) {
          toast(t('finance.receipt.reasonRequired'), 'error');
          return;
        }
      } else if (!receiptFile) {
        toast(t('finance.receipt.fileRequired'), 'error');
        return;
      }
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      // Сначала загружаем чек (если есть). Upload идёт ТОЛЬКО в EXPENSE-
      // ветке и только после role-guard выше — если пользователь без прав
      // на EXPENSE как-то дотащил форму до submit, мы уже вышли и файл
      // не полетит на диск. Оставшиеся failure-modes (network / backend
      // validation после успешного upload) редки и требуют отдельной
      // POST-then-PATCH архитектуры; сейчас PATCH тоже elevated-only, так
      // что до этого шага без прав на EXPENSE в норме не дойти.
      let receiptUrl: string | undefined;
      if (receiptFile && type === 'EXPENSE') {
        setUploadingReceipt(true);
        const m = await import('../../api/finance');
        const uploaded = await m.uploadReceipt(receiptFile);
        receiptUrl = uploaded.url;
        setUploadingReceipt(false);
      }

      const dto: CreateTransactionDto = {
        type,
        category,
        amount: amt,
        currency: selectedAccount ? selectedAccount.currency : currency,
        // Счёт: при правке шлём всегда (снять счёт = null), при создании — если выбран.
        ...(editTx ? { accountId: accountId || null } : accountId ? { accountId } : {}),
        comment: comment.trim() || undefined,
        date,
        // Студент прикрепляется только к INCOME-транзакции. Селект «Студент»
        // рендерится лишь при type === 'INCOME', поэтому при переключении на
        // EXPENSE ранее выбранный studentId остался бы «висеть» в state и
        // ушёл бы на бэкенд как невидимая связка EXPENSE↔студент. Guard
        // страхует onChange-сброс на случай будущих регрессий.
        studentId: type === 'INCOME' ? (studentId || null) : null,
        // Строгий guard: managerId уходит только если для текущей пары
        // (type, category) в форме реально отрисован соответствующий
        // селект (менеджер / сотрудник). Иначе поле выкидывается из DTO,
        // чтобы «зависший» id из прежнего режима не попал на бэкенд.
        ...(needsManager(type, category) && managerId
          ? { managerId }
          : { managerId: null }),
        paymentChannel: paymentChannel as any,
        ...(type === 'INCOME' && { paymentKind: paymentKind as any }),
        ...(type === 'INCOME' && payerName.trim() && { payerName: payerName.trim() }),
        // === Google Sheet parity — новые enum-поля ===
        ...(type === 'INCOME' && incomeSource && { incomeSource }),
        ...(type === 'INCOME' && productCategoryEnum && { productCategoryEnum }),
        ...(type === 'INCOME' && paymentPhase && { paymentPhase }),
        ...(type === 'EXPENSE' && paidViaId && { paidViaId }),
        ...(type === 'EXPENSE' && {
          // При правке без нового файла поля чека не трогаем: иначе PATCH
          // затёр бы уже приложенный чек значением по умолчанию.
          ...(editTx && !receiptFile && receiptKind !== 'REASON_ONLY'
            ? {}
            : { receiptKind: receiptKind as any }),
          receiptUrl,
          ...(receiptKind === 'REASON_ONLY' && { noReceiptReason: noReceiptReason.trim() }),
        }),
      };
      if (editTx) await updateTransaction(editTx.id, dto);
      else await createTransaction(dto);
      toast(t(editTx ? 'toast.saved' : 'toast.created'), 'success');
      onCreated();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      setUploadingReceipt(false);
    }
  };

  /**
   * Переключение типа. Поля противоположной ветки сбрасываем: иначе
   * студент, выбранный для дохода, уехал бы в расходный запрос.
   */
  const switchType = (raw: TransactionType) => {
              // Защита: кнопку «Расход» не-elevated не видит, но если она
              // как-то нажата (своя сборка, devtools) — молча остаёмся на
              // доходе, чтобы вниз не ушёл ни один расходный путь.
              const tt: TransactionType = raw === 'EXPENSE' && !canExpense ? 'INCOME' : raw;
              const nextCategory: TransactionCategory = tt === 'INCOME' ? 'OTHER_INCOME' : 'SALARY';
              setType(tt);
              setCategory(nextCategory);
              // managerId держит одно значение для двух совершенно разных
              // ролей (менеджер клиента при INCOME / сотрудник-получатель
              // зарплаты при EXPENSE+SALARY). При смене type роль всегда
              // меняется, даже если новая пара тоже показывает какой-то
              // селект — INCOME-менеджер не должен «превратиться» в
              // получателя зарплаты (или наоборот) без явного выбора.
              // Поэтому сбрасываем безусловно на любое переключение type.
              setManagerId('');
              if (tt === 'EXPENSE') {
                // Сбрасываем поля, доступные только в INCOME-ветке. Иначе
                // состояние ранее заполненной формы (например, studentId,
                // выбранный до переключения) утечёт в EXPENSE-payload.
                setStudentId('');
                setPayerName('');
                setIncomeSource('');
                setProductCategoryEnum('');
                setPaymentPhase('');
              } else {
                // Симметрично чистим состояние EXPENSE-ветки при возврате.
                setPaidViaId('');
                setReceiptKind('RECEIPT');
                setNoReceiptReason('');
                setReceiptFile(null);
              }
  };

  return (
    <FormModal
      open
      title={t(editTx ? 'finance.tx.editTitle' : 'finance.newTransaction')}
      onClose={onClose}
      busy={submitting || uploadingReceipt}
      testId="finance-form"
    >
      <form onSubmit={onSubmit}>
        <div className="form-grid-2">
          {/* Тип — первым и кнопками: в списке среди прочих полей его не
              замечали и расход вносили как доход. */}
          <div className="form-group form-span-2">
            <label>{t('common.type')}</label>
            <div className="type-switch" role="group" aria-label={t('common.type')}>
              <button
                type="button"
                className={`type-switch-btn${type === 'INCOME' ? ' is-active is-income' : ''}`}
                data-testid="tx-type-income"
                onClick={() => switchType('INCOME')}
              >
                {t('finance.income')}
              </button>
              {/* Расход скрыт для не-elevated: сервер всё равно ответит 403
                  (finance.controller.ts), а до отказа успевает загрузиться
                  файл чека — остался бы мусор в /uploads. */}
              {canExpense && (
                <button
                  type="button"
                  className={`type-switch-btn${type === 'EXPENSE' ? ' is-active is-expense' : ''}`}
                  data-testid="tx-type-expense"
                  onClick={() => switchType('EXPENSE')}
                >
                  {t('finance.expense')}
                </button>
              )}
            </div>
          </div>
          <div className="form-group">
            <label>{t('finance.col.category')}</label>
            <CrmSelect className="crm-select" value={category} onChange={(e) => {
              const nextCategory = e.target.value as TransactionCategory;
              setCategory(nextCategory);
              // Внутри EXPENSE только SALARY показывает employee-селект
              // (managerId). При смене категории с SALARY на любую другую
              // (OFFICE_RENT, UTILITIES и т.д.) очищаем managerId, чтобы
              // выбранный ранее сотрудник не привязался к аренде/коммуналке.
              if (!needsManager(type, nextCategory)) setManagerId('');
            }}>
              {cats.map((c) => {
                // Пробуем i18n-ключ (RU/TJ), иначе — русский label из finance.ts.
                const trKey = `finance.cat.${c}`;
                const label = t(trKey) !== trKey ? t(trKey) : TRANSACTION_CATEGORY_LABEL[c];
                return <option key={c} value={c}>{label}</option>;
              })}
            </CrmSelect>
          </div>
          <div className="form-group">
            <label>{t('common.amount')}</label>
            <input
              className={`crm-input${amountErr ? ' input-error' : ''}`}
              type="number"
              step="0.01"
              value={amount}
              disabled={lockMoney}
              title={lockMoney ? t('finance.tx.viaDeal') : undefined}
              onChange={(e) => { setAmount(e.target.value); if (amountErr) setAmountErr(''); }}
              placeholder="0.00"
              data-testid="tx-amount"
            />
            {amountErr && <div className="form-error-text" data-testid="tx-amount-err">{amountErr}</div>}
          </div>
          {canSeeAccounts && accountOptions.length > 0 && (
            <div className="form-group">
              <label>{t('finance.acc.field')}</label>
              <CrmSelect
                className="crm-select"
                value={accountId}
                data-testid="tx-account"
                onChange={(e) => {
                  accountTouched.current = true;
                  const id = e.target.value;
                  setAccountId(id);
                  const acc = allAccounts.find((a) => a.id === id);
                  if (acc && !lockMoney) setCurrency(acc.currency);
                }}
              >
                <option value="">{t('finance.acc.byChannel')}</option>
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id} disabled={lockMoney && a.currency !== currency}>
                    {a.name} · {a.currency}{a.archived ? ` · ${t('finance.acc.archived')}` : ''}
                  </option>
                ))}
              </CrmSelect>
            </div>
          )}
          <div className="form-group">
            <label>{t('finance.col.currency')}</label>
            <CrmSelect className="crm-select" value={selectedAccount ? selectedAccount.currency : currency} disabled={lockMoney || !!selectedAccount} title={selectedAccount ? t('finance.acc.currencyFromAccount') : undefined} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="CNY">CNY</option>
              <option value="RUB">RUB</option>
              <option value="TJS">TJS</option>
            </CrmSelect>
          </div>
          <div className="form-group">
            <label>{t('common.date')}</label>
            <CrmDatePicker className="crm-input" value={date} disabled={lockMoney} onChange={(v) => setDate(v)} />
            {canSeeAccounts && accountsQ.data?.balanceSince && date && date < accountsQ.data.balanceSince && (
              <div className="form-hint" data-testid="tx-before-since">
                {t('finance.since.txHint').replace('{date}', fmtDate(accountsQ.data.balanceSince))}
              </div>
            )}
          </div>
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.col.student')}</label>
              <CrmSelect className="crm-select" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                <option value="">—</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>{s.fullName}</option>
                ))}
              </CrmSelect>
            </div>
          )}
          {(type === 'EXPENSE' && category === 'SALARY') && (
            <div className="form-group">
              <label>{t('salary.field.employee')}</label>
              {elevated ? (
                <CrmSelect className="crm-select" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                  <option value="">—</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.fullName}</option>
                  ))}
                </CrmSelect>
              ) : (
                <>
                  {/* Non-elevated: backend всё равно форсит caller.id
                      (finance.service.ts, non-elevated ветка). Показываем
                      disabled-select с собой, чтобы UI не врал про свободу
                      выбора и оператор понимал, что запись пойдёт на него. */}
                  <CrmSelect
                    className="crm-select"
                    value={me?.id ?? ''}
                    disabled
                    aria-disabled="true"
                    title={t('finance.form.salaryBound')}
                  >
                    <option value={me?.id ?? ''}>{me?.fullName || me?.email || '—'}</option>
                  </CrmSelect>
                  <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4, letterSpacing: '0.02em' }}>
                    {t('finance.form.autoBound')}
                  </div>
                </>
              )}
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.col.manager')}</label>
              {elevated ? (
                <CrmSelect className="crm-select" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                  <option value="">—</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.fullName}</option>
                  ))}
                </CrmSelect>
              ) : (
                <>
                  {/* Non-elevated: см. комментарий у employee-select выше.
                      Backend перезаписывает managerId на caller.id независимо
                      от переданного значения — раньше UI показывал полный
                      список, менеджер выбирал коллегу, форма молча уходила,
                      а строка ledger'а сохранялась на его имени. Data-loss с
                      точки зрения оператора. Теперь select только для чтения. */}
                  <CrmSelect
                    className="crm-select"
                    value={me?.id ?? ''}
                    disabled
                    aria-disabled="true"
                    title={t('finance.form.saleBound')}
                  >
                    <option value={me?.id ?? ''}>{me?.fullName || me?.email || '—'}</option>
                  </CrmSelect>
                  <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4, letterSpacing: '0.02em' }}>
                    {t('finance.form.saleBound')}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="form-group">
            <label>{t('finance.paymentChannel')}</label>
            <CrmSelect className="crm-select" value={paymentChannel} onChange={(e) => setPaymentChannel(e.target.value)}>
              <option value="CASH">{t('finance.channel.CASH')}</option>
              <option value="ALIF_MOBILE">{t('finance.channel.ALIF_MOBILE')}</option>
              <option value="BANK_TRANSFER">{t('finance.channel.BANK_TRANSFER')}</option>
              <option value="CARD">{t('finance.channel.CARD')}</option>
              <option value="CRYPTO">Crypto</option>
              <option value="OTHER">{t('userDoc.OTHER')}</option>
            </CrmSelect>
          </div>
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.paymentKind')}</label>
              <CrmSelect className="crm-select" value={paymentKind} onChange={(e) => setPaymentKind(e.target.value)}>
                <option value="FULL">{t('finance.kind.FULL')}</option>
                <option value="PREPAYMENT">{t('finance.kind.PREPAYMENT')}</option>
                <option value="ADDITIONAL">{t('finance.kind.ADDITIONAL')}</option>
                <option value="OWNER_INVESTMENT">{t('finance.kind.OWNER_INVESTMENT')}</option>
              </CrmSelect>
            </div>
          )}
          {/* === Google Sheet parity — INCOME dropdowns === */}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.field.incomeSource')}</label>
              <CrmSelect
                className="crm-select"
                value={incomeSource}
                onChange={(e) => setIncomeSource(e.target.value as IncomeSource | '')}
              >
                <option value="">—</option>
                <option value="NEW_CLIENT">{t('finance.source.NEW_CLIENT')}</option>
                <option value="UP_SALE">{t('finance.source.UP_SALE')}</option>
                <option value="OTHER">{t('finance.source.OTHER')}</option>
              </CrmSelect>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.field.productEnum')}</label>
              <CrmSelect
                className="crm-select"
                value={productCategoryEnum}
                data-testid="tx-product"
                onChange={(e) => setProductCategoryEnum(e.target.value as ProductCategoryEnum | '')}
              >
                <option value="">—</option>
                <option value="CONTRACT">{t('finance.productEnum.CONTRACT')}</option>
                <option value="MASTERCLASS">{t('finance.productEnum.MASTERCLASS')}</option>
                <option value="ACADEMY">{t('finance.productEnum.ACADEMY')}</option>
                <option value="OTHER">{t('finance.productEnum.OTHER')}</option>
              </CrmSelect>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.field.paymentPhase')}</label>
              <CrmSelect
                className="crm-select"
                value={paymentPhase}
                onChange={(e) => setPaymentPhase(e.target.value as PaymentPhaseStatus | '')}
              >
                <option value="">—</option>
                <option value="PREPAID">{t('finance.phase.PREPAID')}</option>
                <option value="FULL">{t('finance.phase.FULL')}</option>
              </CrmSelect>
            </div>
          )}
          {/* === EXPENSE: через кого прошёл расход === */}
          {type === 'EXPENSE' && (
            <div className="form-group">
              <label>{t('finance.field.paidVia')}</label>
              <CrmSelect
                className="crm-select"
                value={paidViaId}
                onChange={(e) => setPaidViaId(e.target.value)}
              >
                <option value="">—</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </CrmSelect>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label>{t('finance.payerName')}</label>
              <input className="crm-input" type="text" value={payerName} onChange={(e) => setPayerName(e.target.value)} />
            </div>
          )}
          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
            <label>{t('app.field.comment')}</label>
            <input className="crm-input" type="text" value={comment} onChange={(e) => setComment(e.target.value)} data-testid="tx-comment" />
          </div>

          {type === 'EXPENSE' && (
            <div className="form-group" style={{ gridColumn: '1 / -1', padding: 14, background: 'var(--bg-soft)', borderRadius: 12 }}>
              <label style={{ fontWeight: 600, marginBottom: 8 }}>
                {t('finance.receipt.title')}
              </label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <RadioBtn label={`📄 ${t('finance.receipt.RECEIPT')}`} active={receiptKind === 'RECEIPT'} onClick={() => setReceiptKind('RECEIPT')} />
                <RadioBtn label={`💵 ${t('finance.receipt.CASH_PHOTO')}`} active={receiptKind === 'CASH_PHOTO'} onClick={() => setReceiptKind('CASH_PHOTO')} />
                <RadioBtn label={`📝 ${t('finance.receipt.REASON_ONLY')}`} active={receiptKind === 'REASON_ONLY'} onClick={() => setReceiptKind('REASON_ONLY')} />
              </div>
              {receiptKind === 'REASON_ONLY' ? (
                <input
                  className="crm-input"
                  type="text"
                  value={noReceiptReason}
                  onChange={(e) => setNoReceiptReason(e.target.value)}
                  placeholder={t('finance.receipt.reasonPlaceholder')}
                  required
                />
              ) : (
                <div>
                  <input
                    className="crm-input"
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                    // Обязательно только при создании: у существующего
                    // расхода чек уже приложен, и браузер иначе молча
                    // блокировал отправку правки.
                    required={!editTx}
                  />
                  {receiptFile && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-soft)' }}>
                      {receiptFile.name} · {(receiptFile.size / 1024).toFixed(0)} {t('finance.kb')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={submitting || uploadingReceipt}>
            {uploadingReceipt ? t('finance.receipt.uploading') : submitting ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </FormModal>
  );
}

function RadioBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px',
        border: `1.5px solid ${active ? 'var(--primary)' : 'var(--input-border)'}`,
        borderRadius: 999,
        background: active ? 'var(--primary-soft)' : 'white',
        color: active ? 'var(--primary-dark)' : 'var(--text)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}
