import axios from 'axios';
import { connectStudentRealtime, disconnectStudentRealtime } from './realtime';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';
export const API_BASE = API_URL.replace(/\/api$/, '');

const TOKEN_KEY = 'javonon_student_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => {
  localStorage.setItem(TOKEN_KEY, t);
  connectStudentRealtime(t);
};
export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  disconnectStudentRealtime();
};

const client = axios.create({ baseURL: API_URL });
client.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

export type StudentDoc = {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  type: string;
  createdAt: string;
};

export type StudentMe = {
  id: string;
  fullName: string;
  email: string | null;
  phones: string[];
  direction: 'BACHELOR' | 'MASTER' | 'LANGUAGE';
  cabinet: number;
  status: 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'ARCHIVED';
  comment: string | null;
  photoUrl: string | null;
  documents: StudentDoc[];
  manager: { id: string; fullName: string; email: string } | null;
  chinaManager: { id: string; fullName: string; email: string } | null;
  applications?: { id: string; status: string; createdAt: string }[];
  createdAt: string;
};

export async function studentRegister(payload: {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  direction?: string;
  comment?: string;
  /** Реферальный код партнёра — авто-подставляется из localStorage если есть */
  ref?: string;
}) {
  // Авто-добавление ref из localStorage если не передали
  let body: any = { ...payload };
  if (!body.ref) {
    try {
      const stored = localStorage.getItem('javonon_ref');
      if (stored) {
        const r = JSON.parse(stored);
        if (r?.code) body.ref = r.code;
      }
    } catch {}
  }
  const { data } = await client.post<{ token: string; student: { id: string; email: string; fullName: string } }>(
    '/student-auth/register',
    body,
  );
  setToken(data.token);
  return data;
}

export type StudentTransaction = {
  id: string;
  amount: number;
  currency: string;
  category: string;
  date: string;
  comment: string | null;
};

export type StudentPayment = {
  id: string;
  amount: number;
  currency: string;
  method: 'CARD' | 'BANK_TRANSFER' | 'CASH' | 'CRYPTO' | 'OTHER';
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';
  comment: string | null;
  createdAt: string;
  confirmedAt: string | null;
};

export async function listStudentPayments(): Promise<StudentPayment[]> {
  const { data } = await client.get<StudentPayment[]>('/student-payments');
  return data;
}

export async function createStudentPayment(payload: {
  amount: number;
  currency?: string;
  method?: 'CARD' | 'BANK_TRANSFER' | 'CASH' | 'CRYPTO' | 'OTHER';
  comment?: string;
}): Promise<StudentPayment> {
  const { data } = await client.post<StudentPayment>('/student-payments', payload);
  return data;
}

export async function cancelStudentPayment(id: string) {
  return client.post(`/student-payments/${id}/cancel`).then((r) => r.data);
}

export type StudentInteraction = {
  id: string;
  type: 'CALL' | 'EMAIL' | 'MEETING' | 'NOTE' | 'SMS' | 'TELEGRAM' | 'WHATSAPP';
  summary: string;
  details: string | null;
  occurredAt: string;
  author: { id: string; fullName: string; role: string } | null;
};

export async function listStudentInteractions(): Promise<StudentInteraction[]> {
  const { data } = await client.get<StudentInteraction[]>('/student-interactions');
  return data;
}

export async function listStudentTransactions(): Promise<StudentTransaction[]> {
  const { data } = await client.get<StudentTransaction[]>('/student-auth/transactions');
  return data;
}

export type StudentCourse = {
  enrollmentId: string;
  course: { id: string; title: string; coverUrl: string | null; description: string | null };
  totalLessons: number;
  completedLessons: number;
  progress: number;
  enrolledAt: string;
  completedAt: string | null;
};

export async function listStudentCourses(): Promise<StudentCourse[]> {
  const { data } = await client.get<StudentCourse[]>('/student-lms/my-courses');
  return data;
}

export async function listAvailableCourses(): Promise<any[]> {
  const { data } = await client.get<any[]>('/student-lms/available');
  return data;
}

export async function getStudentCourse(id: string): Promise<any> {
  const { data } = await client.get<any>(`/student-lms/courses/${id}`);
  return data;
}

export async function enrollInCourse(id: string): Promise<any> {
  const { data } = await client.post<any>(`/student-lms/courses/${id}/enroll`);
  return data;
}

export async function completeLesson(id: string): Promise<any> {
  const { data } = await client.post<any>(`/student-lms/lessons/${id}/complete`);
  return data;
}

export async function studentLogin(email: string, password: string) {
  const { data } = await client.post<{ token: string; student: { id: string; email: string; fullName: string } }>(
    '/student-auth/login',
    { email, password },
  );
  setToken(data.token);
  return data;
}

export async function studentMe() {
  const { data } = await client.get<StudentMe>('/student-auth/me');
  return data;
}

export async function studentUploadDocument(file: File, type: string) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('type', type);
  const { data } = await client.post<StudentDoc>('/student-auth/documents', fd);
  return data;
}

export async function studentDeleteDocument(id: string) {
  const { data } = await client.delete(`/student-auth/documents/${id}`);
  return data;
}

export type ApplicationFormData = any;

export async function getStudentForm() {
  const { data } = await client.get<{ form: ApplicationFormData | null }>('/student-auth/form');
  return data.form;
}

export async function saveStudentForm(form: ApplicationFormData) {
  const { data } = await client.patch<{ form: ApplicationFormData }>('/student-auth/form', form);
  return data.form;
}

export interface StudentProgram {
  id: string;
  name: string;
  university: string;
  city: string;
  major: string;
  direction: 'BACHELOR' | 'MASTER' | 'LANGUAGE';
  cost: number;
  currency: string;
  duration: string | null;
  language: string | null;
  description: string | null;
  imageUrl: string | null;
  published: boolean;
  englishLevel?: string | null;
  hasGrant?: boolean;
  grantDetails?: string | null;
  grantEnglishLevel?: string | null;
  avgAdmissionScore?: string | null;
  applicationDeadline?: string | null;
  intakesPerYear?: number | null;
  createdAt: string;
}

export async function listStudentPrograms(filters: {
  city?: string;
  major?: string;
  direction?: string;
  minCost?: number;
  maxCost?: number;
  search?: string;
} = {}) {
  const { data } = await client.get<StudentProgram[]>('/student-auth/programs', { params: filters });
  return data;
}

export async function getStudentProgramFilters() {
  const { data } = await client.get<{ cities: string[]; majors: string[] }>('/student-auth/programs/filters');
  return data;
}

export type KnowledgeCategory = {
  slug: string;
  title: string;
  icon: string;
  summary: string;
  articleCount: number;
};

export type KnowledgeArticle = {
  id: string;
  title: string;
  processSteps: string[];
  documents: string[];
  duration: string;
  cost: string;
  tips: string;
};

export type KnowledgeCategoryDetail = KnowledgeCategory & {
  articles: KnowledgeArticle[];
};

export async function listKnowledge(): Promise<KnowledgeCategory[]> {
  const res = await fetch(`${API_URL}/knowledge`);
  return res.json();
}

export async function getKnowledgeCategory(slug: string): Promise<KnowledgeCategoryDetail | null> {
  const res = await fetch(`${API_URL}/knowledge/${slug}`);
  return res.json();
}

/* ─────────────────────── РАСПИСАНИЕ ЗАНЯТИЙ (кабинет) ───────────────────────
 * Читаем /student-schedule/*: id студента бэкенд берёт из токена, поэтому
 * параметра «чьё расписание» тут нет и быть не должно. Индивидуальный студент
 * на бэкенде — это группа из одного человека, отдельной ветки под него нет.
 */

export type StudentClassSessionStatus = 'SCHEDULED' | 'DONE' | 'CANCELLED';

export type StudentClassSession = {
  id: string;
  /** UTC ISO. Рисовать только через tjDate.ts — сутки душанбинские. */
  startsAt: string;
  endsAt: string;
  topic: string | null;
  status: StudentClassSessionStatus;
  group: {
    id: string;
    name: string;
    program: { id: string; name: string } | null;
  };
  /**
   * Замена штатного преподавателя на конкретное занятие. NULL = ведёт
   * преподаватель группы, но его имя в этот ответ бэкенд не кладёт —
   * поэтому строку «Устод» показываем только когда имя реально пришло.
   */
  teacher: { id: string; fullName: string } | null;
};

export async function listStudentUpcomingSessions(limit?: number): Promise<StudentClassSession[]> {
  const { data } = await client.get<StudentClassSession[]>('/student-schedule/upcoming', {
    params: limit ? { limit } : undefined,
  });
  return data;
}

/* ────────────────────────── РАССРОЧКА (кабинет) ──────────────────────────
 * /student-installments/mine. Деньги — ЦЕЛЫЕ единицы валюты сделки (не
 * центы), те же, что у сумм платежей выше. Валюта своя у каждого плана и
 * наследуется из сделки, поэтому суммарный остаток бэкенд отдаёт разбитым
 * по валютам, а не одним числом.
 */

export type StudentPaymentStageStatus = 'PENDING' | 'PAID' | 'OVERDUE';

export type StudentPaymentStage = {
  id: string;
  /** 1-based. */
  order: number;
  title: string | null;
  amount: number;
  /** UTC ISO; сутки срока — душанбинские. */
  dueDate: string;
  status: StudentPaymentStageStatus;
  paidAt: string | null;
};

export type StudentInstallmentTotals = {
  stageCount: number;
  paid: number;
  outstanding: number;
  overdueAmount: number;
  overdueCount: number;
  nextDueDate: string | null;
};

export type StudentInstallmentPlan = {
  submissionId: string;
  currency: string;
  totalAmount: number;
  program: { id: string; name: string } | null;
  stages: StudentPaymentStage[];
  totals: StudentInstallmentTotals;
};

export type StudentInstallments = {
  plans: StudentInstallmentPlan[];
  /** Остаток по каждой валюте отдельно — складывать USD с TJS нельзя. */
  outstandingByCurrency: Record<string, number>;
};

export async function listStudentInstallments(): Promise<StudentInstallments> {
  const { data } = await client.get<StudentInstallments>('/student-installments/mine');
  return data;
}
