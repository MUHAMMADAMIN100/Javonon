import { api } from './client';
import type { PartnerAttributionView } from './types';

export type SubmissionStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type SubmissionPaymentStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type SubmissionPaymentMethod = 'TRANSFER' | 'CASH' | 'OTHER';

export interface SubmissionPayment {
  id: string;
  submissionId: string;
  amount: number;
  paymentMethod: SubmissionPaymentMethod;
  paidAt: string;
  receiptUrls: string[];
  depositProofUrls: string[];
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
  newStudentPassportUrls: string[];
  // Snapshot метаданных загруженных файлов (см. CreateSubmissionDto).
  newStudentPassportMimes: string[];
  newStudentPassportSizes: number[];
  newStudentPassportOriginalNames: string[];
  programId: string;
  managerId: string;
  contractUrls: string[];
  contractMimes: string[];
  contractSizes: number[];
  contractOriginalNames: string[];
  totalAmount: number;
  currency: string;
  status: SubmissionStatus;
  applicationId: string | null;
  /**
   * Заявка-ИСТОЧНИК: лид, из которого сделку завели кнопкой «Создать сделку».
   * Не путать с `applicationId` выше — ту создаёт одобрение первого платежа.
   * Именно по этой ссылке бэкенд находит партнёрскую атрибуцию с лендинга,
   * когда сделка заведена как «новый студент» и `studentId` ещё null.
   */
  sourceApplicationId: string | null;
  notes: string | null;
  firstApprovedAt: string | null;
  createdAt: string;
  updatedAt: string;
  payments: SubmissionPayment[];
  program?: { id: string; name: string; university: string };
  student?: { id: string; fullName: string } | null;
  manager?: { id: string; fullName: string; role: string };
  application?: { id: string; status: string } | null;
  /**
   * Партнёр, приведший клиента. Приходит ТОЛЬКО в GET /submissions/:id и
   * ТОЛЬКО руководству (FOUNDER/ADMIN/ACCOUNTANT) — см.
   * {@link PartnerAttributionView}. В списках (`/submissions`, `/mine`,
   * `/pending-payments`) поля нет никогда, поэтому оно опционально.
   */
  partnerAttribution?: PartnerAttributionView | null;
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
  /**
   * Заявка-источник (`/submissions/new?applicationId=…`, кнопка «Создать
   * сделку» в карточке заявки). Ложится в SaleSubmission.sourceApplicationId
   * и служит мостом к партнёрской атрибуции: без него сделка по лиду с
   * лендинга, заведённая как «новый студент», остаётся ничем не связана с
   * партнёром — комиссия не начисляется.
   */
  applicationId?: string | null;
  // Обновить email существующего студента при create (уникальность на бэке).
  existingStudentEmail?: string;
  newStudentName?: string;
  newStudentPhone?: string;
  newStudentEmail?: string;
  newStudentPassportUrls?: string[];
  // Метаданные паспорта (из ответа /submissions/upload). Бэкенд использует
  // их при APPROVE для создания Document с реальным mimeType/size/originalName.
  newStudentPassportMimes?: string[];
  newStudentPassportSizes?: number[];
  newStudentPassportOriginalNames?: string[];
  programId: string;
  contractUrls: string[];
  // Метаданные контракта (см. выше про паспорт).
  contractMimes?: string[];
  contractSizes?: number[];
  contractOriginalNames?: string[];
  totalAmount: number;
  currency?: string;
  notes?: string;
  firstPayment: CreatePaymentDto;
}

export interface CreatePaymentDto {
  amount: number;
  paymentMethod?: SubmissionPaymentMethod;
  paidAt: string;
  receiptUrls?: string[];
  depositProofUrls?: string[];
  nextDueDate?: string | null;
  nextDueAmount?: number | null;
  notes?: string;
}

export interface UpdateSubmissionDto {
  contractUrls?: string[];
  contractMimes?: string[];
  contractSizes?: number[];
  contractOriginalNames?: string[];
  totalAmount?: number;
  currency?: string;
  notes?: string | null;
  studentId?: string | null;
  newStudentName?: string | null;
  newStudentPhone?: string | null;
  newStudentEmail?: string | null;
  newStudentPassportUrls?: string[];
  newStudentPassportMimes?: string[];
  newStudentPassportSizes?: number[];
  newStudentPassportOriginalNames?: string[];
  programId?: string;
  // Обновить email существующего студента (когда submission привязана к
  // Student, а не к snapshot нового). Валидация уникальности email на бэке.
  existingStudentEmail?: string | null;
}

export interface UpdatePaymentDto {
  amount?: number;
  paymentMethod?: SubmissionPaymentMethod;
  paidAt?: string;
  receiptUrls?: string[];
  depositProofUrls?: string[];
  nextDueDate?: string | null;
  nextDueAmount?: number | null;
  notes?: string | null;
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
  firstApproved?: boolean;
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

export const updateSubmission = (id: string, data: UpdateSubmissionDto) =>
  api.patch<SaleSubmission>(`/submissions/${id}`, data).then((r) => r.data);

export const updatePayment = (id: string, data: UpdatePaymentDto) =>
  api.patch<SubmissionPayment>(`/submissions/payments/${id}`, data).then((r) => r.data);

export const deletePayment = (id: string) =>
  api.delete<{ ok: true; reversed: boolean }>(`/submissions/payments/${id}`).then((r) => r.data);

export const deleteSubmission = (id: string) =>
  api.delete<{ ok: true }>(`/submissions/${id}`).then((r) => r.data);

export const uploadSubmissionFile = (file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  // mimeType — с бэка (после валидации multer'ом), фронт использует его как
  // источник истины для contractMime/newStudentPassportMime при createSubmission.
  return api
    .post<{ url: string; originalName: string; mimeType: string; size: number }>('/submissions/upload', fd, {
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
