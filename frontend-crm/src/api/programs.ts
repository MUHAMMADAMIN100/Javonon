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
  /** Дополнительные фото для галереи (ТЗ-доработка п.4). */
  imageUrls?: string[];
  /** Академические направления тегами (ТЗ-доработка п.6). */
  disciplines?: string[];
  /** Страна для группировки (ТЗ-доработка п.9). */
  country?: string | null;
  /** Ссылка на официальный сайт университета (ТЗ-доработка п.12). */
  universityWebsiteUrl?: string | null;
  /** Стипендии — приходят в findOne (ТЗ-доработка п.10). */
  scholarships?: ProgramScholarship[];
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

export async function uploadProgramGalleryImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  const { data } = await api.post<Program>(`/programs/${id}/gallery`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function removeProgramGalleryImage(id: string, url: string) {
  const { data } = await api.delete<Program>(`/programs/${id}/gallery`, { data: { url } });
  return data;
}

// === Стипендии (ТЗ-доработка п.10) ===

export interface ProgramScholarship {
  id: string;
  programId: string;
  name: string;
  coverage: string | null;
  amount: string | null;
  includes: string | null;
  requirements: string | null;
  deadline: string | null;
  link: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listProgramScholarships(programId: string) {
  const { data } = await api.get<ProgramScholarship[]>(`/programs/${programId}/scholarships`);
  return data;
}

export async function addProgramScholarship(programId: string, payload: Partial<ProgramScholarship>) {
  const { data } = await api.post<ProgramScholarship>(`/programs/${programId}/scholarships`, payload);
  return data;
}

export async function updateProgramScholarship(id: string, payload: Partial<ProgramScholarship>) {
  const { data } = await api.patch<ProgramScholarship>(`/programs/scholarships/${id}`, payload);
  return data;
}

export async function deleteProgramScholarship(id: string) {
  const { data } = await api.delete(`/programs/scholarships/${id}`);
  return data;
}

// === Документы программы (ТЗ-доработка п.7) ===

export interface ProgramDocument {
  id: string;
  programId: string;
  name: string;
  url: string;
  size: number | null;
  uploadedById: string | null;
  createdAt: string;
}

export async function listProgramDocuments(programId: string) {
  const { data } = await api.get<ProgramDocument[]>(`/programs/${programId}/documents`);
  return data;
}

export async function uploadProgramDocument(programId: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  const { data } = await api.post<ProgramDocument>(`/programs/${programId}/documents`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function deleteProgramDocument(id: string) {
  const { data } = await api.delete(`/programs/documents/${id}`);
  return data;
}

// === Комментарии программы (ТЗ-доработка п.7) ===

export interface ProgramComment {
  id: string;
  programId: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export async function listProgramComments(programId: string) {
  const { data } = await api.get<ProgramComment[]>(`/programs/${programId}/comments`);
  return data;
}

export async function addProgramComment(programId: string, text: string) {
  const { data } = await api.post<ProgramComment>(`/programs/${programId}/comments`, { text });
  return data;
}

export async function deleteProgramComment(id: string) {
  const { data } = await api.delete(`/programs/comments/${id}`);
  return data;
}

const apiRoot = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');

export function programImageUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('http')) return imageUrl;
  return `${apiRoot}${imageUrl}`;
}
