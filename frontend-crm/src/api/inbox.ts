import { api } from './client';

export type InboxChannel = 'WHATSAPP' | 'INSTAGRAM' | 'TELEGRAM' | 'SMS';
export type InboxDirection = 'IN' | 'OUT';
export type InboxStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export const INBOX_CHANNEL_LABEL: Record<InboxChannel, string> = {
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  TELEGRAM: 'Telegram',
  SMS: 'SMS',
};

export const INBOX_CHANNEL_ICON: Record<InboxChannel, string> = {
  WHATSAPP: 'chat_bubble',
  INSTAGRAM: 'photo_camera',
  TELEGRAM: 'send',
  SMS: 'sms',
};

export interface InboxMessage {
  id: string;
  externalId: string | null;
  channel: InboxChannel;
  direction: InboxDirection;
  status: InboxStatus;
  fromHandle: string | null;
  toHandle: string | null;
  content: string | null;
  mediaUrl: string | null;
  applicationId: string | null;
  studentId: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export const inboxThreads = (channel?: InboxChannel) =>
  api.get<InboxMessage[]>('/integrations/inbox/threads', { params: channel ? { channel } : {} }).then((r) => r.data);

export const inboxThread = (channel: InboxChannel, handle: string) =>
  api.get<InboxMessage[]>('/integrations/inbox/thread', { params: { channel, handle } }).then((r) => r.data);

// Send-replies через те же endpoint-ы, что и одиночная отправка.
export const sendWhatsapp = (to: string, message: string, ctx?: { applicationId?: string; studentId?: string }) =>
  api.post('/integrations/whatsapp/send', { to, message, ...ctx }).then((r) => r.data);

export const sendInstagram = (igUserId: string, message: string, ctx?: { applicationId?: string; studentId?: string }) =>
  api.post('/integrations/instagram/send', { igUserId, message, ...ctx }).then((r) => r.data);
