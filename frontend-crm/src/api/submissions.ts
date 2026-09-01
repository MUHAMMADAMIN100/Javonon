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
   * Партнёр, приведший клиента. Приходит ТОЛЬКО руководству
   * (FOUNDER/ADMIN/ACCOUNTANT — канонический `canSeePartnerAttribution` на
   * бэке) и только там, где бэкенд поле прикладывает: GET /submissions/:id,
   * GET /submissions (список «Все»/«Одобренные») и вложенная сделка в
   * GET /submissions/pending-payments. В /submissions/mine поля нет.
   * Отсюда опциональность: `undefined` = не приложили, `null` = клиент
   * органический. Рисуются одинаково — ничем.
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

/**
 * Ответ GET /submissions/partner-preview — «кто привёл этого клиента» для
 * формы создания сделки.
 *
 * ЭТО НЕ {@link PartnerAttributionView}, и подменять одно другим нельзя.
 * Эндпоинт открыт в том числе SALES_MANAGER/CLIENT_MANAGER, которым
 * партнёрские данные закрыты во всех остальных местах CRM, поэтому бэкенд
 * осознанно сузил ответ до трёх полей: ни partnerId, ни referralUrl, ни
 * commissionId, ни дат начисления — чтобы форма не превратилась в справочник
 * партнёров, доступный менеджеру.
 */
export interface SubmissionPartnerPreview {
  fullName: string;
  referralCode: string;
  /** Копейки. См. {@link commissionCurrency} — от неё зависит форматтер. */
  commissionAmountCents: number;
  /**
   * null = сумма это ПРОГНОЗ по текущей фикс-ставке партнёра (всегда TJS),
   * строка = сумма взята из реальной Commission. Ровно та же семантика, что
   * у PartnerAttributionView.commissionCurrency.
   */
  commissionCurrency: string | null;
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
  /**
   * Только сделки клиентов, закреплённых за этим партнёром. Совпадение ищется
   * по студенту и по заявке (включая заявку-источник сделки из вкладки
   * «Новый»), поэтому находятся и те сделки, где студент ещё не заведён.
   */
  partnerId?: string;
}) => api.get<SaleSubmission[]>('/submissions', { params }).then((r) => r.data);

export const listPendingPayments = (params?: {
  /**
   * Только платежи клиентов, закреплённых за этим партнёром. Совпадение
   * бэкенд ищет так же, как в `listAllSubmissions`: по студенту, по заявке и
   * по заявке-источнику сделки — иначе сделки без заведённого студента
   * (а на вкладке «На рассмотрении» их большинство) не нашлись бы.
   */
  partnerId?: string;
}) => api.get<PendingPayment[]>('/submissions/pending-payments', { params }).then((r) => r.data);

/**
 * Кто привёл клиента, которого менеджер вводит прямо сейчас. ТОЛЬКО ЧТЕНИЕ —
 * ничего не создаёт и не меняет, поэтому дёргать на каждый ввод безопасно.
 *
 * Матчинг делает бэкенд: по студенту (`studentId`) либо по последним 9 цифрам
 * телефона. Нормализовать телефон здесь НЕ НАДО — эталон нормализации один и
 * живёт на сервере (`backend/src/common/phone.ts`), вторая копия на клиенте
 * рано или поздно разъедется с ней и форма начнёт показывать не того
 * партнёра, которого запишет создание сделки.
 *
 * `applicationId` — заявка-источник (`/submissions/new?applicationId=…`).
 * ПЕРЕДАВАТЬ ОБЯЗАТЕЛЬНО ВЕЗДЕ, ГДЕ ЕГО ПЕРЕДАЁТ {@link createSubmission}:
 * именно эту заявку сделка и запишет, а без неё сервер вынужден искать заявку
 * заново («старейшая атрибуция выигрывает») и находит другую — плашка назовёт
 * одного партнёра, а комиссию получит другой (или никто).
 *
 * `signal` — из queryFn-контекста react-query: при размонтировании формы или
 * смене телефона висящий запрос отменяется, а не долетает ответом на уже
 * устаревший ввод.
 */
export const previewSubmissionPartner = (
  params: { phone?: string; studentId?: string; applicationId?: string },
  signal?: AbortSignal,
) =>
  api
    .get<SubmissionPartnerPreview | null>('/submissions/partner-preview', { params, signal })
    .then((r) => {
      // Nest отдаёт `null` ПУСТЫМ телом (ExpressAdapter.reply: isNil → send()),
      // и axios в этом случае кладёт в data пустую строку, а не null. Без
      // приведения `data` был бы '' с типом объекта — падало бы на первом же
      // обращении к полю.
      const d = r.data;
      return d && typeof d === 'object' ? d : null;
    });

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

/**
 * Валюты сделки — ОДИН список с бэкендом (submissions.service.ts,
 * SUBMISSION_CURRENCIES). Значение вне списка бэк отвергает 400-й: по
 * SaleSubmission.currency зарплатный модуль отбирает одобренные платежи в
 * бонусную базу месяца (своей валюты у платежа нет), поэтому произвольная
 * строка тихо выкидывала сделку из объёма продаж менеджера.
 *
 * Валюта РЕДАКТИРУЕМА только до первого одобрения платежа
 * (submission.firstApprovedAt === null) — дальше она заморожена, иначе правка
 * переписала бы бонусную базу уже закрытых месяцев.
 */
export const SUBMISSION_CURRENCIES = ['TJS', 'USD', 'EUR', 'CNY', 'RUB'] as const;

export const SUBMISSION_CURRENCY_LABEL: Record<string, string> = {
  TJS: 'TJS (сомони)',
  USD: 'USD',
  EUR: 'EUR',
  CNY: 'CNY (юань)',
  RUB: 'RUB',
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
