import { api } from './client';

export type ActivityAction =
  | 'STATUS_CHANGE'
  | 'STUDENT_UPDATE'
  | 'STUDENT_CREATE'
  | 'STUDENT_DELETE'
  | 'MANAGER_CHANGE'
  | 'PROGRAM_CHANGE'
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_DELETE'
  // Finance audit trail — синхронизировано с backend/src/activity/activity.service.ts.
  // Без этих action'ов /activity никогда не показывал финансовые события:
  // dropdown-фильтр строится из ACTIVITY_LABEL, а карточка события берёт заголовок
  // из ACTIVITY_LABEL[e.action] — для finance-строк это возвращало undefined.
  | 'FINANCE_CREATE'
  | 'FINANCE_UPDATE'
  | 'FINANCE_DELETE'
  | 'TRANSACTION_MANAGER_CHANGE'
  | 'PAYMENT_APPROVED'
  | 'PAYMENT_REFUND'
  // Партнёру НЕ начислена комиссия за клиента, которого он привёл (истёк
  // 90-дневный TTL атрибуции / партнёр неактивен / дедуп). Строка приходит
  // только руководству — бэкенд вырезает её из GET /activity остальным
  // (activity.service.ts, PARTNER_SENSITIVE_ACTIONS).
  | 'PARTNER_COMMISSION_SKIPPED'
  // Обращение к превью «кто привёл клиента» в форме создания сделки
  // (GET /submissions/partner-preview) — единственное место, где партнёрские
  // данные видит менеджер по продажам. Пишется на каждый запрос, включая
  // отказ по скоупу и промах: серия отказов — признак подбора по списку
  // чужих номеров. Приходит только руководству (PARTNER_SENSITIVE_ACTIONS).
  | 'PARTNER_PREVIEW_LOOKUP';

export interface ActivityEntry {
  id: string;
  actorId: string | null;
  actorName: string;
  actorRole: string;
  action: ActivityAction;
  studentId: string | null;
  studentName: string | null;
  details: string;
  payload: any;
  createdAt: string;
}

export async function listActivity(filters: {
  actorId?: string;
  studentId?: string;
  action?: ActivityAction;
  from?: string;
  to?: string;
  take?: number;
} = {}) {
  const { data } = await api.get<ActivityEntry[]>('/activity', { params: filters });
  return data;
}

export const ACTIVITY_LABEL: Record<ActivityAction, string> = {
  STATUS_CHANGE: 'Смена статуса',
  STUDENT_UPDATE: 'Изменение студента',
  STUDENT_CREATE: 'Создание студента',
  STUDENT_DELETE: 'Удаление студента',
  MANAGER_CHANGE: 'Смена менеджера',
  PROGRAM_CHANGE: 'Изменение программы',
  DOCUMENT_UPLOAD: 'Загрузка документа',
  DOCUMENT_DELETE: 'Удаление документа',
  FINANCE_CREATE: 'Финансы: создание',
  FINANCE_UPDATE: 'Финансы: изменение',
  FINANCE_DELETE: 'Финансы: удаление',
  TRANSACTION_MANAGER_CHANGE: 'Смена менеджера транзакции',
  PAYMENT_APPROVED: 'Одобрение платежа',
  PAYMENT_REFUND: 'Возврат платежа',
  PARTNER_COMMISSION_SKIPPED: 'Комиссия партнёру не начислена',
  PARTNER_PREVIEW_LOOKUP: 'Запрос партнёра по клиенту',
};
