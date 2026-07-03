import { api } from './client';
import type { Task, TaskStatus } from './types';

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
