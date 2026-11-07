import { api } from './client';
import type { User } from './types';

export async function login(email: string, password: string) {
  const { data } = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
  return data;
}

export async function me() {
  const { data } = await api.get<User>('/auth/me');
  return data;
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const { data } = await api.post<{ ok: true }>('/auth/change-password', {
    currentPassword,
    newPassword,
  });
  return data;
}

/** «Войти как» сотрудник (только основатель): токен его сессии на 1 час. */
export async function impersonate(userId: string) {
  const { data } = await api.post<{ token: string; user: User }>(`/auth/impersonate/${userId}`);
  return data;
}

/** Закончить режим «Войти как» (гасит сессию режима на сервере). */
export async function stopImpersonation() {
  const { data } = await api.post<{ ok: true }>('/auth/impersonate/stop');
  return data;
}
