import { api } from './client';

export const aiParse = (text: string) =>
  api.post<any>('/ai/parse-transaction', { text }).then((r) => r.data);

export const aiAddTransaction = (text: string) =>
  api.post<{ ok: boolean; parsed?: any; transaction?: any; error?: string }>('/ai/add-transaction', { text }).then((r) => r.data);
