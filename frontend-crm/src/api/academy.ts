import { api } from './client';
import type { ClassMaterial } from './studyGroups';

/**
 * Академия (backend/src/academy): журнал, материалы уроков, ученики,
 * красные флаги. Итоги недель считает сервер (journal-math.ts) — фронт их
 * только показывает, чтобы цифры журнала, карточки ученика и кабинета
 * студента не разошлись.
 */

export type AcademyStatus = 'ACTIVE' | 'PENDING' | 'EXPELLED' | 'NO_GROUP';

/** Границы шкалы — те же, что на сервере. */
export const SCORE_MAX = 5;
export const EXAM_MAX = 70;
export const BONUS_MAX = 10;
export const FLAGS_FOR_DECISION = 3;

export interface JournalCell {
  present: boolean | null;
  score: number | null;
  comment: string | null;
}

export interface JournalRow {
  studentId: string;
  entries: Record<string, JournalCell>;
  bonus: number | null;
  exam: number | null;
  held: number;
  attended: number;
  lessonPoints: number;
  total: number;
  final: boolean;
}

export interface JournalLesson {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  topic: string | null;
  teacherId: string | null;
  /** Урок уже начался — отмечать можно, идёт в итог. */
  past: boolean;
}

export interface JournalWeek {
  key: string;
  index: number;
  from: string;
  to: string;
  lessons: JournalLesson[];
  rows: JournalRow[];
}

export interface StudentSummary {
  avg: number | null;
  attendancePct: number | null;
  finalWeeks: number;
  held: number;
  attended: number;
}

export interface JournalStudent {
  id: string;
  fullName: string;
  photoUrl: string | null;
  joinedAt: string;
  leftAt: string | null;
  leftReason: 'REMOVED' | 'EXPELLED' | null;
  active: boolean;
  expelled: boolean;
  flags: number;
  summary: StudentSummary;
}

export interface Journal {
  group: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'ARCHIVED';
    teacherId: string | null;
    teacher: { id: string; fullName: string; isActive: boolean } | null;
  };
  /** Руководство или учитель группы — правят всё; иначе (замена) — только свои уроки. */
  canEditAll: boolean;
  canManage: boolean;
  /** Понедельник текущей недели 'YYYY-MM-DD'. */
  currentWeek: string;
  students: JournalStudent[];
  weeks: JournalWeek[];
}

export interface EntryPatch {
  studentId: string;
  present?: boolean | null;
  score?: number | null;
  comment?: string | null;
}

export interface WeekPatch {
  studentId: string;
  bonus?: number | null;
  exam?: number | null;
}

export async function getJournal(groupId: string) {
  const { data } = await api.get<Journal>(`/academy/groups/${groupId}/journal`);
  return data;
}

export async function saveEntries(sessionId: string, items: EntryPatch[]) {
  const { data } = await api.put<{ sessionId: string; entries: Array<JournalCell & { studentId: string }> }>(
    '/academy/journal/entries',
    { sessionId, items },
  );
  return data;
}

export async function saveWeeks(groupId: string, weekStart: string, items: WeekPatch[]) {
  const { data } = await api.put('/academy/journal/weeks', { groupId, weekStart, items });
  return data;
}

// ─── Материалы урока ───

export async function uploadMaterials(sessionId: string, files: File[]) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const { data } = await api.post<ClassMaterial[]>(`/academy/sessions/${sessionId}/materials`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 10 * 60_000,
  });
  return data;
}

export async function addMaterialLink(sessionId: string, url: string, title?: string) {
  const { data } = await api.post<ClassMaterial>(`/academy/sessions/${sessionId}/links`, { url, title });
  return data;
}

export async function deleteMaterial(id: string) {
  const { data } = await api.delete<{ ok: true }>(`/academy/materials/${id}`);
  return data;
}

// ─── Ученики ───

export interface AcademyGroupRef {
  id: string;
  name: string;
  status?: 'ACTIVE' | 'ARCHIVED';
  teacher?: { id: string; fullName: string; isActive: boolean } | null;
}

export interface AcademyStudentRow {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  photoUrl: string | null;
  age: number | null;
  academyOnly: boolean;
  createdAt: string;
  status: AcademyStatus;
  flags: number;
  groups: AcademyGroupRef[];
  summary: StudentSummary;
}

export interface AcademyStudentFilters {
  search?: string;
  groupId?: string;
  teacherId?: string;
  status?: AcademyStatus | '';
  type?: 'ACADEMY' | 'AGENCY' | '';
}

export async function listAcademyStudents(filters: AcademyStudentFilters = {}) {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) if (v) params[k] = String(v);
  const { data } = await api.get<{ items: AcademyStudentRow[]; counts: Record<AcademyStatus | 'ALL', number> }>(
    '/academy/students',
    { params },
  );
  return data;
}

export interface PickedStudent {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  academyOnly: boolean;
  expelled: boolean;
  inGroup: boolean;
  groups: string[];
}

export async function pickStudents(search: string, groupId?: string) {
  const { data } = await api.get<PickedStudent[]>('/academy/students/pick', { params: { search, groupId } });
  return data;
}

export interface NewAcademyStudent {
  fullName: string;
  phone: string;
  email: string;
  birthday?: string;
  comment?: string;
  groupId?: string;
}

export async function createAcademyStudent(payload: NewAcademyStudent) {
  const { data } = await api.post<{ id: string; fullName: string; email: string; password: string }>(
    '/academy/students',
    payload,
  );
  return data;
}

export interface AcademyFlag {
  id: string;
  reason: string;
  createdAt: string;
  removedAt: string | null;
  removeReason: string | null;
  group: { id: string; name: string } | null;
  givenBy: { id: string; fullName: string; isActive: boolean } | null;
  removedBy: { id: string; fullName: string; isActive: boolean } | null;
}

export interface AcademyWeekResult {
  key: string;
  index: number;
  from: string;
  to: string;
  held: number;
  attended: number;
  lessonPoints: number;
  bonus: number | null;
  exam: number | null;
  total: number;
  final: boolean;
}

export interface AcademyStudentCard {
  id: string;
  fullName: string;
  phones: string[];
  email: string | null;
  birthday: string | null;
  age: number | null;
  photoUrl: string | null;
  academyOnly: boolean;
  comment: string | null;
  createdAt: string;
  status: AcademyStatus;
  flagsActive: number;
  expelled: { at: string; note: string | null; by: { id: string; fullName: string } | null } | null;
  flags: AcademyFlag[];
  groups: Array<{
    membershipId: string;
    group: AcademyGroupRef & { teacherId: string | null };
    joinedAt: string;
    leftAt: string | null;
    leftReason: 'REMOVED' | 'EXPELLED' | null;
    active: boolean;
    summary: StudentSummary;
    weeks: AcademyWeekResult[];
  }>;
  summary: StudentSummary;
  comments: Array<{
    comment: string;
    score: number | null;
    present: boolean | null;
    author: { id: string; fullName: string } | null;
    sessionId: string;
    date: string;
    topic: string | null;
    group: { id: string; name: string };
  }>;
  canManage: boolean;
  canFlag: boolean;
  flagGroups: Array<{ id: string; name: string }>;
}

export async function getAcademyStudent(id: string) {
  const { data } = await api.get<AcademyStudentCard>(`/academy/students/${id}`);
  return data;
}

export async function updateAcademyStudent(
  id: string,
  patch: { fullName?: string; phone?: string; email?: string; birthday?: string; comment?: string },
) {
  const { data } = await api.patch<AcademyStudentCard>(`/academy/students/${id}`, patch);
  return data;
}

export async function resetAcademyPassword(id: string) {
  const { data } = await api.post<{ email: string; password: string }>(`/academy/students/${id}/password`, {});
  return data;
}

// ─── Флаги и решения ───

export async function giveFlag(studentId: string, reason: string, groupId?: string) {
  const { data } = await api.post<{ activeFlags: number; needsDecision: boolean }>(
    `/academy/students/${studentId}/flags`,
    { reason, groupId: groupId || undefined },
  );
  return data;
}

export async function removeFlag(flagId: string, reason?: string) {
  const { data } = await api.post<{ ok: true }>(`/academy/flags/${flagId}/remove`, { reason: reason || undefined });
  return data;
}

export async function decide(studentId: string, action: 'EXPEL' | 'KEEP', note?: string) {
  const { data } = await api.post<AcademyStudentCard>(`/academy/students/${studentId}/decision`, {
    action,
    note: note || undefined,
  });
  return data;
}

export async function reinstate(studentId: string, groupId?: string) {
  const { data } = await api.post<AcademyStudentCard>(`/academy/students/${studentId}/reinstate`, {
    groupId: groupId || undefined,
  });
  return data;
}

// ─── Блок в карточке студента CRM ───

export type CrmAcademySummary =
  | { inAcademy: false }
  | {
      inAcademy: true;
      status: AcademyStatus;
      flagsActive: number;
      groups: Array<{ id: string; name: string; teacher: { id: string; fullName: string; isActive: boolean } | null }>;
      summary: StudentSummary;
    };

export async function getStudentAcademySummary(studentId: string) {
  const { data } = await api.get<CrmAcademySummary>(`/students/${studentId}/academy`);
  return data;
}
