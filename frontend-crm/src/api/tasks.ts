import { api } from './client';
import type { Task, TaskStatus } from './types';

/* ===== Дневник задачи (как дневник ДЗ): что исполнители сделали по рабочим дням ===== */

/** off — нерабочий для дневника день (в таблице только из-за чьей-то записи). */
export type TaskDiaryCellState = 'written' | 'open' | 'missed' | 'future' | 'done' | 'off';
/** Почему нельзя писать сегодня (backend tasks/task-diary.ts WriteBlock). */
export type TaskDiaryBlock = 'no-deadline' | 'done' | 'not-started' | 'after-deadline' | 'day-off' | 'day-closed';
export type TaskDiaryWeekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

export interface TaskDiaryCell {
  state: TaskDiaryCellState;
  text?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskDiary {
  enabled: true;
  /** Первый и последний день дневника, 'YYYY-MM-DD'. */
  from: string;
  lastDay: string | null;
  today: string;
  days: Array<{ day: string; weekday: TaskDiaryWeekday }>;
  rows: Array<{
    user: { id: string; fullName: string; isActive: boolean };
    cells: Record<string, TaskDiaryCell>;
  }>;
  me: {
    isAssignee: boolean;
    canWrite: boolean;
    /** Конец рабочего дня по графику — до него пишется запись за сегодня. */
    closesAt: string | null;
    block: TaskDiaryBlock | null;
    todayText: string | null;
  };
}

/** Дневник задачи; у задачи без дедлайна — { enabled: false }. */
export async function getTaskDiary(id: string) {
  const { data } = await api.get<TaskDiary | { enabled: false }>(`/tasks/${id}/diary`);
  return data;
}

/** Моя запись за сегодня (повторная — правка до конца рабочего дня). */
export async function writeTaskDiary(id: string, text: string) {
  const { data } = await api.put<{ day: string; text: string; closesAt: string }>(`/tasks/${id}/diary`, { text });
  return data;
}

export async function listTasks(mine = false, search?: string) {
  const { data } = await api.get<Task[]>('/tasks', {
    params: {
      mine: mine ? 'true' : undefined,
      search: search ? search : undefined,
    },
  });
  return data;
}

export async function getTask(id: string) {
  const { data } = await api.get<Task>(`/tasks/${id}`);
  return data;
}

export async function createTask(payload: {
  title: string;
  description: string;
  /** Мультиназначение — минимум один исполнитель. */
  assigneeIds: string[];
  /** Опциональный контролёр (проверяющий задачу). */
  controllerId?: string | null;
  deadline?: string;
}) {
  const { data } = await api.post<Task>('/tasks', payload);
  return data;
}

export async function updateTask(
  id: string,
  payload: Partial<{
    title: string;
    description: string;
    status: TaskStatus;
    assigneeIds: string[];
    controllerId: string | null;
    deadline: string | null;
  }>,
) {
  const { data } = await api.patch<Task>(`/tasks/${id}`, payload);
  return data;
}

export async function deleteTask(id: string) {
  const { data } = await api.delete(`/tasks/${id}`);
  return data;
}
