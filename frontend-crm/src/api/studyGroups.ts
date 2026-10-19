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
  /** Вышел из группы (убран, отчислен, окончил курс) — в журнале остаётся за свои уроки. */
  leftAt: string | null;
  leftReason: 'REMOVED' | 'EXPELLED' | 'COMPLETED' | null;
  student: {
    id: string;
    fullName: string;
    phones: string[];
    email: string | null;
    status: string;
    photoUrl?: string | null;
    /** Ученик только академии (не клиент агентства). */
    academyOnly?: boolean;
    academyExpelledAt?: string | null;
    academyLevel?: { id: string; name: string } | null;
  };
}

export type ClassMaterialKind = 'FILE' | 'LINK';

export interface ClassMaterial {
  id: string;
  kind: ClassMaterialKind;
  title: string;
  /** FILE — /uploads/academy/…, LINK — внешний адрес. */
  url: string;
  size: number | null;
  mimeType: string | null;
  createdAt?: string;
}

/** «По каким дням»: weekday 1 = Пн … 7 = Вс, время 'HH:mm'. */
export interface WeeklySlot {
  weekday: number;
  from: string;
  to: string;
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
  /** ДЗ к уроку и срок (UTC-полночь календарного дня). */
  homework?: string | null;
  homeworkDue?: string | null;
  createdAt: string;
  updatedAt: string;
  /** В ленте календаря приходит группа, в карточке группы — нет. */
  group?: GroupRef;
  teacher?: TeacherRef | null;
  /** Только в карточке группы. */
  materials?: ClassMaterial[];
  /** Сколько отметок в журнале и записей дневника ДЗ — с ними занятие нельзя удалить, только отменить. */
  _count?: { journal: number; homeworkLogs?: number };
}

export interface StudyGroup {
  id: string;
  name: string;
  programId: string | null;
  teacherId: string | null;
  status: StudyGroupStatus;
  description: string | null;
  /** «Завершить курс»: ученикам выставлены уровни, группа в архиве. */
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  program?: { id: string; name: string } | null;
  teacher?: TeacherRef | null;
  _count?: { members: number; sessions: number };
  /** Только в списке: ближайшее занятие и «по каким дням» (4 недели вперёд). */
  nextSession?: { startsAt: string; endsAt: string; topic: string | null } | null;
  pattern?: WeeklySlot[];
}

export interface StudyGroupDetail extends StudyGroup {
  members: GroupMember[];
  sessions: ClassSession[];
  completedBy?: TeacherRef | null;
  /**
   * manage — руководство академии; run — ведёт группу (учитель или
   * руководство); addStudents — добавлять учеников (учитель своей идущей
   * группы, руководство); complete — «Завершить курс».
   */
  /** Что можно в этой группе (study-groups.service getGroup). */
  access: {
    /** Вкладка «Настройки»: edit или remove. */
    manage: boolean;
    edit: boolean;
    remove: boolean;
    /** Ведение: журнал, уроки, ДЗ, материалы, расписание, флаги. */
    run: boolean;
    addStudents: boolean;
    createStudents: boolean;
    removeMembers: boolean;
    complete: boolean;
  };
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
  /** Пустая строка — стереть. */
  homework?: string;
  /** 'YYYY-MM-DD' или пустая строка — без срока. */
  homeworkDue?: string;
  teacherId?: string;
  status?: ClassSessionStatus;
}

/** Занятия по шаблону: дни недели 1 = Пн … 7 = Вс, время 'HH:mm', даты 'YYYY-MM-DD'. */
export interface BulkSessionsDto {
  weekdays: number[];
  startTime: string;
  endTime: string;
  from: string;
  to: string;
  topic?: string;
  dryRun?: boolean;
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

/**
 * Что будет при удалении группы. canDelete = нет оценок (marks) и записей
 * дневника ДЗ (diary); members — кто в группе сейчас.
 */
export interface GroupRemoval {
  id: string;
  name: string;
  status: StudyGroupStatus;
  sessions: number;
  members: number;
  materials: number;
  marks: number;
  diary: number;
  canDelete: boolean;
}

export async function getGroupRemoval(id: string) {
  const { data } = await api.get<GroupRemoval>(`/study-groups/${id}/removal`);
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

/** Шаблон расписания. dryRun → { count, skipped }, иначе → { created, skipped }. */
export async function bulkSessions(groupId: string, payload: BulkSessionsDto) {
  const { data } = await api.post<{ count?: number; created?: number; skipped: number }>(
    `/study-groups/${groupId}/sessions/bulk`,
    payload,
  );
  return data;
}
