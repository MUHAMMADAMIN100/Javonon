import { api } from './client';

/**
 * Свои поля анкеты лида («Лиды → Настройки → Поля анкеты», 13.11.2026).
 * Значения лежат у лида и студента в customFields: { [key]: значение }.
 */
export type LeadFieldType = 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'MULTI' | 'BOOL';

export interface LeadFieldOption {
  key: string;
  labelRu: string;
  labelTg: string;
}

export interface LeadField {
  id: string;
  key: string;
  labelRu: string;
  labelTg: string;
  type: LeadFieldType;
  options: LeadFieldOption[] | null;
  required: boolean;
  order: number;
}

export type CustomValue = string | number | boolean | string[];
export type CustomValues = Record<string, CustomValue>;

export interface LeadFieldInput {
  labelRu?: string;
  labelTg?: string | null;
  type?: LeadFieldType;
  required?: boolean;
  options?: Array<{ key?: string; labelRu: string; labelTg?: string | null }>;
}

export const LEAD_FIELD_TYPES: LeadFieldType[] = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI', 'BOOL'];

export async function fetchLeadFields(): Promise<LeadField[]> {
  const { data } = await api.get<{ items: LeadField[] }>('/lead-fields');
  return data.items;
}

export async function fetchLeadFieldUsage(): Promise<Record<string, number>> {
  const { data } = await api.get('/lead-fields/usage');
  return data;
}

export async function createLeadField(input: LeadFieldInput): Promise<LeadField> {
  const { data } = await api.post('/lead-fields', input);
  return data;
}

export async function updateLeadField(id: string, input: LeadFieldInput): Promise<LeadField> {
  const { data } = await api.patch(`/lead-fields/${id}`, input);
  return data;
}

export async function reorderLeadFields(ids: string[]): Promise<LeadField[]> {
  const { data } = await api.put('/lead-fields/order', { ids });
  return data;
}

export async function deleteLeadField(id: string): Promise<{ ok: boolean; cleared: number }> {
  const { data } = await api.delete(`/lead-fields/${id}`);
  return data;
}
