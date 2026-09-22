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

/** «Уволить»: вход закрыт, сессии отозваны, история сохраняется. */
export async function dismissUser(id: string) {
  const { data } = await api.post(`/users/${id}/dismiss`);
  return data;
}

export async function restoreUser(id: string) {
  const { data } = await api.post(`/users/${id}/restore`);
  return data;
}
