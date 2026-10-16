import { api } from './client';
import type { Role, User } from './types';

/** includeInactive — вместе с уволенными (экран «Сотрудники»); по умолчанию только действующие. */
export async function listUsers(search?: string, includeInactive?: boolean) {
  const { data } = await api.get<User[]>('/users', {
    params: { search: search ? search : undefined, includeInactive: includeInactive ? 1 : undefined },
  });
  return data;
}

export async function createUser(payload: {
  email: string;
  fullName: string;
  password: string;
  role: Role;
  /** Опц.: сразу привязать кастомную роль (Настройки → Роли и доступы). */
  customRoleId?: string | null;
}) {
  const { data } = await api.post<User>('/users', payload);
  return data;
}

export async function updateUser(id: string, payload: Partial<{ email: string; fullName: string; password: string; role: Role }>) {
  const { data } = await api.patch<User>(`/users/${id}`, payload);
  return data;
}

/** Кому передать дела: выбранному сотруднику или «автоматически» по нагрузке. */
export type HandoverBody = { mode: 'AUTO' } | { mode: 'USER'; toUserId: string };

/** Что числится за сотрудником (см. backend/src/users/handover.ts). */
export type HandoverCounts = {
  applications: number;
  students: number;
  deals: number;
  tasks: number;
  groups: number;
  sessions: number;
  revenueShares: number;
};

export type HandoverInfo = {
  user: { id: string; fullName: string; isActive: boolean };
  counts: HandoverCounts;
  total: number;
  /** Сколько менеджеров доступно режиму «автоматически». */
  autoTargets: { salesManagers: number; clientManagers: number };
  /** Действующие сотрудники, кому можно передать всё. */
  candidates: Array<{ id: string; fullName: string; role: Role; roles?: Role[] }>;
};

export async function getHandoverInfo(id: string) {
  const { data } = await api.get<HandoverInfo>(`/users/${id}/handover`);
  return data;
}

/**
 * «Уволить»: дела передаются (одной транзакцией с увольнением), вход закрыт,
 * сессии отозваны, из списков, рейтингов и чатов сотрудник пропадает;
 * история сохраняется.
 */
export async function dismissUser(id: string, body: HandoverBody = { mode: 'AUTO' }) {
  const { data } = await api.post(`/users/${id}/dismiss`, body);
  return data;
}

/** Передать дела уже уволенного сотрудника. */
export async function handoverUser(id: string, body: HandoverBody) {
  const { data } = await api.post(`/users/${id}/handover`, body);
  return data;
}

export async function restoreUser(id: string) {
  const { data } = await api.post(`/users/${id}/restore`);
  return data;
}
