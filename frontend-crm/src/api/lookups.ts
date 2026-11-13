import { api } from './client';

/**
 * Справочники «Лиды → Настройки» (13.11.2026): статусы лидов, направления,
 * страны, источники. Раньше это были зашитые списки в api/types.ts —
 * добавить статус или страну мог только программист.
 */
export type LookupKind = 'LEAD_STATUS' | 'DIRECTION' | 'COUNTRY' | 'LEAD_SOURCE';

export interface LookupItem {
  id: string;
  kind: LookupKind;
  /** Ключ, который лежит в строке лида/студента/программы. */
  key: string;
  labelRu: string;
  labelTg: string;
  color: string | null;
  order: number;
  isSystem: boolean;
  showOnSite: boolean;
  clientLabel: string | null;
  isClosed: boolean;
}

export interface LookupInput {
  kind?: LookupKind;
  labelRu?: string;
  labelTg?: string | null;
  color?: string | null;
  showOnSite?: boolean;
  clientLabel?: string | null;
  isClosed?: boolean;
}

export const LOOKUP_KINDS: LookupKind[] = ['LEAD_STATUS', 'DIRECTION', 'COUNTRY', 'LEAD_SOURCE'];

/** Источники, которые ставит только система (зеркало MACHINE_SOURCES на сервере). */
export const MACHINE_SOURCES = ['LANDING_FORM', 'SELF_REGISTRATION', 'REFERRAL'];

/** Статусы потока заявки: «закрытым» их сделать нельзя (зеркало FLOW_STATUSES). */
export const FLOW_STATUSES = ['NEW_LEAD', 'IN_PROCESSING', 'SUCCESSFUL_LEAD'];

export async function fetchLookups(): Promise<LookupItem[]> {
  const { data } = await api.get<{ items: LookupItem[] }>('/lookups');
  return data.items;
}

export async function fetchLookupUsage(): Promise<Record<LookupKind, Record<string, number>>> {
  const { data } = await api.get('/lookups/usage');
  return data;
}

export async function createLookup(input: LookupInput): Promise<LookupItem> {
  const { data } = await api.post('/lookups', input);
  return data;
}

export async function updateLookup(id: string, input: LookupInput): Promise<LookupItem> {
  const { data } = await api.patch(`/lookups/${id}`, input);
  return data;
}

export async function reorderLookups(kind: LookupKind, ids: string[]): Promise<LookupItem[]> {
  const { data } = await api.put('/lookups/order', { kind, ids });
  return data;
}

export async function deleteLookup(id: string, moveTo?: string): Promise<{ ok: boolean; moved: number }> {
  const { data } = await api.delete(`/lookups/${id}`, { params: moveTo ? { moveTo } : undefined });
  return data;
}
