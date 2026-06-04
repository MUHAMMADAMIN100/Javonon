import { api } from './client';

export type MassMailChannel = 'WHATSAPP' | 'INSTAGRAM' | 'TELEGRAM' | 'SMS';
export type MassMailStatus = 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELED' | 'FAILED';

export const MASS_MAIL_CHANNEL_LABEL: Record<MassMailChannel, string> = {
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  TELEGRAM: 'Telegram',
  SMS: 'SMS',
};

export const MASS_MAIL_STATUS_LABEL: Record<MassMailStatus, string> = {
  DRAFT: 'Черновик',
  SCHEDULED: 'Запланирована',
  SENDING: 'Отправка',
  SENT: 'Отправлена',
  CANCELED: 'Отменена',
  FAILED: 'Ошибка',
};

export interface MassMailCampaign {
  id: string;
  name: string;
  channel: MassMailChannel;
  subject: string | null;
  body: string;
  audience: any;
  status: MassMailStatus;
  sentCount: number;
  failedCount: number;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listCampaigns = () =>
  api.get<MassMailCampaign[]>('/integrations/massmail').then((r) => r.data);

export const createCampaign = (data: {
  name: string;
  channel: MassMailChannel;
  subject?: string;
  body: string;
  audience: { type: 'all-leads' | 'paid-students' | 'by-direction'; value?: string };
  scheduledAt?: string;
}) =>
  api.post<MassMailCampaign>('/integrations/massmail', data).then((r) => r.data);

export const sendCampaignNow = (id: string) =>
  api.post<MassMailCampaign>(`/integrations/massmail/${id}/send`).then((r) => r.data);

export const cancelCampaign = (id: string) =>
  api.post<MassMailCampaign>(`/integrations/massmail/${id}/cancel`).then((r) => r.data);
