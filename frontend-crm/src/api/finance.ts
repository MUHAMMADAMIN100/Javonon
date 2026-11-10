import { localized } from '../lib/i18n';
import { loadAllPages } from '../lib/loadAllPages';
import { api } from './client';

export type TransactionType = 'INCOME' | 'EXPENSE';
export type TransactionCategory =
  | 'TUITION_PAYMENT'
  | 'ADDITIONAL_FEE'
  | 'SALARY'
  | 'RENT'
  | 'UTILITIES'
  | 'MARKETING'
  | 'OFFICE'
  | 'MISC_EXPENSE'
  | 'TARGETED_ADS'
  | 'OTHER_INCOME'
  | 'OTHER_EXPENSE'
  | 'SUBSCRIPTION'
  | 'PARTNER_COMMISSION'
  | 'LOAN_PAYMENT';

export const TRANSACTION_CATEGORY_LABEL: Record<TransactionCategory, string> = localized('finance.cat', {
  TUITION_PAYMENT: 'Оплата обучения',
  ADDITIONAL_FEE: 'Доплата',
  SALARY: 'Зарплата',
  RENT: 'Аренда',
  UTILITIES: 'Коммуналка',
  MARKETING: 'Маркетинг',
  OFFICE: 'Офис',
  MISC_EXPENSE: 'Доп-Расходы',
  TARGETED_ADS: 'Target (реклама)',
  OTHER_INCOME: 'Прочий доход',
  OTHER_EXPENSE: 'Прочие расходы',
  SUBSCRIPTION: 'Подписки',
  PARTNER_COMMISSION: 'Выплата партнёру',
  LOAN_PAYMENT: 'Долги и кредиты',
});
// Алиас для совместимости с новым именованием (см. запросы UI).
export const CATEGORY_LABEL = TRANSACTION_CATEGORY_LABEL;

export const INCOME_CATEGORIES: TransactionCategory[] = [
  'TUITION_PAYMENT',
  'ADDITIONAL_FEE',
  'OTHER_INCOME',
];
export const EXPENSE_CATEGORIES: TransactionCategory[] = [
  'SALARY',
  'RENT',
  'UTILITIES',
  'MARKETING',
  'OFFICE',
  'MISC_EXPENSE',
  'TARGETED_ADS',
  'OTHER_EXPENSE',
  'SUBSCRIPTION',
  'PARTNER_COMMISSION',
  'LOAN_PAYMENT',
];

// === Google Sheet parity — enum-типы из Prisma-схемы, продублированы литералами.
// Держим совпадение с backend/prisma/schema.prisma: IncomeSource / ProductCategory
// / PaymentPhaseStatus. Если добавляется вариант — обновляем и здесь, и *_LABEL ниже.
export type IncomeSource = 'NEW_CLIENT' | 'UP_SALE' | 'OTHER';
export type ProductCategoryEnum = 'CONTRACT' | 'MASTERCLASS' | 'ACADEMY' | 'OTHER';
export type PaymentPhaseStatus = 'PREPAID' | 'FULL';

export const INCOME_SOURCE_LABEL: Record<IncomeSource, string> = localized('finance.source', {
  NEW_CLIENT: 'Новый клиент',
  UP_SALE: 'Апселл',
  OTHER: 'Прочее',
});
export const PRODUCT_CATEGORY_LABEL: Record<ProductCategoryEnum, string> = localized('finance.productEnum', {
  CONTRACT: 'Контракт',
  MASTERCLASS: 'Мастер-класс',
  ACADEMY: 'Академия',
  OTHER: 'Другое',
});
export const PAYMENT_PHASE_LABEL: Record<PaymentPhaseStatus, string> = localized('finance.phase', {
  PREPAID: 'Предоплата',
  FULL: 'Полная оплата',
});

export type PaymentChannel = 'ALIF_MOBILE' | 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'CRYPTO' | 'OTHER';
export type PaymentKind = 'FULL' | 'PREPAYMENT' | 'ADDITIONAL' | 'OWNER_INVESTMENT';
export type ReceiptKind = 'RECEIPT' | 'CASH_PHOTO' | 'REASON_ONLY';

export const PAYMENT_CHANNEL_LABEL: Record<PaymentChannel, string> = localized('finance.channel', {
  ALIF_MOBILE: 'АлифМобайл',
  CASH: 'Наличные',
  BANK_TRANSFER: 'Банк. перевод',
  CARD: 'Карта',
  CRYPTO: 'Crypto',
  OTHER: 'Другое',
});
export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = localized('finance.kind', {
  FULL: 'Полная',
  PREPAYMENT: 'Предоплата',
  ADDITIONAL: 'Доплата',
  OWNER_INVESTMENT: 'Вложение собственника',
});

/**
 * Подпись продуктовой категории на языке интерфейса. Значение (оно же
 * хранится в транзакции) остаётся русским — переводится только показ.
 */
export const PRODUCT_CATEGORY_TEXT: Record<string, string> = localized('finance.productCat', {
  'Академия': 'Академия',
  'Канада': 'Канада',
  'США': 'США',
  'Китай': 'Китай',
  'Языковые курсы': 'Языковые курсы',
  'Колледж': 'Колледж',
  'Другое': 'Другое',
});

// Продуктовые категории дохода (можно расширять)
export const PRODUCT_CATEGORIES = [
  'Академия',
  'Канада',
  'США',
  'Китай',
  'Языковые курсы',
  'Колледж',
  'Другое',
];

export interface Transaction {
  id: string;
  type: TransactionType;
  category: TransactionCategory;
  amount: number;
  currency: string;
  comment: string | null;
  date: string;
  studentId: string | null;
  managerId: string | null;
  recordedById: string | null;
  bonusApplied: boolean;
  createdAt: string;
  paymentChannel?: PaymentChannel | null;
  paymentKind?: PaymentKind | null;
  productCategory?: string | null;
  payerName?: string | null;
  receiptUrl?: string | null;
  receiptKind?: ReceiptKind | null;
  noReceiptReason?: string | null;
  // Google Sheet parity — новые enum-поля из backend (Prisma).
  incomeSource?: IncomeSource | null;
  productCategoryEnum?: ProductCategoryEnum | null;
  paymentPhase?: PaymentPhaseStatus | null;
  paidViaId?: string | null;
  paidVia?: { id: string; fullName: string } | null;
  student?: { id: string; fullName: string } | null;
  manager?: { id: string; fullName: string; role?: string } | null;
  recordedBy?: { id: string; fullName: string; role?: string } | null;
  /** Счёт операции; пусто — счёт определяется по способу оплаты (Настройки). */
  accountId?: string | null;
  account?: FinanceAccountRef | null;
  /** Сколько легло на счёт в его валюте, если она другая ($-оплата на счёт в сомони). */
  accountAmount?: number | null;
  subscriptionId?: string | null;
  debtId?: string | null;
}

/**
 * Сводка по «не-TJS» валютам за тот же период, что и основной агрегат.
 * Backend считает все KPI/пироги в TJS (единая отчётная валюта), а суммы
 * в USD/EUR/CNY/RUB и т.п. отдаёт отдельно — чтобы бухгалтер видел, что
 * валютная выручка была, и обработал её вручную (FX-конвертации на
 * write-time пока нет). Пустой объект = период чисто в сомони.
 *
 * Ключ — ISO-код валюты (`USD`, `EUR`, ...); значение — split по
 * доход/расход и количеству транзакций каждого типа.
 */
export interface NonTjsBucket {
  income: number;
  expense: number;
  incomeCount: number;
  expenseCount: number;
}
export type NonTjsTotals = Record<string, NonTjsBucket>;

export interface FinanceSummary {
  totalIncome: number;
  totalExpense: number;
  netProfit: number;
  incomeCount: number;
  expenseCount: number;
  /** Всего транзакций во всех валютах — столько строк в журнале за период. */
  transactionCount?: number;
  /** Валюта, в которой посчитаны все KPI выше (обычно `TJS`). */
  currency: string;
  /** Отброшенные из основного агрегата суммы в иных валютах. */
  nonTjsTotals: NonTjsTotals;
}

export interface CreateTransactionDto {
  type: TransactionType;
  category: TransactionCategory;
  amount: number;
  currency?: string;
  comment?: string;
  date?: string;
  studentId?: string | null;
  managerId?: string | null;
  paymentChannel?: PaymentChannel | null;
  paymentKind?: PaymentKind | null;
  productCategory?: string | null;
  payerName?: string | null;
  receiptUrl?: string | null;
  receiptKind?: ReceiptKind | null;
  noReceiptReason?: string | null;
  // Google Sheet parity — новые enum-поля.
  incomeSource?: IncomeSource | null;
  productCategoryEnum?: ProductCategoryEnum | null;
  paymentPhase?: PaymentPhaseStatus | null;
  paidViaId?: string | null;
  accountId?: string | null;
  subscriptionId?: string | null;
  debtId?: string | null;
}

export interface TransactionFilters {
  type?: TransactionType;
  category?: TransactionCategory;
  studentId?: string;
  managerId?: string;
  from?: string;
  to?: string;
}

/** Одна порция журнала: сервер отдаёт не больше 1000 строк (по умолчанию 200). */
export const listTransactions = (params?: TransactionFilters & { take?: number; skip?: number }) =>
  api.get<Transaction[]>('/finance/transactions', { params }).then((r) => r.data);

/**
 * ВСЕ операции по фильтру — порциями (lib/loadAllPages). Журнал «Финансов»
 * и окна у карточек денег считают и показывают строки сами, поэтому
 * обрезанный список дал бы неверные счётчик и суммы.
 */
export const loadAllTransactions = (params: TransactionFilters = {}) =>
  loadAllPages((page) => listTransactions({ ...params, ...page }));

export const createTransaction = (dto: CreateTransactionDto) =>
  api.post<Transaction>('/finance/transactions', dto).then((r) => r.data);

export const updateTransaction = (id: string, patch: Partial<CreateTransactionDto>) =>
  api.patch<Transaction>(`/finance/transactions/${id}`, patch).then((r) => r.data);

export const deleteTransaction = (id: string) =>
  api.delete(`/finance/transactions/${id}`).then((r) => r.data);

/** Главные цифры для владельца — карточки вверху «Финансов». */
export interface FinanceOverview extends FinanceSummary {
  /** Выплаченная зарплата с премиями (расходы категории «Зарплата»). */
  salaryExpense: number;
  salaryCount: number;
  /** Остальные расходы — без зарплаты. */
  otherExpense: number;
  /** Выручка ÷ число поступлений. */
  avgCheck: number;
  /** Начислено за период, но ещё не выплачено (черновики зарплаты). */
  salaryAccruedUnpaid: number;
  salaryAccruedUnpaidCount: number;
}
export const financeOverview = (params?: { from?: string; to?: string }) =>
  api.get<FinanceOverview>('/finance/overview', { params }).then((r) => r.data);

export const financeSummary = (params?: { from?: string; to?: string }) =>
  api.get<FinanceSummary>('/finance/summary', { params }).then((r) => r.data);

/** Доход по способу оплаты — «Финансы → Аналитика» (редизайн 2026). channel 'UNKNOWN' — не указан. */
export const financeByChannel = (params?: { from?: string; to?: string }) =>
  api.get<Array<{ channel: PaymentChannel | 'UNKNOWN'; amount: number; count: number }>>('/finance/by-channel', { params }).then((r) => r.data);

export const financeByCategory = (params?: { from?: string; to?: string }) =>
  api
    .get<Array<{ type: TransactionType; category: TransactionCategory; amount: number; count: number }>>(
      '/finance/by-category',
      { params },
    )
    .then((r) => r.data);

/** Сумма долга: остаток по сделке, иначе цена программы, иначе неизвестна (QA №52). */
export interface DebtInfo {
  amount: number | null;
  currency: string | null;
  programName: string | null;
  source: 'deal' | 'program' | null;
  submissionId: string | null;
  /** На сколько дней просрочен самый ранний неоплаченный этап (0 — в срок, null — без плана). */
  overdueDays?: number | null;
}
export const pendingPayments = () =>
  api.get<any[]>('/finance/pending-payments').then((r) => r.data);

export interface TimeseriesPoint {
  key: string;
  income: number;
  expense: number;
  profit: number;
}
export const financeTimeseries = (params?: { from?: string; to?: string; bucket?: 'day' | 'week' | 'month' }) =>
  api.get<TimeseriesPoint[]>('/finance/timeseries', { params }).then((r) => r.data);

/**
 * Ответ /finance/distribution — распределение выручки периода по активной
 * FOUNDER-редактируемой схеме (`RevenueScheme`). Backend больше не считает
 * жёстко зашитые 70/20/10 — теперь берёт активную схему и для каждого
 * фонда возвращает `allocated`:
 *   • PERCENTAGE: `incomeTotal * percent / 100`
 *   • FIXED_SUM:  `sum(items.amount)`
 * `netAfterDistribution = incomeTotal - (totalPercentageAllocated +
 * totalFixedAllocated)` — может быть отрицательным, если фиксированные
 * фонды или суммы процентов превысили выручку периода.
 */
export interface DistributionBucketItem {
  id: string;
  name: string;
  amount: number;
  userId?: string | null;
  user?: { id: string; fullName: string; isActive?: boolean } | null;
}
export interface DistributionBucket {
  id: string;
  name: string;
  kind: 'PERCENTAGE' | 'FIXED_SUM';
  color: string | null;
  percent: number | null;
  order: number;
  allocated: number;
  items: DistributionBucketItem[];
}
export interface DistributionScheme {
  id: string;
  name: string;
  updatedAt: string;
  buckets: DistributionBucket[];
}
export interface FinanceDistribution {
  incomeTotal: number;
  /**
   * `null`, если активная FOUNDER-редактируемая схема не сконфигурирована
   * (или RevenueSchemeService не инжектирован — deploy без миграции). UI
   * ОБЯЗАН обработать этот случай явным «Схема не настроена» плейсхолдером,
   * иначе рендер `scheme.buckets` уронит страницу целиком.
   */
  scheme: DistributionScheme | null;
  totalPercentageAllocated: number;
  totalFixedAllocated: number;
  /** Сколько месяцев в периоде: фиксированные (месячные) суммы умножены на него. */
  fixedMonths?: number;
  netAfterDistribution: number;
  /** Валюта, в которой посчитано распределение (обычно `TJS`). */
  currency: string;
  /** Отброшенные из основного агрегата суммы в иных валютах. */
  nonTjsTotals: NonTjsTotals;
}
export const financeDistribution = (params?: { from?: string; to?: string }) =>
  api.get<FinanceDistribution>('/finance/distribution', { params }).then((r) => r.data);

export interface TopManager {
  manager: { id: string; fullName: string; email?: string };
  amount: number;
  count: number;
}
/**
 * Ответ /finance/top-managers.
 *
 * Ранжирование считается только по TJS-INCOME (единая отчётная валюта,
 * см. `REPORTING_CURRENCY` на backend). Раньше эндпоинт возвращал плоский
 * `TopManager[]`, и менеджер, чьи продажи были только в USD/EUR/CNY/RUB,
 * молча пропадал из «ТОП» — фронт не получал никакого сигнала, что валютная
 * активность в периоде вообще была. Теперь возвращаем структуру, идентичную
 * `breakdown`/`summary`/`distribution`: `managers` — сам ранжированный
 * список, `currency` — база расчёта, `nonTjsTotals` — суммы по прочим
 * валютам (может быть пустой объект, если период чисто в сомони).
 */
export interface TopManagersResponse {
  managers: TopManager[];
  /** Валюта, в которой посчитано ранжирование (обычно `TJS`). */
  currency: string;
  /** Не-TJS выручка с назначенным менеджером за тот же период. */
  nonTjsTotals: NonTjsTotals;
}
export const financeTopManagers = (params?: { from?: string; to?: string; limit?: number }) =>
  api.get<TopManagersResponse>('/finance/top-managers', { params }).then((r) => r.data);

// Разрез доходов по источнику (для эндпоинта /finance/income-sources).
// Переименовано из IncomeSource → IncomeSourceStat, потому что имя IncomeSource
// теперь занято литеральным юнионом enum'а (NEW_CLIENT/UP_SALE/OTHER).
export interface IncomeSourceStat {
  kind: string;
  label: string;
  amount: number;
  count: number;
}
export const financeIncomeSources = (params?: { from?: string; to?: string }) =>
  api.get<IncomeSourceStat[]>('/finance/income-sources', { params }).then((r) => r.data);

export interface IncomeByProduct {
  product: string;
  amount: number;
  count: number;
}
export const financeIncomeByProduct = (params?: { from?: string; to?: string }) =>
  api.get<IncomeByProduct[]>('/finance/income-by-product', { params }).then((r) => r.data);

/** Три параллельных разреза (источник дохода / менеджер / категория расходов). */
export interface FinanceBreakdown {
  byIncomeSource: Array<{
    source: string;
    label: string;
    amount: number;
    count: number;
  }>;
  byManager: Array<{
    /** null — доходы без менеджера (доля «Без менеджера»). */
    managerId: string | null;
    manager: { id: string; fullName: string; email?: string } | null;
    amount: number;
    count: number;
  }>;
  byExpenseCategory: Array<{
    category: TransactionCategory | string;
    amount: number;
    count: number;
  }>;
  /** Валюта, в которой посчитаны все три разреза (обычно `TJS`). */
  currency: string;
  /** Отброшенные из основного агрегата суммы в иных валютах. */
  nonTjsTotals: NonTjsTotals;
  /**
   * Метадата якоря дат для INCOME-разрезов. Помогает UI объяснить
   * бухгалтеру расхождение между /finance/breakdown byManager и
   * /salary/preview salesAmount: tuition-приход (SubmissionPayment)
   * учитывается по дате оплаты (Transaction.date = paidAt платежа) — в тот
   * же месяц, что и бонус зарплаты. Ручной INCOME — по дате самой транзакции.
   * Поле опциональное — старые версии бэка его не отдают.
   */
  incomeAnchor?: {
    tuition: string; // 'transaction.date' (= paidAt платежа)
    manual: string; // 'transaction.date'
  };
}
export type FinancePeriod = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';
export const financeBreakdown = (params?: {
  period?: FinancePeriod;
  from?: string;
  to?: string;
}) =>
  api.get<FinanceBreakdown>('/finance/breakdown', { params }).then((r) => r.data);

// Публичный алиас с более «глагольным» именем — используется UI-хуками
// (`useQuery({ queryFn: () => getFinanceBreakdown(...) })`). Держим оба
// экспорта, чтобы не ломать существующие импорты `financeBreakdown`.
export const getFinanceBreakdown = financeBreakdown;

/** Загрузка фото чека или наличных. Возвращает URL для прикрепления к транзакции. */
export const uploadReceipt = (file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  return api.post<{ url: string; originalName: string; size: number }>(
    '/finance/receipts',
    fd,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  ).then((r) => r.data);
};

// ── Счета, переводы, остаток по дням (раздел «Финансы», 10.11.2026) ──

export type FinanceAccountKind = 'BANK' | 'CASH' | 'SAVINGS';
export interface FinanceAccountRef {
  id: string;
  name: string;
  currency: string;
  color: string | null;
}
export interface FinanceAccount extends FinanceAccountRef {
  kind: FinanceAccountKind;
  startBalance: number;
  archived: boolean;
  position: number;
  createdAt: string;
  /** Остаток на сегодня: старт + доходы − расходы ± переводы. */
  balance: number;
}
export interface AccountsResponse {
  accounts: FinanceAccount[];
  /** Сумма остатков действующих счетов по валютам. */
  totals: Record<string, number>;
  /** Операции, которым ещё не назначен счёт (ни сами, ни по способу оплаты). */
  unassigned: { count: number; byCurrency: Record<string, { income: number; expense: number }> };
  /** С какого дня ведутся остатки (ГГГГ-ММ-ДД); null — вся история. */
  balanceSince: string | null;
}
export interface AccountInput {
  name?: string;
  kind?: FinanceAccountKind;
  currency?: string;
  color?: string | null;
  startBalance?: number;
  archived?: boolean;
}
export const listAccounts = () => api.get<AccountsResponse>('/finance/accounts').then((r) => r.data);
export const createAccount = (dto: AccountInput) => api.post<FinanceAccount>('/finance/accounts', dto).then((r) => r.data);
export const updateAccount = (id: string, dto: AccountInput) =>
  api.patch<FinanceAccount>(`/finance/accounts/${id}`, dto).then((r) => r.data);

/** Пара «способ оплаты · валюта» у операций без счёта и куда их класть. */
export interface ChannelMapRow {
  channel: string;
  currency: string;
  count: number;
  accountId: string | null;
}
export const getChannelMap = () =>
  api.get<{ rows: ChannelMapRow[] }>('/finance/channel-map').then((r) => r.data);
/** С какого дня ведутся остатки: более ранние операции на них не влияют, в отчётах остаются. */
export interface FinanceConfig {
  balanceSince: string | null;
}
export const getFinanceConfig = () => api.get<FinanceConfig>('/finance/config').then((r) => r.data);
export const setFinanceConfig = (dto: FinanceConfig) => api.put<FinanceConfig>('/finance/config', dto).then((r) => r.data);

export const setChannelMap = (dto: { channel: string; currency: string; accountId: string | null }) =>
  api.put('/finance/channel-map', dto).then((r) => r.data);

export interface BalanceDay {
  date: string;
  /** Остаток в сомони на конец дня; null — день ещё не наступил. */
  balance: number | null;
  income: number;
  expense: number;
}
export interface BalanceDays {
  ym: string;
  today: string;
  /** День начала учёта остатков; дни раньше — null. */
  since: string | null;
  hasAccounts: boolean;
  days: BalanceDay[];
}
export const getBalanceDays = (ym: string) =>
  api.get<BalanceDays>('/finance/balance-days', { params: { ym } }).then((r) => r.data);

// ── Доход (часть 2) ──────────────────────────────────────────────────────
export type IncomeDirection = 'CONTRACT' | 'ACADEMY' | 'MASTERCLASS' | 'OTHER';
export interface IncomeDirectionSum {
  key: IncomeDirection;
  /** Сумма в сомони (оплаты в другой валюте — по сумме в сомони при одобрении). */
  tjs: number;
  /** Оплаты в другой валюте без суммы в сомони. */
  foreign: Record<string, number>;
  count: number;
}
export interface ContractRow {
  submissionId: string;
  group: 'waiting' | 'paid';
  name: string;
  studentId: string | null;
  program: string | null;
  manager: { id: string; name: string } | null;
  total: number;
  currency: string;
  status: string;
  stagesCount: number;
  stageOrder: number | null;
  paidTotal: number;
  left: number;
  payments: Array<{ amount: number; date: string }>;
  dueDate: string | null;
  dueDays: number | null;
  dueAmount: number | null;
  waiting: number;
  overdue: number;
  paidInMonth: number;
  lastPaidAt: string | null;
  nextDueDate: string | null;
  pendingCount: number;
  pendingSum: number;
}
export interface IncomePaymentRow {
  id: string;
  direction: IncomeDirection;
  date: string;
  amount: number;
  currency: string;
  tjs: number | null;
  who: string | null;
  studentId: string | null;
  comment: string | null;
  account: FinanceAccountRef | null;
}
export interface IncomeResponse {
  ym: string;
  from: string;
  to: string;
  today: string;
  directions: IncomeDirectionSum[];
  contracts: {
    waiting: { byCurrency: Record<string, number>; overdue: Record<string, number>; deals: number; overdueDeals: number };
    received: { byCurrency: Record<string, number>; tjs: number; noRate: Record<string, number>; count: number };
    pending: { count: number; byCurrency: Record<string, number> };
    overdue: Array<{ submissionId: string; name: string; days: number; amount: number; currency: string }>;
    rows: ContractRow[];
    footer: { deals: number; total: Record<string, number>; paidInMonth: Record<string, number>; waiting: Record<string, number> };
  };
  payments: IncomePaymentRow[];
}
export const getIncome = (ym: string) => api.get<IncomeResponse>('/finance/income', { params: { ym } }).then((r) => r.data);
export interface AcceptPaymentInput {
  amount: number;
  paidAt: string;
  accountId: string;
  amountTjs?: number | null;
  receiptUrls?: string[];
  notes?: string;
}
export const acceptContractPayment = (submissionId: string, dto: AcceptPaymentInput) =>
  api.post<{ status: 'APPROVED' | 'PENDING'; paymentId: string }>(`/finance/income/contracts/${submissionId}/pay`, dto).then((r) => r.data);

// ── Расход (часть 2) ─────────────────────────────────────────────────────
export type ExpenseGroup = 'salary' | 'rent' | 'partners' | 'debts' | 'other';
export interface MoneySplit { tjs: number; foreign: Record<string, number> }
export interface ExpenseSummary {
  ym: string;
  current: string;
  fact: Record<ExpenseGroup, MoneySplit>;
  cards: {
    salary: { forYm: string; employees: number; paidCount: number; accrued: number; toPay: number; paid: number };
    rent: { count: number; paidCount: number; toPay: number; monthly: number; paid: number };
    partners: { waiting: number; partners: number; requests: number; paid: number };
    debts: { toPay: number; paid: number; remaining: number; count: number; dueNames: string[]; overdue: number };
    other: { spent: number; plan: number; planSource: 'own' | 'avg'; paid: number };
  };
}
export interface ExpensePlanRow { ym: string; salary: number; rent: number; partners: number; debts: number; other: number; otherSource: 'own' | 'avg' }
export interface ExpensePlan {
  months: number;
  rows: ExpensePlanRow[];
  average: { avg: number; months: number; from: string | null; to: string | null };
  payroll: { ym: string; accrued: number; toPay: number };
}
export interface ExpenseChart { ym: string; current: string; rows: Array<{ ym: string; kind: 'fact' | 'current' | 'plan'; groups: Record<ExpenseGroup, number>; total: number }> }
export interface ExpensePaymentRef { id: string; amount: number; date: string; account: { id: string; name: string } | null }
export interface SubscriptionRow {
  id: string; name: string; kind: 'RENT' | 'SUBSCRIPTION'; amount: number; currency: string; payDay: number | null;
  startYm: string; endYm: string | null; note: string | null; archived: boolean; active: boolean;
  account: FinanceAccountRef | null; paid: number; left: number; status: 'paid' | 'partial' | 'none'; payments: ExpensePaymentRef[];
}
export interface SubscriptionsResponse { ym: string; rows: SubscriptionRow[]; monthly: MoneySplit; toPay: MoneySplit; hidden: number }
export interface SubscriptionInput {
  name?: string; kind?: 'RENT' | 'SUBSCRIPTION'; amount?: number; currency?: string; payDay?: number | null;
  startYm?: string; endYm?: string | null; accountId?: string | null; note?: string | null; archived?: boolean;
}
export interface DebtRow {
  id: string; name: string; kind: 'BANK' | 'PERSON'; total: number; currency: string; paidBefore: number;
  monthlyAmount: number | null; payDay: number | null; startYm: string | null; dueDate: string | null; note: string | null;
  account: FinanceAccountRef | null; paidTotal: number; left: number; closed: boolean; late: boolean; overdue: number;
  dueMonth: number; paidMonth: number; nextDate: string | null; nextAmount: number | null; payments: ExpensePaymentRef[];
}
export interface DebtsResponse { ym: string; rows: DebtRow[]; stats: { remaining: MoneySplit; paidMonth: MoneySplit; dueMonth: MoneySplit } }
export interface DebtInput {
  name?: string; kind?: 'BANK' | 'PERSON'; total?: number; currency?: string; paidBefore?: number; monthlyAmount?: number | null;
  payDay?: number | null; startYm?: string | null; dueDate?: string | null; accountId?: string | null; note?: string | null;
}
export interface PartnersBoard {
  ym: string; waiting: number; balance: number; requested: number; paidMonth: MoneySplit;
  partners: Array<{ id: string; name: string; balance: number; requested: number; paidTotal: number }>;
  requests: Array<{ id: string; partner: { id: string; name: string }; amount: number; currency: string; method: string | null; details: string | null; requestedAt: string }>;
  payments: Array<{ id: string; amount: number; currency: string; date: string; comment: string | null; account: { id: string; name: string } | null }>;
}
export interface OtherExpense {
  ym: string; spent: MoneySplit; plan: number; planSource: 'own' | 'avg';
  average: { avg: number; months: number; from: string | null; to: string | null };
  byCategory: Array<{ category: TransactionCategory; tjs: number; foreign: Record<string, number>; count: number }>;
  rows: Array<{ id: string; amount: number; currency: string; date: string; category: TransactionCategory; comment: string | null; account: { id: string; name: string } | null; paidVia: { id: string; fullName: string } | null }>;
  plans: Array<{ ym: string; amount: number | null }>;
}
export const getExpenseSummary = (ym: string) => api.get<ExpenseSummary>('/finance/expense/summary', { params: { ym } }).then((r) => r.data);
export const getExpensePlan = (months: number) => api.get<ExpensePlan>('/finance/expense/plan', { params: { months } }).then((r) => r.data);
export const getExpenseChart = (ym: string) => api.get<ExpenseChart>('/finance/expense/chart', { params: { ym } }).then((r) => r.data);
export const getSubscriptions = (ym: string) => api.get<SubscriptionsResponse>('/finance/expense/subscriptions', { params: { ym } }).then((r) => r.data);
export const createSubscription = (dto: SubscriptionInput) => api.post('/finance/expense/subscriptions', dto).then((r) => r.data);
export const updateSubscription = (id: string, dto: SubscriptionInput) => api.patch(`/finance/expense/subscriptions/${id}`, dto).then((r) => r.data);
export const getDebts = (ym: string) => api.get<DebtsResponse>('/finance/expense/debts', { params: { ym } }).then((r) => r.data);
export const createDebt = (dto: DebtInput) => api.post('/finance/expense/debts', dto).then((r) => r.data);
export const updateDebt = (id: string, dto: DebtInput) => api.patch(`/finance/expense/debts/${id}`, dto).then((r) => r.data);
export const deleteDebt = (id: string) => api.delete(`/finance/expense/debts/${id}`).then((r) => r.data);
export const getPartnersBoard = (ym: string) => api.get<PartnersBoard>('/finance/expense/partners', { params: { ym } }).then((r) => r.data);
export const payPartnerPayout = (id: string, dto: { accountId: string; date: string; receiptUrl?: string }) =>
  api.post(`/finance/expense/partners/payouts/${id}/pay`, dto).then((r) => r.data);
export const getOtherExpense = (ym: string) => api.get<OtherExpense>('/finance/expense/other', { params: { ym } }).then((r) => r.data);
export const setOtherPlan = (dto: { ym: string; amount: number | null }) => api.put('/finance/expense/other-plan', dto).then((r) => r.data);

// ── Расход → Зарплата (часть 2) ──────────────────────────────────────────
export interface PayrollRow {
  userId: string; name: string; role: string | null; position: string | null; isActive: boolean; hasRate: boolean;
  hours: number; lateMinutes: number; base: number; sales: number; bonus: number; bonusPercent: number | null; extra: number;
  penalties: number; penaltiesPending: number; net: number; advances: number;
  advancesList: Array<{ id: string; amount: number; date: string; account: { id: string; name: string } | null; comment: string | null }>;
  paidOut: number; toPay: number; status: 'paid' | 'covered' | 'zero' | 'due'; paidAt: string | null;
  record: { id: string; status: string } | null;
}
export interface PayrollSheet {
  ym: string; payUntil: string; closed: boolean; closedAt: string | null; canClose: boolean;
  cards: { accrued: number; advances: number; paid: number; paidCount: number; toPay: number; employees: number };
  rows: PayrollRow[];
}
export const getPayroll = (ym?: string) => api.get<PayrollSheet>('/finance/payroll', { params: ym ? { ym } : {} }).then((r) => r.data);
export const getPayrollHistory = (userId: string) =>
  api.get<{ user: { id: string; name: string }; rows: Array<{ ym: string; net: number; advances: number; status: string; paidAt: string | null }> }>(`/finance/payroll/history/${userId}`).then((r) => r.data);
export const payrollAdvance = (dto: { userId: string; ym: string; amount: number; accountId: string; date: string; note?: string }) =>
  api.post('/finance/payroll/advance', dto).then((r) => r.data);
export const payrollPay = (dto: { userId: string; ym: string; accountId: string; date: string }) => api.post('/finance/payroll/pay', dto).then((r) => r.data);
export const payrollClose = (ym: string) => api.post<{ ok: boolean; nextYm: string }>('/finance/payroll/close', { ym }).then((r) => r.data);
export const payrollReopen = (ym: string) => api.post('/finance/payroll/reopen', { ym }).then((r) => r.data);

export interface FinanceTransfer {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  toAmount: number;
  date: string;
  comment: string | null;
  recordedById: string | null;
  reversedAt: string | null;
  createdAt: string;
  fromAccount: FinanceAccountRef;
  toAccount: FinanceAccountRef;
}
export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  toAmount?: number | null;
  date?: string;
  comment?: string | null;
}
export const listTransfers = (params: { from?: string; to?: string } = {}) =>
  api.get<FinanceTransfer[]>('/finance/transfers', { params }).then((r) => r.data);
export const createTransfer = (dto: TransferInput) =>
  api.post<FinanceTransfer>('/finance/transfers', dto).then((r) => r.data);
export const reverseTransfer = (id: string) =>
  api.delete<FinanceTransfer>(`/finance/transfers/${id}`).then((r) => r.data);
