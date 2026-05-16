import { api } from './client';

export type CallDirection = 'INCOMING' | 'OUTGOING';
export type CallOutcome = 'ANSWERED' | 'NO_ANSWER' | 'BUSY' | 'CALLBACK' | 'CONVERTED';

export const CALL_DIRECTION_LABEL: Record<CallDirection, string> = {
  INCOMING: 'Входящий',
  OUTGOING: 'Исходящий',
};

export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  ANSWERED: 'Ответили',
  NO_ANSWER: 'Не ответили',
  BUSY: 'Занято',
  CALLBACK: 'Перезвонить',
  CONVERTED: 'Сделка',
};

export interface CallLog {
  id: string;
  userId: string;
  clientName: string;
  clientPhone: string | null;
  studentId: string | null;
  direction: CallDirection;
  outcome: CallOutcome;
  durationSeconds: number;
  notes: string | null;
  recordingUrl: string | null;
  occurredAt: string;
  createdAt: string;
  student?: { id: string; fullName: string } | null;
  user?: { id: string; fullName: string } | null;
}

export interface CreateCallDto {
  clientName: string;
  clientPhone?: string;
  studentId?: string | null;
  direction?: CallDirection;
  outcome?: CallOutcome;
  durationSeconds?: number;
  notes?: string;
  occurredAt?: string;
}

export interface CallStat {
  user: { id: string; fullName: string };
  totalCalls: number;
  totalSeconds: number;
  conversions: number;
}

export const listCalls = (params?: {
  mine?: boolean;
  userId?: string;
  from?: string;
  to?: string;
}) => api.get<CallLog[]>('/calls', { params }).then((r) => r.data);

export const createCall = (dto: CreateCallDto) =>
  api.post<CallLog>('/calls', dto).then((r) => r.data);

export const deleteCall = (id: string) =>
  api.delete(`/calls/${id}`).then((r) => r.data);

export const callsStats = (params?: { from?: string; to?: string }) =>
  api.get<CallStat[]>('/calls/stats', { params }).then((r) => r.data);

/** Секунды → «5м 30с» / «1ч 5м». */
export function fmtDuration(sec: number) {
  if (sec <= 0) return '0с';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}ч`);
  if (m) parts.push(`${m}м`);
  if (s && !h) parts.push(`${s}с`);
  return parts.join(' ') || '0с';
}
