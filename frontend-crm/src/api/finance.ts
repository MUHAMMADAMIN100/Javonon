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
  | 'OTHER_EXPENSE';

export const TRANSACTION_CATEGORY_LABEL: Record<TransactionCategory, string> = {
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
};
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
];

// === Google Sheet parity — enum-типы из Prisma-схемы, продублированы литералами.
// Держим совпадение с backend/prisma/schema.prisma: IncomeSource / ProductCategory
// / PaymentPhaseStatus. Если добавляется вариант — обновляем и здесь, и *_LABEL ниже.
export type IncomeSource = 'NEW_CLIENT' | 'UP_SALE' | 'OTHER';
export type ProductCategoryEnum = 'CONTRACT' | 'MASTERCLASS' | 'ACADEMY' | 'OTHER';
export type PaymentPhaseStatus = 'PREPAID' | 'FULL';

export const INCOME_SOURCE_LABEL: Record<IncomeSource, string> = {
  NEW_CLIENT: 'Новый клиент',
  UP_SALE: 'Апселл',
  OTHER: 'Прочее',
};
export const PRODUCT_CATEGORY_LABEL: Record<ProductCategoryEnum, string> = {
  CONTRACT: 'Контракт',
  MASTERCLASS: 'Мастер-класс',
  ACADEMY: 'Академия',
  OTHER: 'Другое',
};
export const PAYMENT_PHASE_LABEL: Record<PaymentPhaseStatus, string> = {
  PREPAID: 'Предоплата',
  FULL: 'Полная оплата',
};

export type PaymentChannel = 'ALIF_MOBILE' | 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'CRYPTO' | 'OTHER';
export type PaymentKind = 'FULL' | 'PREPAYMENT' | 'ADDITIONAL' | 'OWNER_INVESTMENT';
export type ReceiptKind = 'RECEIPT' | 'CASH_PHOTO' | 'REASON_ONLY';

export const PAYMENT_CHANNEL_LABEL: Record<PaymentChannel, string> = {
  ALIF_MOBILE: 'АлифМобайл',
  CASH: 'Наличные',
  BANK_TRANSFER: 'Банк. перевод',
  CARD: 'Карта',
  CRYPTO: 'Crypto',
  OTHER: 'Другое',
};
export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  FULL: 'Полная',
  PREPAYMENT: 'Предоплата',
  ADDITIONAL: 'Доплата',
  OWNER_INVESTMENT: 'Вложение собственника',
};

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
}

export interface FinanceSummary {
  totalIncome: number;
  totalExpense: number;
  netProfit: number;
  incomeCount: number;
  expenseCount: number;
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
}

export const listTransactions = (params?: {
  type?: TransactionType;
  category?: TransactionCategory;
  studentId?: string;
  managerId?: string;
  from?: string;
  to?: string;
  take?: number;
}) => api.get<Transaction[]>('/finance/transactions', { params }).then((r) => r.data);

export const createTransaction = (dto: CreateTransactionDto) =>
  api.post<Transaction>('/finance/transactions', dto).then((r) => r.data);

export const updateTransaction = (id: string, patch: Partial<CreateTransactionDto>) =>
  api.patch<Transaction>(`/finance/transactions/${id}`, patch).then((r) => r.data);

export const deleteTransaction = (id: string) =>
  api.delete(`/finance/transactions/${id}`).then((r) => r.data);

export const financeSummary = (params?: { from?: string; to?: string }) =>
  api.get<FinanceSummary>('/finance/summary', { params }).then((r) => r.data);

export const financeByCategory = (params?: { from?: string; to?: string }) =>
  api
    .get<Array<{ type: TransactionType; category: TransactionCategory; amount: number; count: number }>>(
      '/finance/by-category',
      { params },
    )
    .then((r) => r.data);

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

export interface FinanceDistribution {
  income: number;
  expense: number;
  net: number;
  distribution: { business: number; debts: number; reserve: number };
}
export const financeDistribution = (params?: { from?: string; to?: string }) =>
  api.get<FinanceDistribution>('/finance/distribution', { params }).then((r) => r.data);

export interface TopManager {
  manager: { id: string; fullName: string; email?: string };
  amount: number;
  count: number;
}
export const financeTopManagers = (params?: { from?: string; to?: string; limit?: number }) =>
  api.get<TopManager[]>('/finance/top-managers', { params }).then((r) => r.data);

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
    managerId: string | null;
    manager: { id: string; fullName: string; email?: string };
    amount: number;
    count: number;
  }>;
  byExpenseCategory: Array<{
    category: TransactionCategory | string;
    amount: number;
    count: number;
  }>;
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
