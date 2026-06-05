import { api } from './client';

export type InteractionType = 'CALL' | 'EMAIL' | 'MEETING' | 'NOTE' | 'SMS' | 'TELEGRAM' | 'WHATSAPP';

export const INTERACTION_LABEL: Record<InteractionType, string> = {
  CALL: 'Звонок',
  EMAIL: 'Email',
  MEETING: 'Встреча',
  NOTE: 'Заметка',
  SMS: 'SMS',
  TELEGRAM: 'Telegram',
  WHATSAPP: 'WhatsApp',
};

export const INTERACTION_ICON: Record<InteractionType, string> = {
  CALL: 'call',
  EMAIL: 'mail',
  MEETING: 'groups',
  NOTE: 'sticky_note_2',
  SMS: 'sms',
  TELEGRAM: 'send',
  WHATSAPP: 'chat',
};

export interface Interaction {
  id: string;
  studentId: string;
  authorId: string | null;
  type: InteractionType;
  summary: string;
  details: string | null;
  visibleToStudent: boolean;
  occurredAt: string;
  createdAt: string;
  author?: { id: string; fullName: string; role: string } | null;
}

export const listInteractions = (studentId: string) =>
  api.get<Interaction[]>('/interactions', { params: { studentId } }).then((r) => r.data);

/**
 * Полная история взаимодействий по клиенту (Interaction + CallLog +
 * ExternalMessage). Каждая запись имеет дискриминатор `source`:
 * 'interaction' | 'call' | 'message'. Используется для рендера единой
 * ленты в карточке студента по ТЗ §8.
 */
export interface TimelineItem {
  source: 'interaction' | 'call' | 'message';
  id: string;
  summary: string;
  details: string | null;
  occurredAt: string;
  // interaction-only
  type?: InteractionType;
  author?: { id: string; fullName: string; role: string } | null;
  // call-only
  direction?: 'INCOMING' | 'OUTGOING' | 'IN' | 'OUT';
  outcome?: string;
  durationSeconds?: number;
  recordingUrl?: string | null;
  // message-only
  channel?: 'WHATSAPP' | 'INSTAGRAM' | 'TELEGRAM' | 'SMS';
  mediaUrl?: string | null;
}

export const fullTimeline = (studentId: string) =>
  api.get<TimelineItem[]>('/interactions/timeline', { params: { studentId } }).then((r) => r.data);

export const createInteraction = (data: {
  studentId: string;
  type: InteractionType;
  summary: string;
  details?: string;
  visibleToStudent?: boolean;
  occurredAt?: string;
}) => api.post<Interaction>('/interactions', data).then((r) => r.data);

export const updateInteraction = (id: string, data: Partial<{ summary: string; details: string; visibleToStudent: boolean }>) =>
  api.patch<Interaction>(`/interactions/${id}`, data).then((r) => r.data);

export const deleteInteraction = (id: string) =>
  api.delete(`/interactions/${id}`).then((r) => r.data);
