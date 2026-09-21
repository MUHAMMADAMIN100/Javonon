import { api } from './client';

/** ONLINE — CRM открыта и были действия за 5 мин; AWAY — открыта, но без действий; OFFLINE — закрыта. */
export type PresenceState = 'ONLINE' | 'AWAY' | 'OFFLINE';

export interface PresenceRow {
  userId: string;
  state: PresenceState;
  /** Последняя активность (для «был(а) в сети …»). */
  lastSeenAt: string | null;
  lastLoginAt: string | null;
}

/** Только основатель (иначе 403). */
export async function getPresence(): Promise<PresenceRow[]> {
  const { data } = await api.get<PresenceRow[]>('/users/presence');
  return data;
}
