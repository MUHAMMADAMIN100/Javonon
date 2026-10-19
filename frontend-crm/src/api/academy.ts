import { api } from './client';
import type { ClassMaterial } from './studyGroups';

/**
 * Академия (backend/src/academy): журнал, материалы уроков, ученики,
 * уровни, красные флаги, дневник ДЗ, завершение курса. Итоги считает
 * сервер (journal-math.ts) — фронт их только показывает, чтобы цифры
 * журнала, карточки ученика и кабинета студента не разошлись.
 */

export type AcademyStatus = 'ACTIVE' | 'PENDING' | 'EXPELLED' | 'NO_GROUP';
export type Attendance = 'PRESENT' | 'ABSENT' | 'LATE';
export type LeftReason = 'REMOVED' | 'EXPELLED' | 'COMPLETED';

/** Красных флагов до решения руководства — как на сервере. */
export const FLAGS_FOR_DECISION = 4;
export const PCT_MAX = 100;

export interface LevelRef {
  id: string;
  name: string;
}

/** Строка листа урока: посещение, три процента и итог (среднее процентов, «не был» = 0). */
export interface LessonMark {
  attendance: Attendance | null;
  homeworkPct: number | null;
  vocabularyPct: number | null;
  performancePct: number | null;
  comment: string | null;
  total: number | null;
}

export interface JournalLesson {
  id: string;
  number: number;
  startsAt: string;
  endsAt: string;
  status: string;
  topic: string | null;
  teacherId: string | null;
  /** День урока по Душанбе 'YYYY-MM-DD'. */
  day: string;
  weekKey: string;
  /** Урок уже начался. */
  past: boolean;
  /** Отмечать можно с дня урока. */
  markable: boolean;
  hasHomework: boolean;
}

export interface StudentSummary {
  avg: number | null;
  attendancePct: number | null;
  held: number;
  attended: number;
  late: number;
  absent: number;
  graded: number;
  homeworkAvg: number | null;
  vocabularyAvg: number | null;
  performanceAvg: number | null;
}

export interface JournalStudent {
  id: string;
  fullName: string;
  photoUrl: string | null;
  joinedAt: string;
  leftAt: string | null;
  leftReason: LeftReason | null;
  active: boolean;
  expelled: boolean;
  flags: number;
  level: LevelRef | null;
  summary: StudentSummary;
}

export interface JournalWeek {
  key: string;
  index: number;
  from: string;
  to: string;
  groupAvg: number | null;
  /** studentId → средний итог недели. */
  values: Record<string, number>;
}

export interface Journal {
  group: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'ARCHIVED';
    teacherId: string | null;
    teacher: { id: string; fullName: string; isActive: boolean } | null;
    completedAt: string | null;
  };
  /** Руководство или учитель группы — правят всё; иначе (замена) — только свои уроки. */
  canEditAll: boolean;
  canManage: boolean;
  today: string;
  lessons: JournalLesson[];
  /** lessonId → ученики листа. */
  sheet: Record<string, string[]>;
  /** lessonId → studentId → отметка. */
  marks: Record<string, Record<string, LessonMark>>;
  students: JournalStudent[];
  weeks: JournalWeek[];
}

export interface EntryPatch {
  studentId: string;
  attendance?: Attendance | null;
  homeworkPct?: number | null;
  vocabularyPct?: number | null;
  performancePct?: number | null;
  comment?: string | null;
}

export async function getJournal(groupId: string) {
  const { data } = await api.get<Journal>(`/academy/groups/${groupId}/journal`);
  return data;
}

export async function saveEntries(sessionId: string, items: EntryPatch[]) {
  const { data } = await api.put<{ sessionId: string; entries: Array<LessonMark & { studentId: string }> }>(
    '/academy/journal/entries',
    { sessionId, items },
  );
  return data;
}

/** Итог урока по тем же правилам, что на сервере (для мгновенного отклика). */
export function lessonTotal(m: Pick<LessonMark, 'attendance' | 'homeworkPct' | 'vocabularyPct' | 'performancePct'>): number | null {
  if (m.attendance === 'ABSENT') return 0;
  const pcts = [m.homeworkPct, m.vocabularyPct, m.performancePct].filter((v): v is number => v !== null);
  if (!pcts.length) return null;
  return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
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

// ─── Уровни ───

export interface AcademyLevel extends LevelRef {
  sortOrder: number;
  /** Сколько учеников с этим уровнем. */
  students: number;
}

export async function listLevels() {
  const { data } = await api.get<AcademyLevel[]>('/academy/levels');
  return data;
}

export async function createLevel(name: string) {
  const { data } = await api.post<AcademyLevel[]>('/academy/levels', { name });
  return data;
}

export async function renameLevel(id: string, name: string) {
  const { data } = await api.patch<AcademyLevel[]>(`/academy/levels/${id}`, { name });
  return data;
}

export async function deleteLevel(id: string) {
  const { data } = await api.delete<AcademyLevel[]>(`/academy/levels/${id}`);
  return data;
}

export async function reorderLevels(ids: string[]) {
  const { data } = await api.post<AcademyLevel[]>('/academy/levels/reorder', { ids });
  return data;
}

export async function seedDefaultLevels() {
  const { data } = await api.post<AcademyLevel[]>('/academy/levels/defaults', {});
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
  level: LevelRef | null;
  groups: AcademyGroupRef[];
  summary: StudentSummary;
}

export interface AcademyStudentFilters {
  search?: string;
  groupId?: string;
  teacherId?: string;
  status?: AcademyStatus | '';
  type?: 'ACADEMY' | 'AGENCY' | '';
  /** id уровня или 'NONE' — без уровня. */
  levelId?: string;
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
  level: LevelRef | null;
  inGroup: boolean;
  groups: string[];
}

/** Руководство — поиск по всей базе (от 2 символов); учитель — ученики академии без группы. */
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
  fatherPhone?: string;
  motherPhone?: string;
  levelId?: string;
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

export interface LevelChange {
  id: string;
  fromName: string | null;
  toName: string | null;
  reason: 'START' | 'MANUAL' | 'COURSE' | string;
  createdAt: string;
  group: { id: string; name: string } | null;
  changedBy?: { id: string; fullName: string } | null;
}

export interface DiaryLog {
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudentDiary {
  sessionId: string;
  startsAt: string;
  topic: string | null;
  homework: string | null;
  homeworkDue: string | null;
  group: { id: string; name: string };
  days: string[];
  logs: Record<string, DiaryLog>;
}

export interface AcademyStudentCard {
  id: string;
  fullName: string;
  phones: string[];
  phoneLabels: string[];
  fatherPhone: string | null;
  motherPhone: string | null;
  email: string | null;
  birthday: string | null;
  age: number | null;
  photoUrl: string | null;
  academyOnly: boolean;
  comment: string | null;
  createdAt: string;
  status: AcademyStatus;
  level: LevelRef | null;
  levelHistory: LevelChange[];
  flagsActive: number;
  expelled: { at: string; note: string | null; by: { id: string; fullName: string } | null } | null;
  flags: AcademyFlag[];
  groups: Array<{
    membershipId: string;
    group: AcademyGroupRef & { teacherId: string | null; completedAt?: string | null };
    joinedAt: string;
    leftAt: string | null;
    leftReason: LeftReason | null;
    active: boolean;
    summary: StudentSummary;
    lessons: Array<{ id: string; number: number; startsAt: string; topic: string | null; mark: LessonMark | null }>;
    weeks: Array<{ key: string; index: number; from: string; to: string; value: number }>;
  }>;
  summary: StudentSummary;
  diary: StudentDiary[];
  comments: Array<{
    comment: string;
    mark: LessonMark;
    author: { id: string; fullName: string } | null;
    sessionId: string;
    date: string;
    topic: string | null;
    group: { id: string; name: string };
  }>;
  canManage: boolean;
  canEdit: boolean;
  canEditLevel: boolean;
  canResetPassword: boolean;
  canFlag: boolean;
  /** Снять флаг: руководство; роль — «Снятие флагов». */
  canRemoveFlags?: boolean;
  /** Оставить / отчислить / вернуть: руководство; роль — «Решения по ученикам». */
  canDecide?: boolean;
  flagGroups: Array<{ id: string; name: string }>;
}

export async function getAcademyStudent(id: string) {
  const { data } = await api.get<AcademyStudentCard>(`/academy/students/${id}`);
  return data;
}

export interface AcademyStudentPatch {
  fullName?: string;
  phone?: string;
  email?: string;
  birthday?: string;
  comment?: string;
  /** Пустая строка — стереть номер. */
  fatherPhone?: string;
  motherPhone?: string;
  /** Пустая строка — без уровня. */
  levelId?: string;
}

export async function updateAcademyStudent(id: string, patch: AcademyStudentPatch) {
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

// ─── Завершение курса ───

export interface CoursePreview {
  group: { id: string; name: string; status: 'ACTIVE' | 'ARCHIVED'; completedAt: string | null };
  levels: LevelRef[];
  futureLessons: number;
  students: Array<{
    id: string;
    fullName: string;
    photoUrl: string | null;
    level: LevelRef | null;
    suggestedLevelId: string | null;
  }>;
}

export async function getCoursePreview(groupId: string) {
  const { data } = await api.get<CoursePreview>(`/academy/groups/${groupId}/complete`);
  return data;
}

export async function completeCourse(groupId: string, items: Array<{ studentId: string; levelId: string | null }>) {
  const { data } = await api.post<{ ok: true; changed: number; students: number; cancelledLessons: number }>(
    `/academy/groups/${groupId}/complete`,
    { items },
  );
  return data;
}

// ─── Дневник ДЗ урока ───

export interface SessionDiary {
  session: {
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    topic: string | null;
    homework: string | null;
    homeworkDue: string | null;
    group: { id: string; name: string };
  };
  today: string;
  days: string[];
  /** joinedDay — день прихода в группу: раньше него дни дневника ученику не засчитываются. */
  students: Array<{ id: string; fullName: string; photoUrl: string | null; active: boolean; joinedDay?: string }>;
  /** studentId → день → запись. */
  logs: Record<string, Record<string, DiaryLog>>;
}

export async function getSessionDiary(sessionId: string) {
  const { data } = await api.get<SessionDiary>(`/academy/sessions/${sessionId}/diary`);
  return data;
}

// ─── Блок в карточке студента CRM ───

export type CrmAcademySummary =
  | { inAcademy: false }
  | {
      inAcademy: true;
      status: AcademyStatus;
      level: LevelRef | null;
      flagsActive: number;
      groups: Array<{ id: string; name: string; teacher: { id: string; fullName: string; isActive: boolean } | null }>;
      summary: StudentSummary;
    };

export async function getStudentAcademySummary(studentId: string) {
  const { data } = await api.get<CrmAcademySummary>(`/students/${studentId}/academy`);
  return data;
}
