import { loadAllPages } from '../lib/loadAllPages';
import { api } from './client';

export interface AttendanceEntry {
  id: string;
  userId: string;
  clockIn: string;
  clockOut: string | null;
  lunchOut: string | null;
  lunchIn: string | null;
  status: 'WORKING' | 'ON_LUNCH' | 'OFF';
  lateMinutes: number;
  totalMinutes: number;
  totalLunchMinutes: number;
  lateExcuseReason: string | null;
  lateExcuseStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  date: string;
  user: { id: string; fullName: string; role: string; email: string };
}

export interface AttendanceFilters {
  userId?: string;
  from?: string;
  to?: string;
}

/** Одна порция: сервер отдаёт не больше 1000 отметок (по умолчанию 100). */
export const listAttendance = (params: AttendanceFilters & { take?: number; skip?: number } = {}) =>
  api.get<AttendanceEntry[]>('/attendance', { params }).then((r) => r.data);

/** ВСЕ отметки по фильтру — порциями (lib/loadAllPages): «Посещаемость команды». */
export const loadAllAttendance = (params: AttendanceFilters = {}) =>
  loadAllPages((page) => listAttendance({ ...params, ...page }));
