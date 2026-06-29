import { api } from './client';

export type SubmissionStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type SubmissionPaymentStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type SubmissionPaymentMethod = 'TRANSFER' | 'CASH' | 'OTHER';

export interface SubmissionPayment {
  id: string;
  submissionId: string;
  amount: number;
  paymentMethod: SubmissionPaymentMethod;
  paidAt: string;
  receiptUrl: string | null;
  depositProofUrl: string | null;
  nextDueDate: string | null;
  nextDueAmount: number | null;
  notes: string | null;
  status: SubmissionPaymentStatus;
  reviewedById: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  financeTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: { id: string; fullName: string } | null;
}

export interface SaleSubmission {
  id: string;
  studentId: string | null;
  newStudentName: string | null;
  newStudentPhone: string | null;
  newStudentEmail: string | null;
  newStudentPassportUrl: string | null;
  // Snapshot метаданных загруженных файлов (см. CreateSubmissionDto).
  newStudentPassportMime: string | null;
  newStudentPassportSize: number | null;
  newStudentPassportOriginalName: string | null;
  programId: string;
  managerId: string;
  contractUrl: string;
  contractMime: string | null;
  contractSize: number | null;
  contractOriginalName: string | null;
  totalAmount: number;
  currency: string;
  status: SubmissionStatus;
  applicationId: string | null;
  notes: string | null;
  firstApprovedAt: string | null;
  createdAt: string;
  updatedAt: string;
  payments: SubmissionPayment[];
  program?: { id: string; name: string; university: string };
  student?: { id: string; fullName: string } | null;
  manager?: { id: string; fullName: string; role: string };
  application?: { id: string; status: string } | null;
}

export interface PendingPayment extends SubmissionPayment {
  submission: SaleSubmission & {
    program: { id: string; name: string; university: string };
    student: { id: string; fullName: string } | null;
    manager: { id: string; fullName: string };
  };
}

export interface CreateSubmissionDto {
  studentId?: string | null;
  newStudentName?: string;
  newStudentPhone?: string;
  newStudentEmail?: string;
  newStudentPassportUrl?: string;
  // Метаданные паспорта (из ответа /submissions/upload). Бэкенд использует
  // их при APPROVE для создания Document с реальным mimeType/size/originalName.
  newStudentPassportMime?: string;
  newStudentPassportSize?: number;
  newStudentPassportOriginalName?: string;
  programId: string;
  contractUrl: string;
  // Метаданные контракта (см. выше про паспорт).
  contractMime?: string;
  contractSize?: number;
  contractOriginalName?: string;
  totalAmount: number;
  currency?: string;
  notes?: string;
  firstPayment: CreatePaymentDto;
}

export interface CreatePaymentDto {
  amount: number;
  paymentMethod?: SubmissionPaymentMethod;
  paidAt: string;
  receiptUrl?: string;
  depositProofUrl?: string;
  nextDueDate?: string | null;
  nextDueAmount?: number | null;
  notes?: string;
}

export const createSubmission = (data: CreateSubmissionDto) =>
  api.post<SaleSubmission>('/submissions', data).then((r) => r.data);

export const addPayment = (submissionId: string, data: CreatePaymentDto) =>
  api.post<SubmissionPayment>(`/submissions/${submissionId}/payments`, data).then((r) => r.data);

export const listMySubmissions = (params?: { status?: SubmissionStatus }) =>
  api.get<SaleSubmission[]>('/submissions/mine', { params }).then((r) => r.data);

export const listAllSubmissions = (params?: {
  status?: SubmissionStatus;
  paymentStatus?: SubmissionPaymentStatus;
  managerId?: string;
  take?: number;
}) => api.get<SaleSubmission[]>('/submissions', { params }).then((r) => r.data);

export const listPendingPayments = () =>
  api.get<PendingPayment[]>('/submissions/pending-payments').then((r) => r.data);

export const getSubmission = (id: string) =>
  api.get<SaleSubmission>(`/submissions/${id}`).then((r) => r.data);

export const approvePayment = (id: string) =>
  api.post<SubmissionPayment>(`/submissions/payments/${id}/approve`).then((r) => r.data);

export const rejectPayment = (id: string, reason: string) =>
  api.post<SubmissionPayment>(`/submissions/payments/${id}/reject`, { reason }).then((r) => r.data);

export const changeSubmissionStatus = (id: string, status: SubmissionStatus) =>
  api.post<SaleSubmission>(`/submissions/${id}/status`, { status }).then((r) => r.data);

export const uploadSubmissionFile = (file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  return api
    .post<{ url: string; originalName: string; size: number }>('/submissions/upload', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
};

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  ACTIVE: 'Активна',
  COMPLETED: 'Закрыта',
  CANCELLED: 'Отменена',
};

export const PAYMENT_STATUS_LABEL: Record<SubmissionPaymentStatus, string> = {
  PENDING: 'На рассмотрении',
  APPROVED: 'Одобрено',
  REJECTED: 'Отклонено',
};

export const PAYMENT_METHOD_LABEL: Record<SubmissionPaymentMethod, string> = {
  TRANSFER: 'Перевод',
  CASH: 'Наличные',
  OTHER: 'Прочее',
};
