import { api } from './client';
import type { Role, User } from './types';

export async function listUsers(search?: string) {
  const { data } = await api.get<User[]>('/users', {
    params: { search: search ? search : undefined },
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

export async function deleteUser(id: string) {
  const { data } = await api.delete(`/users/${id}`);
  return data;
}
