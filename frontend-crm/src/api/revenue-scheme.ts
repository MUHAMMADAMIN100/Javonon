import { api } from './client';

/**
 * Схема распределения дохода (FOUNDER-editable) — API layer.
 *
 * Backend endpoints:
 *   GET    /admin/revenue-scheme                      → активная схема
 *   POST   /admin/revenue-scheme/buckets              → создать фонд
 *   PATCH  /admin/revenue-scheme/buckets/:id          → обновить фонд
 *   DELETE /admin/revenue-scheme/buckets/:id          → удалить фонд (cascade items)
 *   POST   /admin/revenue-scheme/buckets/:id/items    → создать статью
 *   PATCH  /admin/revenue-scheme/items/:id            → обновить статью
 *   DELETE /admin/revenue-scheme/items/:id            → удалить статью
 *   POST   /admin/revenue-scheme/reset                → пересобрать из дефолта
 *
 * Модель денег: `amountCents` — целое число копеек/дирам (сомони × 100),
 * чтобы избежать float-ошибок. UI отображает `amountCents / 100` в TJS
 * (см. Settings → Схема распределения).
 */

export type BucketKind = 'PERCENTAGE' | 'FIXED_SUM';

export interface RevenueBucketItemUser {
  id: string;
  fullName: string;
}

export interface RevenueBucketItem {
  id: string;
  name: string;
  /** null для PERCENTAGE-под-меток (просто ярлык); > 0 для FIXED_SUM статей. */
  amountCents: number | null;
  order: number;
  userId: string | null;
  user?: RevenueBucketItemUser | null;
}

export interface RevenueBucket {
  id: string;
  name: string;
  kind: BucketKind;
  color: string | null;
  /** 0..100 для PERCENTAGE; null для FIXED_SUM. */
  percent: number | null;
  order: number;
  items: RevenueBucketItem[];
}

export interface RevenueScheme {
  id: string;
  name: string;
  isActive: boolean;
  updatedAt: string;
  buckets: RevenueBucket[];
}

// === DTO shapes ===
export interface CreateBucketDto {
  kind: BucketKind;
  name: string;
  color?: string | null;
  percent?: number | null;
  order?: number;
}
export interface UpdateBucketDto {
  name?: string;
  color?: string | null;
  percent?: number | null;
  order?: number;
}
export interface CreateItemDto {
  name: string;
  amountCents?: number | null;
  order?: number;
  userId?: string | null;
}
export interface UpdateItemDto {
  name?: string;
  amountCents?: number | null;
  order?: number;
  userId?: string | null;
}

// === API functions ===
export const getRevenueScheme = () =>
  api.get<RevenueScheme>('/admin/revenue-scheme').then((r) => r.data);

export const createBucket = (dto: CreateBucketDto) =>
  api.post<RevenueBucket>('/admin/revenue-scheme/buckets', dto).then((r) => r.data);

export const updateBucket = (id: string, patch: UpdateBucketDto) =>
  api.patch<RevenueBucket>(`/admin/revenue-scheme/buckets/${id}`, patch).then((r) => r.data);

export const deleteBucket = (id: string) =>
  api.delete(`/admin/revenue-scheme/buckets/${id}`).then((r) => r.data);

export const createItem = (bucketId: string, dto: CreateItemDto) =>
  api
    .post<RevenueBucketItem>(`/admin/revenue-scheme/buckets/${bucketId}/items`, dto)
    .then((r) => r.data);

export const updateItem = (id: string, patch: UpdateItemDto) =>
  api.patch<RevenueBucketItem>(`/admin/revenue-scheme/items/${id}`, patch).then((r) => r.data);

export const deleteItem = (id: string) =>
  api.delete(`/admin/revenue-scheme/items/${id}`).then((r) => r.data);

export const resetRevenueScheme = () =>
  api.post<RevenueScheme>('/admin/revenue-scheme/reset').then((r) => r.data);
