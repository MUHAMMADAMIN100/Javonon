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

export const listAttendance = (params: { userId?: string; from?: string; to?: string; take?: number } = {}) =>
  api.get<AttendanceEntry[]>('/attendance', { params }).then((r) => r.data);
