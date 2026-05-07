import { api } from './client';

export type PaymentStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';
export type PaymentMethod = 'CARD' | 'BANK_TRANSFER' | 'CASH' | 'CRYPTO' | 'OTHER';

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  PENDING: 'Ожидает',
  CONFIRMED: 'Подтверждена',
  REJECTED: 'Отклонена',
  CANCELLED: 'Отменена',
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CARD: 'Карта',
  BANK_TRANSFER: 'Банковский перевод',
  CASH: 'Наличные',
  CRYPTO: 'Криптовалюта',
  OTHER: 'Другое',
};

export interface Payment {
  id: string;
  studentId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  comment: string | null;
  receiptUrl: string | null;
  confirmedById: string | null;
  confirmedAt: string | null;
  transactionId: string | null;
  createdAt: string;
  student?: { id: string; fullName: string; email: string | null; phones: string[]; managerId: string | null };
  confirmedBy?: { id: string; fullName: string };
}

export const listPayments = (status?: PaymentStatus) =>
  api.get<Payment[]>('/payments', { params: status ? { status } : undefined }).then((r) => r.data);

export const confirmPayment = (id: string, data: { actualAmount?: number; method?: PaymentMethod }) =>
  api.post<Payment>(`/payments/${id}/confirm`, data).then((r) => r.data);

export const rejectPayment = (id: string, comment?: string) =>
  api.post<Payment>(`/payments/${id}/reject`, { comment }).then((r) => r.data);
