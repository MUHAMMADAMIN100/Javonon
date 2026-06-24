import { api } from './client';
import type { Direction } from './types';

export interface Program {
  id: string;
  name: string;
  university: string;
  city: string;
  major: string;
  direction: Direction;
  cost: number;
  currency: string;
  duration: string | null;
  language: string | null;
  description: string | null;
  imageUrl: string | null;
  /** Ссылка на официальный сайт университета (ТЗ-доработка). */
  universityWebsiteUrl?: string | null;
  published: boolean;
  englishLevel?: string | null;
  hasGrant?: boolean;
  grantDetails?: string | null;
  grantEnglishLevel?: string | null;
  avgAdmissionScore?: string | null;
  applicationDeadline?: string | null;
  intakesPerYear?: number | null;
  createdAt: string;
}

export async function listPrograms(filters?: { city?: string; major?: string; direction?: Direction; search?: string }) {
  const { data } = await api.get<Program[]>('/programs', { params: filters });
  return data;
}

export async function getProgram(id: string) {
  const { data } = await api.get<Program>(`/programs/${id}`);
  return data;
}

export async function createProgram(payload: Partial<Program>, file?: File | null) {
  if (file) {
    const fd = new FormData();
    Object.entries(payload).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      fd.append(k, typeof v === 'boolean' ? String(v) : String(v));
    });
    fd.append('file', file);
    const { data } = await api.post<Program>('/programs', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  }
  const { data } = await api.post<Program>('/programs', payload);
  return data;
}

export async function updateProgram(id: string, payload: Partial<Program>) {
  const { data } = await api.patch<Program>(`/programs/${id}`, payload);
  return data;
}

export async function deleteProgram(id: string) {
  const { data } = await api.delete(`/programs/${id}`);
  return data;
}

export async function uploadProgramImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  const { data } = await api.post<Program>(`/programs/${id}/image`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

const apiRoot = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');

export function programImageUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('http')) return imageUrl;
  return `${apiRoot}${imageUrl}`;
}
