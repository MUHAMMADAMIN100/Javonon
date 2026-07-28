import { api } from './client';
import type { Application, ApplicationSource, ApplicationStatus, Country, Direction, Student } from './types';

export interface AppFilters {
  status?: ApplicationStatus;
  direction?: Direction;
  /** Страна, выбранная клиентом на лендинге (GET /applications?country=…). */
  country?: Country;
  search?: string;
  mine?: boolean;
  /** Фильтр по конкретному менеджеру (TJ или CN) — userId */
  manager?: string;
  /** Источник заявки — сайт, Instagram, реферал и т.д. */
  source?: ApplicationSource;
}

export async function listApplications(filters: AppFilters = {}) {
  const { data } = await api.get<Application[]>('/applications', { params: filters });
  return data;
}

export async function getApplication(id: string) {
  const { data } = await api.get<Application>(`/applications/${id}`);
  return data;
}

export async function updateApplication(id: string, payload: Partial<Application>) {
  const { data } = await api.patch<Application>(`/applications/${id}`, payload);
  return data;
}

export async function assignApplicationManager(
  id: string,
  patch: { managerId?: string | null; chinaManagerId?: string | null },
) {
  const { data } = await api.patch<Application>(`/applications/${id}/manager`, patch);
  return data;
}

export async function convertApplication(id: string) {
  const { data } = await api.post<Student>(`/applications/${id}/convert`);
  return data;
}

export async function deleteApplication(id: string) {
  const { data } = await api.delete(`/applications/${id}`);
  return data;
}

export async function applicationStats() {
  const { data } = await api.get('/applications/stats');
  return data;
}
