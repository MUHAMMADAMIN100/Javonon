import { useEffect, useMemo, useRef, useState } from 'react';
import CrmSelect from '../components/CrmSelect';
import { pageParam, useUrlListState } from '../lib/useUrlListState';
import Pagination from '../components/Pagination';
import ListTotal from '../components/ListTotal';
import FinanceDetails, { type FinanceDetailKind } from '../components/FinanceDetails';
import PeriodSwitcher, { useDashboardPeriod } from '../components/PeriodSwitcher';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Transaction,
  TransactionType,
  TransactionCategory,
  TRANSACTION_CATEGORY_LABEL,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  CreateTransactionDto,
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_TEXT,
  listTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  financeOverview,
  type FinanceOverview,
  pendingPayments,
  IncomeSource,
  NonTjsTotals,
  ProductCategoryEnum,
  PaymentPhaseStatus,
} from '../api/finance';
import { listStudents } from '../api/students';
import { listUsers } from '../api/users';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { aiAddTransaction } from '../api/ai';
import { listPayments, confirmPayment, rejectPayment, type Payment, PAYMENT_METHOD_LABEL } from '../api/payments';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import CrmDatePicker from '../components/CrmDatePicker';
import FormModal from '../components/FormModal';
import { fmtDateText, TJ_TZ, tjToday } from '../lib/tjTime';
import { useT } from '../lib/i18n';
import { useRealtime } from '../realtime';
import { useAuth } from '../store/auth';
import { hasRole, isElevated } from '../lib/roles';
import { hasPermission } from '../lib/permissions';

function fmtMoney(n: number, currency = 'TJS'): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso: string): string {
  // «YYYY-MM-DD» — календарный день как есть; момент времени — по Душанбе,
  // а не по часам браузера (иначе операция в 01:00 по Душанбе у бухгалтера
  // в другом поясе попадала бы во вчера).
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return fmtDateText(dayOnly ? `${iso}T00:00:00Z` : iso, {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: dayOnly ? 'UTC' : TJ_TZ,
  });
}

/**
 * Компактная строка вида «В ПЕРИОДЕ ТАКЖЕ · USD +5 000 / −200 · EUR +200».
 * Показываем под KPI/над пирогами когда backend вернул `nonTjsTotals` с
 * ненулевыми суммами. Мотивация: backend считает все агрегаты только в
 * TJS, но фиксирует валютные транзакции периода отдельно — бухгалтер
 * должен видеть, что USD/EUR активность была, иначе дашборд молча
 * «прячет» реальную выручку (см. commit-audit по currency mixing).
 *
 * `kind` фильтрует, что показывать: для income-пирогов не нужно тащить
 * валютные расходы, для expense-пирога — наоборот. Без `kind` (например
 * под netProfit-KPI) показываем и то и другое, чтобы дать полную картину.
 */
function NonTjsStrip({
  totals,
  color = 'var(--text-soft)',
  kind,
}: {
  totals?: NonTjsTotals | null;
  color?: string;
  kind?: 'income' | 'expense';
}) {
  const { t } = useT();
  if (!totals) return null;
  const entries = Object.entries(totals);
  if (entries.length === 0) return null;

  const parts: string[] = [];
  for (const [cur, bucket] of entries) {
    const bits: string[] = [];
    if ((!kind || kind === 'income') && bucket.income > 0) {
      bits.push(`+${fmtMoney(bucket.income, cur)}`);
    }
    if ((!kind || kind === 'expense') && bucket.expense > 0) {
      bits.push(`−${fmtMoney(bucket.expense, cur)}`);
    }
    if (bits.length > 0) parts.push(`${cur} ${bits.join(' / ')}`);
  }
  if (parts.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 8,
        marginBottom: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.08em',
        color,
        textTransform: 'uppercase',
      }}
      title={t('finance.nonTjs.hint')}
    >
      {t('finance.nonTjs.alsoInPeriod')} · {parts.join(' · ')}
    </div>
  );
}

/**
 * Маленький бэйдж «BASE · TJS» рядом с eyebrow пирога/ранжирования.
 *
 * Мотивация: агрегаты дашборда считаются только в одной валюте
 * (`REPORTING_CURRENCY` на backend), но раньше UI никак не сообщал, в чём
 * именно считает — и пользователь смотрел на пустой пирог или неполный
 * «ТОП» без понимания, что USD/EUR-транзакции просто отфильтрованы (см.
 * audit HIGH — «pie charts silently hide currency-based bias»). Бэйдж
 * ставим справа от eyebrow, tooltip раскрывает причину.
 */
function CurrencyBadge({ currency }: { currency: string }) {
  const { t } = useT();
  const baseLabel = t('finance.badge.base');
  return (
    <span
      title={t('finance.badge.hint').replace('{currency}', currency)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 6px',
        border: '1px solid var(--border)',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.1em',
        color: 'var(--text-soft)',
        textTransform: 'uppercase',
        lineHeight: 1.2,
      }}
    >
      {baseLabel} · {currency}
    </span>
  );
}

export default function Finance() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  // === Role/permission gating (audit HIGH — SALES_MANAGER на /finance) ===
  // До фикса каждая кнопка/форма рендерилась безусловно: SALES_MANAGER,
  // которому FOUNDER дал `finance:read` (кастомная роль «Наблюдатель за
  // выручкой»), или который просто набрал /finance в адресной строке,
  // видел UI как FOUNDER — DELETE-иконку, форму EXPENSE, подтверждение
  // клиентских платежей — и каждая мутация оборачивалась в 403 от backend.
  // Зеркалим backend-политику (finance.controller.ts, payments.controller.ts,
  // finance.service.ts::create/remove) прямо в UI, чтобы не давать
  // недоступные действия визуально.
  const me = useAuth((s) => s.user);
  // Собственный id — используется как self-attribute-fallback для
  // managerId non-elevated пользователей: backend всё равно перезапишет
  // managerId на caller.id (finance.service.ts), а UI явно показывает
  // «оформляю на себя», чтобы SALES_MANAGER не удивлялся, что строчка
  // ушла на его имя вместо чужого менеджера, привязанного к заявке.
  const mySelfId = me?.id ?? '';
  // FOUNDER / ADMIN / ACCOUNTANT — полный доступ к финмодулю.
  const elevated = isElevated(me);
  // Кастомная роль (Настройки → Роли) в backend RolesGuard ЗАМЕНЯЕТ базу
  // (см. roles.guard.ts skipBaseRole). Держим тот же флаг, чтобы
  // SALES_MANAGER с custom-role «Наблюдатель» (только finance:read) не
  // получал по base-role доступ к POST /finance/transactions.
  const hasCustomRole = !!(me?.customRoleId);
  const managerBaseRole = hasRole(me, 'SALES_MANAGER', 'CLIENT_MANAGER');
  // POST /finance/transactions: @Roles('ADMIN','ACCOUNTANT','SALES_MANAGER',
  // 'CLIENT_MANAGER'). custom-role пропускает по явному permission.
  const canCreateTx =
    elevated ||
    (!hasCustomRole && managerBaseRole) ||
    hasPermission(me, 'finance:create', 'finance:write');
  // DELETE /finance/transactions/:id — @Roles('ADMIN','ACCOUNTANT') на
  // контроллере (finance.controller.ts:223+374). custom-role может открыть
  // явным `finance:delete`/`finance:write`.
  const canDeleteTx =
    elevated || hasPermission(me, 'finance:delete', 'finance:write');
  // POST /payments/:id/confirm|reject — @Roles('ADMIN','ACCOUNTANT') на
  // контроллере (payments.controller.ts:13). Бухгалтерская мутация уровня
  // FOUNDER, custom-role сюда сознательно не пускаем без явного расширения
  // backend — иначе SALES_MANAGER с `finance:read` увидит клиентские
  // «поступления в кассу» и сможет подтвердить чужие деньги.
  const canReviewPayments = elevated;
  // AI-add — раньше был доступен всем ролям и мог создать EXPENSE (модель
  // сама решает тип по фразе). Non-elevated тогда молча ловил 403 после
  // распознавания. Раз EXPENSE запрещён, оставляем AI-quick-entry только
  // elevated: у них семантика «быстро набросать любой тип», у менеджера —
  // явная форма INCOME.
  // POST /finance/transactions на backend: type=EXPENSE разрешён только
  // FOUNDER / ADMIN / ACCOUNTANT (finance.controller.ts:291). Раньше форма
  // «Новая транзакция» показывала EXPENSE всем: SALES_MANAGER выбирал
  // «Расход», заполнял всё, uploadReceipt POST'ил файл на диск,
  // createTransaction возвращал 403 → orphan-файл в /uploads/ + непонятный
  // Russian toast. Гейтим по роли на клиенте: hide-option (a) — самый
  // чистый вариант, менеджер даже не видит EXPENSE, поэтому не может
  // случайно потянуть файл на диск. Backend-проверка остаётся источником
  // истины (см. finance.controller.ts).
  const canExpense = hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT');
  const [filterType, setFilterType] = useState<TransactionType | ''>('');
  const [filterIncomeSource, setFilterIncomeSource] = useState<IncomeSource | ''>('');
  const [filterProductEnum, setFilterProductEnum] = useState<ProductCategoryEnum | ''>('');
  const [filterPaymentPhase, setFilterPaymentPhase] = useState<PaymentPhaseStatus | ''>('');
  const [showForm, setShowForm] = useState(false);
  // ОДИН период на всю страницу (как на дашборде, тот же переключатель и
  // та же ссылка ?period=…): карточки, график, диаграммы, топ менеджеров,
  // распределение и журнал считаются за одни и те же даты — «Доход»
  // всегда равен сумме диаграммы и сумме строк журнала. По умолчанию —
  // текущий месяц (Asia/Dushanbe).
  const period = useDashboardPeriod();
  const range = period.range;
  const rangeOk = !period.invalid;
  // Страница журнала — в ссылке, как в остальных списках CRM.
  const { values: txUrl, setValue: setTxUrl } = useUrlListState(
    { page: pageParam() },
    { pageKey: 'page' },
  );
  const { page: txPage } = txUrl;
  /** Открытая карточка транзакции (id, а не объект: список перезапрашивается). */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);

  const txParams = {
    ...(filterType ? { type: filterType } : {}),
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    take: 200,
  };
  const txKey = keys.finance.transactions(txParams);
  const txQuery = useQuery({
    queryKey: txKey,
    queryFn: () => listTransactions(txParams),
    enabled: rangeOk,
  });
  const allTransactions = txQuery.data ?? [];
  // Клиентская доп-фильтрация по новым Google-Sheet-parity полям
  // (backend их пока не принимает как ?query-параметры — фильтруем
  // локально). Активно только когда пользователь ставит хоть один
  // из фильтров источник/продукт/фаза.
  const transactions = useMemo(() => {
    if (!filterIncomeSource && !filterProductEnum && !filterPaymentPhase) {
      return allTransactions;
    }
    return allTransactions.filter((tx) => {
      if (filterIncomeSource && tx.incomeSource !== filterIncomeSource) return false;
      if (filterProductEnum && tx.productCategoryEnum !== filterProductEnum) return false;
      if (filterPaymentPhase && tx.paymentPhase !== filterPaymentPhase) return false;
      return true;
    });
  }, [allTransactions, filterIncomeSource, filterProductEnum, filterPaymentPhase]);

  /** Строк на странице журнала. Десять — как просили: экран не листается. */
  const TX_PAGE_SIZE = 10;
  const categoryLabel = (tx: Transaction) =>
    t(`finance.cat.${tx.category}`) !== `finance.cat.${tx.category}`
      ? t(`finance.cat.${tx.category}`)
      : TRANSACTION_CATEGORY_LABEL[tx.category];
  const txSort = useTableSort(
    transactions,
    [
      { key: 'date', label: t('finance.col.date'), type: 'date', value: (tx) => tx.date },
      {
        key: 'type',
        label: t('finance.col.type'),
        value: (tx) => (tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')),
      },
      { key: 'category', label: t('finance.col.category'), value: categoryLabel },
      { key: 'amount', label: t('finance.col.amount'), type: 'number', value: (tx) => Number(tx.amount) },
      {
        key: 'student',
        label: t('finance.col.student'),
        value: (tx) => tx.student?.fullName || tx.manager?.fullName,
      },
      { key: 'comment', label: t('finance.col.comment'), value: (tx) => tx.comment },
    ],
    { pageParam: 'page' },
  );
  const pagedTransactions = txSort.sorted.slice(
    (txPage - 1) * TX_PAGE_SIZE,
    txPage * TX_PAGE_SIZE,
  );
  // Фильтры могут сократить список так, что текущей страницы уже нет.
  useEffect(() => {
    const last = Math.max(1, Math.ceil(transactions.length / TX_PAGE_SIZE));
    if (txPage > last) setTxUrl('page', 1);
  }, [transactions.length, txPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Карточки владельца: выручка, прибыль, зарплаты, расходы, средний чек.
  const overviewQuery = useQuery({
    queryKey: keys.finance.overview(range),
    queryFn: () => financeOverview(range),
    enabled: rangeOk,
  });
  const overview = overviewQuery.data ?? null;
  /** Открытое окно карточки (подробности по цифре). */
  const [detail, setDetail] = useState<FinanceDetailKind | null>(null);

  const pendingQuery = useQuery({
    queryKey: keys.finance.pending(),
    queryFn: () => pendingPayments(),
  });
  const pending = pendingQuery.data ?? [];


  // Распределение по схеме + топ менеджеров — за тот же период страницы.
  const distributionQuery = useQuery({
    queryKey: ['finance', 'distribution', range.from ?? '', range.to ?? ''],
    queryFn: async () => {
      const m = await import('../api/finance');
      return m.financeDistribution(range);
    },
    enabled: rangeOk,
  });
  const distribution = distributionQuery.data;






  const paymentsKey = keys.payments.list({ status: 'PENDING' });
  const paymentsQuery = useQuery({
    queryKey: paymentsKey,
    queryFn: () => listPayments('PENDING'),
  });
  const paymentRequests = paymentsQuery.data ?? [];

  const studentsQuery = useQuery({
    queryKey: keys.students.list(),
    queryFn: () => listStudents({}),
  });
  const students = studentsQuery.data ?? [];

  const paymentsSort = useTableSort(
    paymentRequests,
    [
      { key: 'date', label: t('common.date'), type: 'date', value: (p) => p.createdAt },
      { key: 'student', label: t('finance.col.student'), value: (p) => p.student?.fullName },
      { key: 'amount', label: t('common.amount'), type: 'number', value: (p) => Number(p.amount) },
      { key: 'type', label: t('common.type'), value: (p) => PAYMENT_METHOD_LABEL[p.method] },
      { key: 'comment', label: t('common.comment'), value: (p) => p.comment },
    ],
    { param: 'sortRequests' },
  );
  const pendingSort = useTableSort(
    pending,
    [
      { key: 'student', label: t('finance.col.student'), value: (a) => a.fullName },
      { key: 'program', label: t('sidebar.programs'), value: (a) => a.program?.name },
      { key: 'amount', label: t('common.amount'), type: 'number', value: (a) => (a.program ? Number(a.program.cost) : null) },
      { key: 'manager', label: t('finance.col.manager'), value: (a) => a.manager?.fullName },
    ],
    { param: 'sortDebts' },
  );

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
  });
  const users = usersQuery.data ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.finance.all });
    qc.invalidateQueries({ queryKey: keys.payments.all });
  };

  // Realtime: подписываемся на WS-события из finance/payments/submissions
  // сервисов и invalidate'им соответствующие queryKeys. Backend эмитит эти
  // события в `staff`-комнату (см. finance.service.ts:566, 863, 1223 и
  // payments.service.ts:78, 158-159, submissions.service.ts:1065, 1308).
  //
  // Ранее Finance.tsx не подписывался ни на одно из них, из-за чего
  // FOUNDER + ACCOUNTANT, одновременно работающие с /finance, видели
  // stale summary/breakdown/topManagers до hard reload — именно тот
  // сценарий, ради которого backend WS-emit'ы были добавлены.
  //
  // Debounce: серия быстрых POST'ов (импорт, массовые операции) может
  // прилететь плотным потоком; каждый invalidate триггерит перезапрос
  // тяжёлых aggregate-эндпоинтов (summary/breakdown/topManagers/
  // distribution). Собираем инвалидации в 400ms-окно, чтобы не долбить
  // backend по 5+ раз в секунду. Ref-flags удерживают, какие бакеты
  // нужно инвалидировать по итогу окна.
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInvalidateRef = useRef<{ finance: boolean; payments: boolean }>({
    finance: false,
    payments: false,
  });
  const scheduleInvalidate = (buckets: { finance?: boolean; payments?: boolean }) => {
    if (buckets.finance) pendingInvalidateRef.current.finance = true;
    if (buckets.payments) pendingInvalidateRef.current.payments = true;
    if (invalidateTimerRef.current) return;
    invalidateTimerRef.current = setTimeout(() => {
      invalidateTimerRef.current = null;
      const flags = pendingInvalidateRef.current;
      pendingInvalidateRef.current = { finance: false, payments: false };
      if (flags.finance) qc.invalidateQueries({ queryKey: keys.finance.all });
      if (flags.payments) qc.invalidateQueries({ queryKey: keys.payments.all });
    }, 400);
  };
  useEffect(() => {
    return () => {
      if (invalidateTimerRef.current) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
    };
  }, []);

  useRealtime({
    // Транзакции: любое изменение — списка, summary, breakdown, timeseries,
    // topManagers, distribution, income-sources, income-by-product зависят
    // от финансовых данных, поэтому инвалидируем всё дерево finance.
    'transaction:new': () => scheduleInvalidate({ finance: true }),
    'transaction:updated': () => scheduleInvalidate({ finance: true }),
    'transaction:deleted': () => scheduleInvalidate({ finance: true }),
    // Рефанд по TUITION_PAYMENT создаёт reverse-пару транзакций и
    // пересчитывает баланс студента — те же aggregate'ы уходят в stale.
    'transaction:reversed': () => scheduleInvalidate({ finance: true }),
    // Payments: приход новой заявки и её подтверждение должны обновить
    // и список PENDING (payments.list), и pending-виджет + summary
    // (payments confirmed => появляется новая транзакция в finance).
    'payment:pending': () => scheduleInvalidate({ payments: true, finance: true }),
    'payment:confirmed': () => scheduleInvalidate({ payments: true, finance: true }),
  });

  // Confirm payment — оптимистично убираем из PENDING-списка.
  const confirmPayMut = useOptimisticMutation<Payment, Payment, Payment[]>({
    mutationFn: (p) => confirmPayment(p.id, {}),
    queryKey: paymentsKey,
    applyOptimistic: (cur, p) => optimistic.removeById(cur, p.id),
    invalidateAlso: [keys.finance.all, keys.payments.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const rejectPayMut = useOptimisticMutation<Payment, Payment, Payment[]>({
    mutationFn: (p) => rejectPayment(p.id),
    queryKey: paymentsKey,
    applyOptimistic: (cur, p) => optimistic.removeById(cur, p.id),
    invalidateAlso: [keys.payments.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteTxMut = useOptimisticMutation<unknown, string, Transaction[]>({
    mutationFn: deleteTransaction,
    queryKey: txKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.finance.all],
    onSuccess: () => toast(t('toast.deleted'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });


  const onConfirmPayment = async (p: Payment) => {
    const ok = await confirm({
      title: t('finance.payment.confirm') + '?',
      message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`,
      confirmText: t('finance.payment.confirm'),
    });
    if (!ok) return;
    confirmPayMut.mutate(p);
  };

  const onRejectPayment = async (p: Payment) => {
    const ok = await confirm({
      title: t('finance.payment.reject') + '?',
      message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`,
      danger: true,
      confirmText: t('finance.payment.reject'),
    });
    if (!ok) return;
    rejectPayMut.mutate(p);
  };


  const onDelete = async (tx: Transaction) => {
    const ok = await confirm({
      title: t('finance.confirm.delete'),
      message: `${tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')} ${fmtMoney(tx.amount, tx.currency)}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    deleteTxMut.mutate(tx.id);
  };

  return (
    <>
      {/* Один период на всю страницу — тот же переключатель, что на дашборде. */}
      <PeriodSwitcher state={period} busy={overviewQuery.isFetching || txQuery.isFetching} />
      {/* Главное для владельца — сразу под периодом: выручка, прибыль,
          зарплаты, расходы, средний чек и долги клиентов. */}
      {/* Нет доступа к сводке (менеджер открыл страницу по ссылке) — карточек нет, а не пустые прочерки. */}
      {!overviewQuery.isError && <OwnerKpis
        overview={overview}
        loading={overviewQuery.isLoading}
        range={range}
        debts={pending}
        onOpen={setDetail}
      />}
      <FinanceDetails
        kind={detail}
        range={range}
        periodLabel={periodLabel(range, t)}
        overview={overview}
        onClose={() => setDetail(null)}
      />

      {/* Заявки на оплату от клиентов (от студентов) — ждут подтверждения
          бухгалтера. Backend: POST /payments/:id/confirm|reject доступны
          только ADMIN/ACCOUNTANT/FOUNDER (payments.controller.ts:13). До
          фикса блок рендерился всем ролям, у SALES_MANAGER с finance:read
          «висели» кнопки confirm/reject, которые упирались в 403 —
          вводило в заблуждение и открывало доступ к чужим клиентским
          суммам. Прячем блок целиком для не-elevated ролей. */}
      {canReviewPayments && paymentRequests.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="crm-section-head">
            <span className="crm-section-eyebrow" style={{ color: 'var(--primary-dark)' }}>{t('eyebrow.paymentRequests')}</span>
            <h2 className="crm-section-title">{t('finance.paymentRequests')}</h2>
          </div>
          <SortSelect sort={paymentsSort} />
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', tableLayout: 'fixed' }}>
              {/* QA-fix #5: фиксируем ширины и no-wrap для заголовков
                  (раньше «КОГДА / СТУДЕНТ» сжимались до 1 буквы), плюс
                  truncate для длинного комментария чтобы не ломал layout. */}
              <colgroup>
                <col style={{ width: '13%' }} />
                <col style={{ width: '19%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '21%' }} />
              </colgroup>
              <thead>
                <tr>
                  {paymentsSort.columns.map((c) => (
                    <SortTh key={c.key} sort={paymentsSort} col={c.key} style={{ whiteSpace: 'nowrap' }} />
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {paymentsSort.sorted.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(p.createdAt)}</td>
                    <td style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.student?.fullName}</td>
                    <td style={{
                      fontFamily: 'var(--font-display)',
                      fontWeight: 500,
                      fontSize: 18,
                      color: 'var(--primary-dark)',
                      whiteSpace: 'nowrap',
                    }}>{fmtMoney(p.amount, p.currency)}</td>
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{PAYMENT_METHOD_LABEL[p.method]}</td>
                    <td
                      style={{
                        color: 'var(--text-soft)', fontSize: 13,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        maxWidth: 0,
                      }}
                      title={p.comment || ''}
                    >
                      {p.comment || '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-primary" onClick={() => onConfirmPayment(p)}>
                          <Icon name="check" size={14} /> {t('finance.payment.confirm')}
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => onRejectPayment(p)}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/*
        Задолженность студентов.

        Раздел рисуется ВСЕГДА, даже когда должников ноль. Раньше здесь стояло
        `pending.length > 0 &&`, и пустой ответ прятал блок целиком — экран
        выглядел так, будто раздела просто нет. Это опасно именно для
        дебиторки: неотличимо «долгов действительно нет» от «запрос перестал
        находить должников» (ровно так и случилось, когда признак долга
        переехал со статуса AWAITING_PAYMENT на флаг paymentPending). Явное
        «должников нет» — утверждение, которое бухгалтер может оспорить;
        отсутствие блока оспорить нельзя.

        Ошибку запроса тоже показываем текстом, а не пустой таблицей.
      */}
      <div id="finance-debts" style={{ marginBottom: 32, scrollMarginTop: 90 }}>
        <div className="crm-section-head">
          <span className="crm-section-eyebrow" style={{ color: '#b45309' }}>{t('eyebrow.outstandingPayment')}</span>
          <h2 className="crm-section-title">{t('finance.outstanding')}</h2>
        </div>
        {pendingQuery.isError ? (
          <div className="error-banner">{t('finance.outstanding.error')}</div>
        ) : pendingQuery.isLoading ? (
          <div className="card" style={{ color: 'var(--text-light)' }}>{t('common.loading')}</div>
        ) : pending.length === 0 ? (
          <div className="card" style={{ color: 'var(--text-light)' }}>{t('finance.outstanding.empty')}</div>
        ) : (
          <>
          <SortSelect sort={pendingSort} />
          <div className="card" style={{ padding: 0 }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  {pendingSort.columns.map((c) => <SortTh key={c.key} sort={pendingSort} col={c.key} />)}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pendingSort.sorted.map((app) => (
                  <tr key={app.id}>
                    <td style={{ fontWeight: 500 }}>{app.fullName}</td>
                    <td>{app.program?.name || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                    <td style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 16 }}>
                      {app.program ? fmtMoney(app.program.cost, app.program.currency || 'TJS') : '—'}
                    </td>
                    <td>{app.manager?.fullName || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                    <td>
                      {/* «Внести оплату» открывает ту же TransactionForm.
                          Гейтим по canCreateTx (кто в принципе имеет право
                          на POST). Для менеджера без finance:create кнопка
                          скрыта — иначе он попадал бы в форму, из которой
                          всё равно ничего не смог бы отправить.
                          Дополнительно: не-elevated менеджер может внести
                          оплату только по своему студенту (backend
                          ownership-check в finance.service.create). Если
                          заявка чужого менеджера — кнопка скрыта, чтобы
                          не порождать «случайный клик → 403 по чужому
                          студенту». */}
                      {canCreateTx && (elevated || !app.managerId || app.managerId === mySelfId) && (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => {
                            setShowForm(true);
                            // Pre-select student in form via state below.
                            // Для non-elevated backend перепишет managerId
                            // на caller.id независимо от значения ниже,
                            // но передаём осмысленный default для elevated.
                            setPreselectedStudent({
                              studentId: app.studentId,
                              managerId: elevated ? app.managerId : mySelfId,
                              amount: app.program?.cost,
                              currency: app.program?.currency,
                            });
                          }}
                        >
                          {t('finance.recordPayment')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

      {/* Распределение прибыли по схеме, которую задаёт основатель. */}
      {distribution && (
        <div style={{ marginBottom: 32 }}>
          <RevenueDistributionCard breakdown={distribution} />
        </div>
      )}

      {/* Управление транзакциями */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">{t('eyebrow.ledgerAll')}</span>
        <h2 className="crm-section-title">{t('finance.ledger')}</h2>
        {/* Сколько операций за период — столько строк в журнале (с фильтрами — «найдено X из N»). */}
        <ListTotal
          noun="transactions"
          found={transactions.length}
          total={transactions.length !== allTransactions.length ? allTransactions.length : undefined}
          filtered={transactions.length !== allTransactions.length}
          testId="finance-tx-total"
        />
      </div>

      <div className="filters" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div className="pagination-controls" style={{ padding: 4 }}>
          <button
            className={!filterType ? 'active' : ''}
            onClick={() => setFilterType('')}
          >
            {t('common.all')}
          </button>
          <button
            className={filterType === 'INCOME' ? 'active' : ''}
            onClick={() => setFilterType('INCOME')}
          >
            {t('finance.income')}
          </button>
          <button
            className={filterType === 'EXPENSE' ? 'active' : ''}
            onClick={() => setFilterType('EXPENSE')}
          >
            {t('finance.expense')}
          </button>
        </div>
        {/* Доп-фильтры для INCOME (источник / продукт / фаза оплаты).
            Показываем всегда когда фильтр не EXPENSE — для «Все» они тоже
            имеют смысл (пустые значения = «не выбрано»). */}
        {filterType !== 'EXPENSE' && (
          <>
            <CrmSelect
              className="crm-select"
              value={filterIncomeSource}
              onChange={(e) => setFilterIncomeSource(e.target.value as IncomeSource | '')}
              style={{ minWidth: 160 }}
              aria-label={t('finance.field.incomeSource')}
            >
              <option value="">{t('finance.field.incomeSource')}: {t('common.all')}</option>
              <option value="NEW_CLIENT">{t('finance.source.NEW_CLIENT')}</option>
              <option value="UP_SALE">{t('finance.source.UP_SALE')}</option>
              <option value="OTHER">{t('finance.source.OTHER')}</option>
            </CrmSelect>
            <CrmSelect
              className="crm-select"
              value={filterProductEnum}
              onChange={(e) => setFilterProductEnum(e.target.value as ProductCategoryEnum | '')}
              style={{ minWidth: 160 }}
              aria-label={t('finance.field.productEnum')}
            >
              <option value="">{t('finance.field.productEnum')}: {t('common.all')}</option>
              <option value="CONTRACT">{t('finance.productEnum.CONTRACT')}</option>
              <option value="MASTERCLASS">{t('finance.productEnum.MASTERCLASS')}</option>
              <option value="ACADEMY">{t('finance.productEnum.ACADEMY')}</option>
              <option value="OTHER">{t('finance.productEnum.OTHER')}</option>
            </CrmSelect>
            <CrmSelect
              className="crm-select"
              value={filterPaymentPhase}
              onChange={(e) => setFilterPaymentPhase(e.target.value as PaymentPhaseStatus | '')}
              style={{ minWidth: 160 }}
              aria-label={t('finance.field.paymentPhase')}
            >
              <option value="">{t('finance.field.paymentPhase')}: {t('common.all')}</option>
              <option value="PREPAID">{t('finance.phase.PREPAID')}</option>
              <option value="FULL">{t('finance.phase.FULL')}</option>
            </CrmSelect>
            {(filterIncomeSource || filterProductEnum || filterPaymentPhase) && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setFilterIncomeSource('');
                  setFilterProductEnum('');
                  setFilterPaymentPhase('');
                }}
              >
                <Icon name="close" size={14} /> {t('common.reset')}
              </button>
            )}
          </>
        )}
        <div style={{ flex: 1 }} />
        {/* «Новая транзакция» — гейт по backend @Roles на POST
            /finance/transactions (ADMIN/ACCOUNTANT/SALES_MANAGER/CLIENT_MANAGER)
            + custom-role permission `finance:create`/`finance:write`. Раньше
            SALES_MANAGER с `finance:read` из custom-роли видел кнопку,
            открывал форму, заполнял и получал 403 на первом клике. */}
        {canCreateTx && (
          <button className="btn btn-primary" data-testid="finance-new" onClick={() => setShowForm(true)}>
            <Icon name="add" size={18} /> {t('finance.newTransaction')}
          </button>
        )}
      </div>

      <AnimatePresence>
        {showForm && (
          <TransactionForm
            students={students}
            users={users}
            preselect={preselectedStudent}
            canExpense={canExpense}
            onClose={() => { setShowForm(false); setPreselectedStudent(null); }}
            onCreated={() => {
              setShowForm(false);
              setPreselectedStudent(null);
              refresh();
            }}
          />
        )}
      </AnimatePresence>


      {transactions.length > 0 && <SortSelect sort={txSort} />}
      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }} data-testid="tx-table">
          <thead>
            <tr>
              {txSort.columns.map((c) => <SortTh key={c.key} sort={txSort} col={c.key} />)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 && (
              <tr><td colSpan={7} className="empty">{t('finance.empty')}</td></tr>
            )}
            {pagedTransactions.map((tx) => (
              <tr
                key={tx.id}
                className="tx-row"
                data-testid={`tx-row-${tx.id}`}
                role="button"
                tabIndex={0}
                title={t('finance.tx.details')}
                onClick={() => setDetailId(tx.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setDetailId(tx.id);
                  }
                }}
              >
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fmtDate(tx.date)}</td>
                <td>
                  <span className={`badge ${tx.type === 'INCOME' ? 'badge-success' : 'badge-danger'}`}>
                    {tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')}
                  </span>
                </td>
                <td>{categoryLabel(tx)}</td>
                <td style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 500,
                  fontSize: 17,
                  letterSpacing: '-0.01em',
                  color: tx.type === 'INCOME' ? 'var(--primary-dark)' : 'var(--danger)',
                }}>
                  {tx.type === 'INCOME' ? '+' : '−'} {fmtMoney(tx.amount, tx.currency)}
                </td>
                <td style={{ fontSize: 13 }}>
                  {tx.student && <div>👤 {tx.student.fullName}</div>}
                  {tx.manager && <div style={{ color: 'var(--text-soft)' }}>💼 {tx.manager.fullName}</div>}
                  {!tx.student && !tx.manager && <span style={{ color: 'var(--text-light)' }}>—</span>}
                </td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{tx.comment || '—'}</td>
                <td>
                  {canDeleteTx && (
                    <button className="btn btn-sm btn-danger" onClick={() => onDelete(tx)}>
                      <Icon name="delete" size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={txPage}
        total={transactions.length}
        pageSize={TX_PAGE_SIZE}
        onChange={(n) => setTxUrl('page', n)}
      />

      {/* Карточка транзакции по клику на строку. Ключ по id: список
          перезапрашивается после правки, и объект строки уже другой. */}
      <AnimatePresence>
        {detailId && transactions.some((x) => x.id === detailId) && (
          <TransactionDetailModal
            key={detailId}
            tx={transactions.find((x) => x.id === detailId)!}
            canEdit={hasRole(me, 'FOUNDER')}
            onClose={() => setDetailId(null)}
            onEdit={(tx) => { setDetailId(null); setEditing(tx); }}
            // Карточку закрываем ДО вопроса: иначе подтверждение висит
            // поверх ещё открытого окна, и на экране два окна разом.
            onDelete={(tx) => { setDetailId(null); setTimeout(() => onDelete(tx), 0); }}
          />
        )}
      </AnimatePresence>

      {/* Правка — та же форма, что и создание, но с заполненными полями. */}
      <AnimatePresence>
        {editing && (
          <TransactionForm
            key={`edit-${editing.id}`}
            students={students}
            users={users}
            preselect={null}
            canExpense={canExpense}
            editTx={editing}
            onClose={() => setEditing(null)}
            onCreated={() => { setEditing(null); refresh(); }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * Карточка транзакции по клику на строку журнала.
 *
 * В таблице помещается шесть колонок из пятнадцати полей: способ оплаты,
 * источник, продукт, чек и плательщик оставались невидимыми, и чтобы их
 * посмотреть, приходилось открывать правку. Здесь видно всё сразу, а
 * править может только основатель — см. canEdit.
 */
function TransactionDetailModal({
  tx,
  canEdit,
  onClose,
  onEdit,
  onDelete,
}: {
  tx: Transaction;
  canEdit: boolean;
  onClose: () => void;
  onEdit: (tx: Transaction) => void;
  onDelete: (tx: Transaction) => void;
}) {
  const { t } = useT();
  const isIncome = tx.type === 'INCOME';
  const catLabel = t(`finance.cat.${tx.category}`) !== `finance.cat.${tx.category}`
    ? t(`finance.cat.${tx.category}`)
    : TRANSACTION_CATEGORY_LABEL[tx.category];

  const rows: Array<[string, React.ReactNode]> = [
    [t('finance.col.date'), fmtDate(tx.date)],
    [t('finance.col.category'), catLabel],
    [t('finance.col.currency'), tx.currency],
    // У расхода студента нет — там в этом поле плательщик, и подписывать
    // его «Студент» значит путать читающего.
    (tx as any).student?.fullName
      ? [t('finance.col.student'), (tx as any).student.fullName] as [string, React.ReactNode]
      : [t('finance.field.payer'), (tx as any).payerName || '—'] as [string, React.ReactNode],
    [t('finance.col.manager'), (tx as any).manager?.fullName || '—'],
    [t('finance.paymentChannel'), (tx as any).paymentChannel
      ? t(`finance.channel.${(tx as any).paymentChannel}`) : '—'],
    [t('finance.col.comment'), tx.comment || '—'],
  ];

  return (
    <FormModal
      open
      title={t('finance.tx.details')}
      onClose={onClose}
      dirty={false}
      width={620}
      testId="tx-detail"
    >
      <div className="tx-detail-amount">
        <span className={`badge ${isIncome ? 'badge-success' : 'badge-danger'}`}>
          {isIncome ? t('finance.income') : t('finance.expense')}
        </span>
        <span
          data-testid="tx-detail-amount"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 30,
            fontWeight: 500,
            color: isIncome ? 'var(--primary-dark)' : 'var(--danger)',
          }}
        >
          {isIncome ? '+' : '−'} {fmtMoney(tx.amount, tx.currency)}
        </span>
      </div>

      <dl className="tx-detail-list">
        {rows.map(([label, value]) => (
          <div key={label} className="tx-detail-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="form-actions">
        {canEdit ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              data-testid="tx-delete"
              onClick={() => onDelete(tx)}
            >
              {t('common.delete')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="tx-edit"
              onClick={() => onEdit(tx)}
            >
              {t('finance.tx.edit')}
            </button>
          </>
        ) : (
          <span style={{ color: 'var(--text-soft)', fontSize: 13 }}>
            {t('finance.tx.founderOnly')}
          </span>
        )}
      </div>
    </FormModal>
  );
}

let preselectedStudent: any = null;
function setPreselectedStudent(v: any) { preselectedStudent = v; }

/** «01.09.2026 — 30.09.2026» — период под выручкой. */
function periodLabel(range: { from?: string; to?: string }, t: (k: string) => string) {
  const d = (iso: string) => fmtDateText(`${iso.slice(0, 10)}T00:00:00Z`, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  if (range.from && range.to) return `${d(range.from)} — ${d(range.to)}`;
  if (range.from) return `${t('finance.kpi.since')} ${d(range.from)}`;
  if (range.to) return `${t('finance.kpi.until')} ${d(range.to)}`;
  return t('finance.kpi.allTime');
}

type KpiTone = 'green' | 'red' | 'purple' | 'blue' | 'amber';

function OwnerKpi({ tone, title, icon, value, valueTone, sub, onClick, testId }: {
  tone: KpiTone;
  title: string;
  icon: string;
  value: string;
  /** Цвет самой суммы: выручка — зелёная, расходы — красные, остальное — обычная. */
  valueTone?: 'green' | 'red';
  sub?: React.ReactNode;
  onClick?: () => void;
  testId?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`owner-kpi tone-${tone}${onClick ? ' is-link' : ''}`}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="owner-kpi-head">
        <span className="owner-kpi-title">{title}</span>
        <span className="owner-kpi-icon"><Icon name={icon} size={18} /></span>
      </span>
      <span className={`owner-kpi-value${valueTone ? ` is-${valueTone}` : ''}`} data-testid={testId ? `${testId}-value` : undefined}>
        {value}
      </span>
      {sub && <span className="owner-kpi-sub">{sub}</span>}
    </Tag>
  );
}

/**
 * Главные цифры для владельца — первая строка «Финансов» (как в отчётах
 * управленческого учёта): выручка, чистая прибыль с формулой, зарплаты,
 * прочие расходы, средний чек и долги клиентов. Все суммы — за период
 * страницы и сходятся с журналом ниже; долги — текущие, из того же списка,
 * что раздел «Ожидает оплаты».
 */
function OwnerKpis({ overview, loading, range, debts, onOpen }: {
  overview: FinanceOverview | null;
  loading: boolean;
  range: { from?: string; to?: string };
  debts: any[];
  /** Клик по карточке — окно с подробностями. */
  onOpen: (kind: FinanceDetailKind) => void;
}) {
  const { t } = useT();
  if (!overview) {
    return (
      <div className="owner-kpis" data-testid="owner-kpis">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="owner-kpi is-skeleton">{loading ? t('common.loading') : '—'}</div>
        ))}
      </div>
    );
  }
  const cur = overview.currency || 'TJS';
  const money = (n: number) => fmtMoney(n, cur);
  const profit = overview.netProfit;
  // Долги: суммы по валютам программ. Главная — в валюте отчётов, а если
  // в ней долгов нет — в той валюте, где они есть (иначе «0 TJS» прятал бы
  // долг в долларах). Остальные валюты — строкой ниже.
  const debtByCur: Record<string, number> = {};
  for (const a of debts) {
    const c = a.program?.currency || cur;
    debtByCur[c] = (debtByCur[c] || 0) + Number(a.program?.cost || 0);
  }
  const debtList = Object.entries(debtByCur).filter(([, v]) => v > 0);
  const debtMainEntry = debtList.find(([c]) => c === cur) ?? debtList[0] ?? [cur, 0];
  const debtOther = debtList.filter(([c]) => c !== debtMainEntry[0]);
  // Не-TJS поступления и расходы периода — в карточках, а не отдельной строкой.
  const nonTjs = Object.entries(overview.nonTjsTotals || {});
  const nonTjsIncome = nonTjs.filter(([, b]) => b.income > 0).map(([c, b]) => fmtMoney(b.income, c));
  const nonTjsExpense = nonTjs.filter(([, b]) => b.expense > 0).map(([c, b]) => fmtMoney(b.expense, c));
  return (
    <div className="owner-kpis" data-testid="owner-kpis">
      <OwnerKpi
        tone="green"
        title={t('finance.kpi.revenue')}
        icon="account_balance_wallet"
        value={money(overview.totalIncome)}
        valueTone="green"
        sub={<>
          {periodLabel(range, t)}
          {nonTjsIncome.length > 0 && <><br />{t('finance.kpi.alsoCurrencies').replace('{list}', nonTjsIncome.join(', '))}</>}
        </>}
        onClick={() => onOpen('revenue')}
        testId="kpi-revenue"
      />
      <OwnerKpi
        tone={profit >= 0 ? 'green' : 'red'}
        title={t('finance.kpi.profit')}
        icon={profit >= 0 ? 'trending_up' : 'trending_down'}
        value={money(profit)}
        valueTone={profit >= 0 ? 'green' : 'red'}
        sub={t('finance.kpi.profitFormula')
          .replace('{salary}', money(overview.salaryExpense))
          .replace('{other}', money(overview.otherExpense))}
        onClick={() => onOpen('profit')}
        testId="kpi-profit"
      />
      <OwnerKpi
        tone="purple"
        title={t('finance.kpi.salary')}
        icon="groups"
        value={money(overview.salaryExpense)}
        sub={overview.salaryAccruedUnpaid > 0
          ? t('finance.kpi.salaryUnpaid').replace('{sum}', money(overview.salaryAccruedUnpaid))
          : t('finance.kpi.salaryHint')}
        onClick={() => onOpen('salary')}
        testId="kpi-salary"
      />
      <OwnerKpi
        tone="red"
        title={t('finance.kpi.expenses')}
        icon="south_east"
        value={money(overview.otherExpense)}
        valueTone="red"
        sub={<>
          {t('finance.kpi.expensesHint')}
          {nonTjsExpense.length > 0 && <><br />{t('finance.kpi.alsoCurrencies').replace('{list}', nonTjsExpense.join(', '))}</>}
        </>}
        onClick={() => onOpen('expenses')}
        testId="kpi-expenses"
      />
      <OwnerKpi
        tone="blue"
        title={t('finance.kpi.avgCheck')}
        icon="receipt_long"
        value={money(overview.avgCheck)}
        sub={t('finance.kpi.avgCheckHint').replace('{n}', String(overview.incomeCount))}
        onClick={() => onOpen('avg')}
        testId="kpi-avg"
      />
      <OwnerKpi
        tone="amber"
        title={t('finance.kpi.debts')}
        icon="hourglass_top"
        value={fmtMoney(Number(debtMainEntry[1]), String(debtMainEntry[0]))}
        sub={<>
          {t('finance.kpi.debtsHint').replace('{n}', String(debts.length))}
          {debtOther.map(([c, v]) => <span key={c}> · + {fmtMoney(v, c)}</span>)}
        </>}
        onClick={() => onOpen('debts')}
        testId="kpi-debts"
      />
    </div>
  );
}

// ============================================================
// Form for new transaction
// ============================================================
function TransactionForm({
  students,
  users,
  preselect,
  canExpense,
  editTx,
  onClose,
  onCreated,
}: {
  students: any[];
  users: any[];
  preselect: any;
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
  const elevated = isElevated(me);
  const [type, setType] = useState<TransactionType>(editTx?.type ?? 'INCOME');
  const [category, setCategory] = useState<TransactionCategory>(editTx?.category ?? 'TUITION_PAYMENT');
  const [amount, setAmount] = useState<string>(
    editTx ? String(editTx.amount) : preselect?.amount ? String(preselect.amount) : '',
  );
  const [currency, setCurrency] = useState(editTx?.currency || preselect?.currency || 'TJS');
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
  const [date, setDate] = useState(editTx ? String(editTx.date).slice(0, 10) : tjToday());
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
  const [paymentKind, setPaymentKind] = useState<string>('FULL');
  const [productCategory, setProductCategory] = useState<string>('');
  const [payerName, setPayerName] = useState((editTx as any)?.payerName || '');
  const [receiptKind, setReceiptKind] = useState<string>('RECEIPT');
  const [noReceiptReason, setNoReceiptReason] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  // Google Sheet parity — новые enum-поля
  const [incomeSource, setIncomeSource] = useState<IncomeSource | ''>('');
  const [productCategoryEnum, setProductCategoryEnum] = useState<ProductCategoryEnum | ''>('');
  const [paymentPhase, setPaymentPhase] = useState<PaymentPhaseStatus | ''>('');
  const [paidViaId, setPaidViaId] = useState<string>('');

  const cats = type === 'INCOME' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

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
    if (!amt || amt <= 0) {
      toast(t('toast.error'), 'error');
      return;
    }
    // Role-guard: EXPENSE запрещён backend'ом для не-elevated ролей
    // (finance.controller.ts:291 → 403). Ловим ДО uploadReceipt, чтобы
    // не оставить orphan-файл в /uploads/ при последующем 403 на
    // createTransaction. В нормальном UI EXPENSE-опция уже спрятана
    // (см. type-select выше), но double-check страхует от гонки, когда
    // роль пользователя поменялась между открытием формы и submit'ом.
    if (type === 'EXPENSE' && !canExpense) {
      toast(t('toast.error'), 'error');
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
        const m = await import('../api/finance');
        const uploaded = await m.uploadReceipt(receiptFile);
        receiptUrl = uploaded.url;
        setUploadingReceipt(false);
      }

      const dto: CreateTransactionDto = {
        type,
        category,
        amount: amt,
        currency,
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
        ...(type === 'INCOME' && productCategory && { productCategory }),
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
              const nextCategory: TransactionCategory = tt === 'INCOME' ? 'TUITION_PAYMENT' : 'SALARY';
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
                setProductCategory('');
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
            <input className="crm-input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
          </div>
          <div className="form-group">
            <label>{t('finance.col.currency')}</label>
            <CrmSelect className="crm-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="CNY">CNY</option>
              <option value="RUB">RUB</option>
              <option value="TJS">TJS</option>
            </CrmSelect>
          </div>
          <div className="form-group">
            <label>{t('common.date')}</label>
            <CrmDatePicker className="crm-input" value={date} onChange={(v) => setDate(v)} />
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
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.product')}</label>
              <CrmSelect className="crm-select" value={productCategory} onChange={(e) => setProductCategory(e.target.value)}>
                <option value="">—</option>
                {PRODUCT_CATEGORIES.map((p) => (
                  <option key={p} value={p}>{PRODUCT_CATEGORY_TEXT[p] ?? p}</option>
                ))}
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
            <input className="crm-input" type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
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

// ============================================================
// Revenue chart — pure SVG, dual line (income / expense) + profit area
// ============================================================
/**
 * Карточка распределения выручки по активной FOUNDER-редактируемой схеме.
 *
 * Backend GET /finance/distribution возвращает `scheme.buckets` с
 * рассчитанным `allocated` на каждый фонд (PERCENTAGE: `incomeTotal *
 * percent / 100`; FIXED_SUM: `sum(items.amount)`). UI:
 *   • строка на фонд: цвет-акцент (bucket.color), заголовок (%N · Name для
 *     PERCENTAGE, «Name» для FIXED_SUM), сумма и прогресс-бар в долях от
 *     `incomeTotal` (даёт визуальную интуицию, сколько «съел» фонд);
 *   • для FIXED_SUM бакетов доступен раскрывающийся список статей (клик по
 *     заголовку) — показывает name + amount, чтобы FOUNDER видел «на кого
 *     ушёл ФОТ» без похода в Настройки;
 *   • внизу — «Прибыль после распределения» (`netAfterDistribution`),
 *     зелёная при > 0, красная при < 0. Отрицательный net = фонды
 *     перерасходовали выручку → сигнал пересобрать схему.
 */
function RevenueDistributionCard({ breakdown }: { breakdown: import('../api/finance').FinanceDistribution }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Backend возвращает `scheme: null`, если активная FOUNDER-редактируемая
  // схема ещё не сконфигурирована (или RevenueSchemeService не инжектирован
  // на этом деплое). В этом случае buckets/name читать неоткуда — рендерим
  // «пустой» плейсхолдер той же формы, чтобы FOUNDER увидел место карточки
  // и понял, куда идти настраивать. Раньше это падало в TypeError и клало
  // всю страницу Finance.
  const scheme = breakdown.scheme;
  const buckets = useMemo(
    () => (scheme ? [...scheme.buckets].sort((a, b) => a.order - b.order) : []),
    [scheme],
  );
  if (!scheme) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
          color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span>{t('eyebrow.distributionScheme')}</span>
          <CurrencyBadge currency={breakdown.currency ?? 'TJS'} />
        </div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 8 }}>
          {t('finance.dist.title')}
        </h3>
        <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 12 }}>
          {t('finance.dist.notConfigured')}
        </div>
        <NonTjsStrip totals={breakdown.nonTjsTotals} />
      </div>
    );
  }

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const denom = Math.max(1, breakdown.incomeTotal); // защита от /0

  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
        color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <span>{t('eyebrow.distributionScheme')}</span>
        <CurrencyBadge currency={breakdown.currency ?? 'TJS'} />
      </div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 8 }}>
        {scheme.name || t('finance.dist.title')}
      </h3>
      <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 16 }}>
        {t('finance.dist.title')} · {breakdown.incomeTotal.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} {breakdown.currency}
      </div>

      {/* Валютная активность за тот же период (не входит в распределение —
          backend распределяет только TJS-выручку). */}
      <NonTjsStrip totals={breakdown.nonTjsTotals} />

      {buckets.map((b) => {
        const color = b.color && b.color !== '#ffffff' ? b.color : '#94a3b8';
        const pctOfIncome = Math.min(100, (b.allocated / denom) * 100);
        const kindLabel =
          b.kind === 'PERCENTAGE'
            ? t('finance.distribution.fund.percentage')
            : t('finance.distribution.fund.fixed');
        const headline =
          b.kind === 'PERCENTAGE'
            ? `${b.percent ?? 0}% · ${b.name}`
            : b.name;
        const isFixed = b.kind === 'FIXED_SUM';
        const isOpen = expanded.has(b.id);

        return (
          <div key={b.id} style={{ marginBottom: 14 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 4,
                cursor: isFixed && b.items.length > 0 ? 'pointer' : 'default',
              }}
              onClick={() => {
                if (isFixed && b.items.length > 0) toggleExpand(b.id);
              }}
            >
              <span style={{ fontSize: 13 }}>
                <b style={{ color }}>{headline}</b>
                <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>
                  · {kindLabel}
                </span>
                {isFixed && b.items.length > 0 && (
                  <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>
                    · {b.items.length} {isOpen ? '▾' : '▸'}
                  </span>
                )}
              </span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                {b.allocated.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
              </span>
            </div>
            <div style={{ height: 8, background: 'var(--bg-soft)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pctOfIncome}%`, background: color }} />
            </div>
            {isFixed && isOpen && b.items.length > 0 && (
              <div style={{
                marginTop: 6, paddingLeft: 12,
                borderLeft: `2px solid ${color}`,
                display: 'flex', flexDirection: 'column', gap: 2,
              }}>
                {b.items.map((it) => (
                  <div
                    key={it.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      color: 'var(--text-soft)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <span>{it.name}{it.user ? ` · ${it.user.fullName}` : ''}</span>
                    <span>{it.amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Net after distribution */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          {t('finance.distribution.netAfter')}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 16,
            fontWeight: 700,
            color: breakdown.netAfterDistribution >= 0 ? '#15803d' : '#b91c1c',
          }}
        >
          {breakdown.netAfterDistribution.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} {breakdown.currency}
        </span>
      </div>
    </div>
  );
}

// ============================================================
// Drill-down панели: клик по сектору пирога / точке revenue-графика
// открывает панель со списком транзакций, попадающих в этот срез.
// Логика фильтрации на клиенте: backend GET /finance/transactions
// принимает только type/category/managerId/from/to (не incomeSource),
// поэтому мы фильтруем по incomeSource на фронте. Роллап-сектор
// «Прочее» — массив ключей, объединяем предикатом-any.
// ============================================================
