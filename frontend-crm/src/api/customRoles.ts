import { api } from './client';

/** Место пункта в таблице редактора (backend auth/permissions.ts). */
export type PermissionKind = 'read' | 'create' | 'update' | 'delete' | 'extra';

export interface PermissionDef {
  key: string;
  /** Полная подпись по-русски: «Лиды — удаление и возврат из корзины». */
  label: string;
  /** Группа редактора: CRM, Связь, …, Данные (видимость данных). */
  group: string;
  /** Раздел — строка таблицы. */
  section: string;
  sectionLabel: string;
  kind: PermissionKind;
  /** Подпись особого действия или уточнение столбца. */
  short?: string;
}

/** Должности, к которым можно привязать роль (backend auth/position-role.ts). */
export type PositionRole = 'SALES_MANAGER' | 'CLIENT_MANAGER';
export const POSITION_ROLES: PositionRole[] = ['SALES_MANAGER', 'CLIENT_MANAGER'];

export interface CustomRole {
  id: string;
  name: string;
  description?: string | null;
  permissions: string[];
  isActive: boolean;
  /** Должность, на всех сотрудников которой роль действует сама; null — ни на какую. */
  baseRole?: PositionRole | null;
  /** Сколько сотрудников работает по роли через должность. */
  positionUsers?: number;
  createdAt: string;
  updatedAt: string;
  _count?: { users: number };
}

export const listPermissionsCatalog = () =>
  api.get<PermissionDef[]>('/custom-roles/catalog').then((r) => r.data);

export const listCustomRoles = () =>
  api.get<CustomRole[]>('/custom-roles').then((r) => r.data);

export const createCustomRole = (data: { name: string; description?: string; permissions: string[]; baseRole?: PositionRole | null }) =>
  api.post<CustomRole>('/custom-roles', data).then((r) => r.data);

export const updateCustomRole = (id: string, data: { name?: string; description?: string; permissions?: string[]; isActive?: boolean; baseRole?: PositionRole | null }) =>
  api.patch<CustomRole>(`/custom-roles/${id}`, data).then((r) => r.data);

export const deleteCustomRole = (id: string) =>
  api.delete<{ ok: true }>(`/custom-roles/${id}`).then((r) => r.data);

export const setUserCustomRole = (userId: string, customRoleId: string | null) =>
  api.put(`/users/${userId}/custom-role`, { customRoleId }).then((r) => r.data);
