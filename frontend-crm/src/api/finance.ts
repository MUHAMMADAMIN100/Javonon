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
  OTHER_INCOME: 'Прочий доход',
  OTHER_EXPENSE: 'Прочие расходы',
};

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
  'OTHER_EXPENSE',
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
