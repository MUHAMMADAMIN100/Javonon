import { api } from './client';

export interface PermissionDef {
  key: string;
  label: string;
  group: string;
}

export interface CustomRole {
  id: string;
  name: string;
  description?: string | null;
  permissions: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { users: number };
}

export const listPermissionsCatalog = () =>
  api.get<PermissionDef[]>('/custom-roles/catalog').then((r) => r.data);

export const listCustomRoles = () =>
  api.get<CustomRole[]>('/custom-roles').then((r) => r.data);

export const createCustomRole = (data: { name: string; description?: string; permissions: string[] }) =>
  api.post<CustomRole>('/custom-roles', data).then((r) => r.data);

export const updateCustomRole = (id: string, data: { name?: string; description?: string; permissions?: string[]; isActive?: boolean }) =>
  api.patch<CustomRole>(`/custom-roles/${id}`, data).then((r) => r.data);

export const deleteCustomRole = (id: string) =>
  api.delete<{ ok: true }>(`/custom-roles/${id}`).then((r) => r.data);

export const setUserCustomRole = (userId: string, customRoleId: string | null) =>
  api.put(`/users/${userId}/custom-role`, { customRoleId }).then((r) => r.data);
