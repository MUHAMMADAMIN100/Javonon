import { api } from './client';

/**
 * Группы и расписание занятий (backend/src/study-groups).
 *
 * ЕДИНСТВЕННЫЙ путь к расписанию — ГРУППА. Индивидуальное занятие = группа
 * из одного студента; параллельного «персонального» API нет и заводить его
 * нельзя — иначе календарь, напоминания и кабинет студента разъедутся.
 */

export type StudyGroupStatus = 'ACTIVE' | 'ARCHIVED';
export type ClassSessionStatus = 'SCHEDULED' | 'DONE' | 'CANCELLED';

export interface GroupRef {
  id: string;
  name: string;
  teacherId?: string | null;
  program?: { id: string; name: string } | null;
  _count?: { members: number };
}

export interface TeacherRef {
  id: string;
  fullName: string;
}

export interface GroupMember {
  id: string;
  groupId: string;
  studentId: string;
  joinedAt: string;
  student: {
    id: string;
    fullName: string;
    phones: string[];
    email: string | null;
    status: string;
  };
}

export interface ClassSession {
  id: string;
  groupId: string;
  startsAt: string;
  endsAt: string;
  topic: string | null;
  teacherId: string | null;
  status: ClassSessionStatus;
  reminderSentAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** В ленте календаря приходит группа, в карточке группы — нет. */
  group?: GroupRef;
  teacher?: TeacherRef | null;
}

export interface StudyGroup {
  id: string;
  name: string;
  programId: string | null;
  teacherId: string | null;
  status: StudyGroupStatus;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  program?: { id: string; name: string } | null;
  teacher?: TeacherRef | null;
  _count?: { members: number; sessions: number };
}

export interface StudyGroupDetail extends StudyGroup {
  members: GroupMember[];
  sessions: ClassSession[];
}

export interface CreateStudyGroupDto {
  name: string;
  programId?: string;
  teacherId?: string;
  description?: string;
  studentIds?: string[];
}

export interface UpdateStudyGroupDto {
  name?: string;
  /** Пустая строка = отвязать программу (nullable-связь на бэке). */
  programId?: string;
  /** Пустая строка = снять преподавателя. */
  teacherId?: string;
  status?: StudyGroupStatus;
  description?: string;
}

export interface CreateClassSessionDto {
  /** `YYYY-MM-DDTHH:mm` — наивное время трактуется бэком как душанбинское. */
  startsAt: string;
  endsAt: string;
  topic?: string;
  teacherId?: string;
}

export interface UpdateClassSessionDto {
  startsAt?: string;
  endsAt?: string;
  topic?: string;
  teacherId?: string;
  status?: ClassSessionStatus;
}

export interface GroupFilters {
  status?: StudyGroupStatus;
  teacherId?: string;
  programId?: string;
  search?: string;
}

export async function listGroups(filters: GroupFilters = {}) {
  const { data } = await api.get<StudyGroup[]>('/study-groups', { params: filters });
  return data;
}

export async function getGroup(id: string) {
  const { data } = await api.get<StudyGroupDetail>(`/study-groups/${id}`);
  return data;
}

export async function createGroup(payload: CreateStudyGroupDto) {
  const { data } = await api.post<StudyGroup>('/study-groups', payload);
  return data;
}

export async function updateGroup(id: string, payload: UpdateStudyGroupDto) {
  const { data } = await api.patch<StudyGroup>(`/study-groups/${id}`, payload);
  return data;
}

export async function deleteGroup(id: string) {
  const { data } = await api.delete<{ ok: true }>(`/study-groups/${id}`);
  return data;
}

export async function addGroupMembers(id: string, studentIds: string[]) {
  const { data } = await api.post<StudyGroupDetail>(`/study-groups/${id}/members`, { studentIds });
  return data;
}

export async function removeGroupMember(id: string, studentId: string) {
  const { data } = await api.delete<StudyGroupDetail>(`/study-groups/${id}/members/${studentId}`);
  return data;
}

/**
 * Лента занятий календаря. Границы — `YYYY-MM-DD`; бэк раскрывает их в
 * ДУШАНБИНСКИЕ сутки, поэтому строку сюда даём календарную (tjToday и пр.),
 * а не ISO-момент, посчитанный в таймзоне браузера.
 */
export async function listSessions(params: {
  from?: string;
  to?: string;
  groupId?: string;
  teacherId?: string;
} = {}) {
  const { data } = await api.get<ClassSession[]>('/study-groups/sessions', { params });
  return data;
}

export async function createSession(groupId: string, payload: CreateClassSessionDto) {
  const { data } = await api.post<ClassSession>(`/study-groups/${groupId}/sessions`, payload);
  return data;
}

export async function updateSession(sessionId: string, payload: UpdateClassSessionDto) {
  const { data } = await api.patch<ClassSession>(`/study-groups/sessions/${sessionId}`, payload);
  return data;
}

export async function deleteSession(sessionId: string) {
  const { data } = await api.delete<{ ok: true }>(`/study-groups/sessions/${sessionId}`);
  return data;
}
