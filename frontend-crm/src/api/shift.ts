import { api } from './client';

/** Рабочая смена «как в Sabt» (13.11.2026): кнопка в меню, «Моя смена», «Активность и смены». */
export type ShiftState = 'idle' | 'working' | 'lunch' | 'break';
export type PauseKind = 'LUNCH' | 'WORK' | 'PERSONAL';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type AbsenceKind = 'DAYOFF' | 'VACATION' | 'SICK' | 'HOLIDAY';

export interface ShiftNotice {
  id: string;
  userId: string;
  name?: string;
  date: string;
  plannedTime: string;
  reason: string | null;
  status: RequestStatus;
  createdAt: string;
}

export interface ShiftEdit {
  id: string;
  userId: string;
  name?: string;
  date: string;
  field: 'start' | 'end';
  requestedTime: string;
  currentTime: string | null;
  note: string | null;
  status: RequestStatus;
  createdAt: string;
}

export interface MyShift {
  state: ShiftState;
  pauseKind: PauseKind | null;
  since: string | null;
  entryId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  autoClosed: boolean;
  workedMinutes: number;
  norm: { isWorkday: boolean; start: string; end: string; minutes: number };
  isLate: boolean;
  lateMinutes: number;
  needsExcuse: boolean;
  breaks: Array<{ kind: PauseKind; from: string; to: string | null; minutes: number; paid: boolean }>;
  notices: ShiftNotice[];
  edits: ShiftEdit[];
  week: Array<{ date: string; day: number; minutes: number }>;
  today: string;
  requiresLunchExcuse?: boolean;
  /** Время ответа — для счётчика, который идёт сам между запросами. */
  fetchedAt?: number;
}

export interface TeamPerson {
  id: string;
  name: string;
  role: string;
  position: string | null;
  isActive: boolean;
  status: 'working' | 'paused' | 'closed' | 'off' | 'absent' | 'waiting';
  pauseKind: PauseKind | null;
  absenceKind: AbsenceKind | null;
  startedAt: string | null;
  late: boolean;
  excused: boolean;
  todayMinutes: number;
  weekMinutes: number;
}

export interface MonthPerson {
  id: string;
  name: string;
  role: string;
  position: string | null;
  isActive: boolean;
  days: Record<number, number>;
  segments: Record<number, Array<{ from: string; to: string | null; auto: boolean; minutes: number }>>;
  breaks: Record<number, Array<{ kind: PauseKind; from: string; to: string | null; minutes: number }>>;
  lateDays: number[];
  autoDays: number[];
  absence: Record<number, AbsenceKind>;
  workedDays: number;
  totalMinutes: number;
  avgMinutes: number;
}

export interface ShiftMonth {
  month: string;
  daysInMonth: number;
  today: string;
  workStart: string;
  lateAfter: string;
  items: MonthPerson[];
  item?: MonthPerson | null;
}

export const SHIFT_KEY = ['shift', 'my'] as const;

export async function fetchMyShift(): Promise<MyShift> {
  const { data } = await api.get<MyShift>('/shift/my');
  return { ...data, fetchedAt: Date.now() };
}
export async function pauseShift(kind: PauseKind): Promise<MyShift> {
  const { data } = await api.post<MyShift>('/shift/pause', { kind });
  return { ...data, fetchedAt: Date.now() };
}
export async function resumeShift(): Promise<MyShift> {
  const { data } = await api.post<MyShift>('/shift/resume');
  return { ...data, fetchedAt: Date.now() };
}
export async function createNotice(body: { date: string; time: string; reason?: string }): Promise<ShiftNotice> {
  const { data } = await api.post('/shift/notices', body);
  return data;
}
export async function requestEdit(body: { date?: string; field: 'start' | 'end'; time: string; note?: string }): Promise<ShiftEdit> {
  const { data } = await api.post('/shift/edits', body);
  return data;
}
export async function fetchNotices(): Promise<ShiftNotice[]> {
  const { data } = await api.get('/shift/notices');
  return data;
}
export async function decideNotice(id: string, approve: boolean): Promise<ShiftNotice> {
  const { data } = await api.post(`/shift/notices/${id}/decide`, { approve });
  return data;
}
export async function fetchEdits(): Promise<ShiftEdit[]> {
  const { data } = await api.get('/shift/edits');
  return data;
}
export async function decideEdit(id: string, approve: boolean): Promise<ShiftEdit> {
  const { data } = await api.post(`/shift/edits/${id}/decide`, { approve });
  return data;
}
export async function setAbsence(body: { userId: string; date: string; kind: AbsenceKind }) {
  const { data } = await api.post('/shift/absences', body);
  return data;
}
export async function removeAbsence(userId: string, date: string) {
  const { data } = await api.delete(`/shift/absences/${userId}/${date}`);
  return data;
}
export async function fetchTeamToday(): Promise<{ date: string; workday: boolean; start: string; items: TeamPerson[] }> {
  const { data } = await api.get('/shift/team');
  return data;
}
export async function fetchShiftMonth(ym: string): Promise<ShiftMonth> {
  const { data } = await api.get('/shift/month', { params: { ym } });
  return data;
}
export async function fetchMyShiftMonth(ym: string): Promise<ShiftMonth> {
  const { data } = await api.get('/shift/my-month', { params: { ym } });
  return data;
}
