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

/**
 * Карточка заявки. Единственный ответ, который может нести
 * `partnerAttribution` (Application.partnerAttribution →
 * PartnerAttributionView): бэкенд добавляет его только для
 * FOUNDER/ADMIN/ACCOUNTANT, остальным ключа в JSON нет вовсе. Поэтому поле
 * опционально и рисуется по факту наличия.
 */
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

/**
 * Период для агрегатов: YYYY-MM-DD, границы включительно. Бэкенд поднимает
 * `to` до 23:59:59.999 Asia/Dushanbe (backend/src/common/query-date.ts),
 * поэтому слать ISO-момент, посчитанный в таймзоне браузера, не нужно и
 * вредно. Без параметров поведение прежнее — за всё время.
 */
export type StatsRange = { from?: string; to?: string };

export async function applicationStats(range?: StatsRange) {
  const { data } = await api.get('/applications/stats', { params: range });
  return data;
}

/* ============================================================
   Ручной ввод лида сотрудником — экран /leads.
   ============================================================ */

/**
 * Тело POST /applications/staff (backend CreateStaffApplicationDto).
 *
 * Набор полей — тот же, что собирает форма лендинга, МИНУС `ref`:
 * у лида, набранного руками, партнёра нет по определению, и реферальная
 * атрибуция на этом пути не запускается вообще. Поля в DTO нет — значит
 * её нельзя инициировать и «снизу», подсунув код в теле запроса.
 *
 * `source` намеренно НЕ отправляем: в ApplicationSource нет значения
 * «завёл сотрудник вручную», выдумывать новое — destructive-изменение
 * схемы. Бэкенд подставит STAFF_DEFAULT_SOURCE ('OTHER'); LANDING_FORM и
 * SELF_REGISTRATION он для этого маршрута отвергает, чтобы нельзя было
 * подделать машинно подтверждённое происхождение заявки.
 */
export interface CreateStaffApplicationInput {
  fullName: string;
  phone: string;
  whatsappPhone?: string;
  birthday?: string;
  country?: Country;
  comment?: string;
}

/**
 * Создать заявку («лид») из CRM. Публичный POST /applications/public — это
 * ДРУГОЙ эндпоинт (без гварда, со своим throttle 5/мин, с реферальной
 * атрибуцией, SMS клиенту и постом в Telegram); он этим экраном не
 * используется и не затрагивается.
 *
 * Права на бэке: applications:create (RolesGuard + canCreateApplication).
 */
export async function createStaffApplication(payload: CreateStaffApplicationInput) {
  const { data } = await api.post<Application>('/applications/staff', payload);
  return data;
}

/** Строка справочника GET /applications/managers. */
export interface AssignableManager {
  id: string;
  fullName: string;
  role: string;
}

/**
 * Активные SALES_MANAGER/CLIENT_MANAGER для инлайнового <select>
 * «Менеджер» в строке списка /leads.
 *
 * Отдельный эндпоинт, а не GET /users: тот закрыт @Roles(ADMIN, ACCOUNTANT)
 * и отдаёт кадровую карточку целиком. Права здесь — applications:assign,
 * ровно те же, что и у самого назначения.
 */
export async function listAssignableManagers() {
  const { data } = await api.get<AssignableManager[]>('/applications/managers');
  return data;
}
