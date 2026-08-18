import { api } from './client';
import type { Direction, Document, Student, StudentStatus } from './types';

export interface StudentFilters {
  direction?: Direction;
  status?: StudentStatus;
  cabinet?: number;
  search?: string;
  mine?: boolean;
  /** Фильтр по менеджеру (TJ или CN) — userId */
  manager?: string;
  /** true = только с TUITION_PAYMENT, false = только без, undefined = все. */
  paid?: boolean;
  /**
   * BUG #16: typeahead-пикеры (SubmissionForm и пр.) шлют limit, чтобы не
   * тянуть 1000+ студентов на каждый keystroke. Бэк кэпит на 200.
   */
  limit?: number;
}

export async function listStudents(filters: StudentFilters = {}) {
  const { data } = await api.get<Student[]>('/students', { params: filters });
  return data;
}

/**
 * Карточка студента. Единственный ответ, который может нести
 * `partnerAttribution` (Student.partnerAttribution → PartnerAttributionView):
 * бэкенд добавляет его только для FOUNDER/ADMIN/ACCOUNTANT, остальным ключа
 * в JSON нет вовсе. Поэтому поле опционально и рисуется по факту наличия.
 */
export async function getStudent(id: string) {
  const { data } = await api.get<Student>(`/students/${id}`);
  return data;
}

export async function ensureStudentApplication(id: string) {
  const { data } = await api.post(`/students/${id}/ensure-application`);
  return data;
}

export async function updateStudentForm(id: string, form: any) {
  const { data } = await api.patch(`/students/${id}/form`, form);
  return data;
}

export async function createStudent(payload: Partial<Student>) {
  const { data } = await api.post<Student>('/students', payload);
  return data;
}

export async function updateStudent(id: string, payload: Partial<Student>) {
  const { data } = await api.patch<Student>(`/students/${id}`, payload);
  return data;
}

export async function assignStudentManager(
  id: string,
  patch: { managerId?: string | null; chinaManagerId?: string | null },
) {
  const { data } = await api.patch<Student>(`/students/${id}/manager`, patch);
  return data;
}

export async function deleteStudent(id: string) {
  const { data } = await api.delete(`/students/${id}`);
  return data;
}

export async function regenerateStudentPassword(id: string) {
  const { data } = await api.post<{ email: string; password: string }>(
    `/students/${id}/regenerate-password`,
  );
  return data;
}

export async function uploadPhoto(id: string, file: File) {
  const fd = new FormData(); fd.append('file', file);
  const { data } = await api.post<Student>(`/students/${id}/photo`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function uploadDocument(id: string, file: File, type: string = 'OTHER') {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('type', type);
  const { data } = await api.post<Document>(`/students/${id}/documents`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function deleteDocument(docId: string) {
  const { data } = await api.delete(`/students/documents/${docId}`);
  return data;
}

/** См. applications.ts: те же from/to (YYYY-MM-DD, границы включительно). */
export async function studentStats(range?: { from?: string; to?: string }) {
  const { data } = await api.get('/students/stats', { params: range });
  return data;
}
