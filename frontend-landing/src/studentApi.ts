import axios from 'axios';
import { connectStudentRealtime, disconnectStudentRealtime } from './realtime';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';
export const API_BASE = API_URL.replace(/\/api$/, '');

const TOKEN_KEY = 'javonon_student_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => {
  localStorage.setItem(TOKEN_KEY, t);
  connectStudentRealtime(t);
};
export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  disconnectStudentRealtime();
};

const client = axios.create({ baseURL: API_URL });
client.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

export type StudentDoc = {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  type: string;
  createdAt: string;
};

export type StudentMe = {
  id: string;
  fullName: string;
  email: string | null;
  phones: string[];
  direction: 'BACHELOR' | 'MASTER' | 'LANGUAGE';
  cabinet: number;
  status: 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'ARCHIVED';
  comment: string | null;
  photoUrl: string | null;
  documents: StudentDoc[];
  manager: { id: string; fullName: string; email: string } | null;
  chinaManager: { id: string; fullName: string; email: string } | null;
  applications?: { id: string; status: string; createdAt: string }[];
  createdAt: string;
};

export async function studentRegister(payload: {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  direction?: string;
  comment?: string;
}) {
  const { data } = await client.post<{ token: string; student: { id: string; email: string; fullName: string } }>(
    '/student-auth/register',
    payload,
  );
  setToken(data.token);
  return data;
}

export type StudentTransaction = {
  id: string;
  amount: number;
  currency: string;
  category: string;
  date: string;
  comment: string | null;
};

export async function listStudentTransactions(): Promise<StudentTransaction[]> {
  const { data } = await client.get<StudentTransaction[]>('/student-auth/transactions');
  return data;
}

export type StudentCourse = {
  enrollmentId: string;
  course: { id: string; title: string; coverUrl: string | null; description: string | null };
  totalLessons: number;
  completedLessons: number;
  progress: number;
  enrolledAt: string;
  completedAt: string | null;
};

export async function listStudentCourses(): Promise<StudentCourse[]> {
  const { data } = await client.get<StudentCourse[]>('/student-lms/my-courses');
  return data;
}

export async function listAvailableCourses(): Promise<any[]> {
  const { data } = await client.get<any[]>('/student-lms/available');
  return data;
}

export async function getStudentCourse(id: string): Promise<any> {
  const { data } = await client.get<any>(`/student-lms/courses/${id}`);
  return data;
}

export async function enrollInCourse(id: string): Promise<any> {
  const { data } = await client.post<any>(`/student-lms/courses/${id}/enroll`);
  return data;
}

export async function completeLesson(id: string): Promise<any> {
  const { data } = await client.post<any>(`/student-lms/lessons/${id}/complete`);
  return data;
}

export async function studentLogin(email: string, password: string) {
  const { data } = await client.post<{ token: string; student: { id: string; email: string; fullName: string } }>(
    '/student-auth/login',
    { email, password },
  );
  setToken(data.token);
  return data;
}

export async function studentMe() {
  const { data } = await client.get<StudentMe>('/student-auth/me');
  return data;
}

export async function studentUploadDocument(file: File, type: string) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('type', type);
  const { data } = await client.post<StudentDoc>('/student-auth/documents', fd);
  return data;
}

export async function studentDeleteDocument(id: string) {
  const { data } = await client.delete(`/student-auth/documents/${id}`);
  return data;
}

export type ApplicationFormData = any;

export async function getStudentForm() {
  const { data } = await client.get<{ form: ApplicationFormData | null }>('/student-auth/form');
  return data.form;
}

export async function saveStudentForm(form: ApplicationFormData) {
  const { data } = await client.patch<{ form: ApplicationFormData }>('/student-auth/form', form);
  return data.form;
}

export interface StudentProgram {
  id: string;
  name: string;
  university: string;
  city: string;
  major: string;
  direction: 'BACHELOR' | 'MASTER' | 'LANGUAGE';
  cost: number;
  currency: string;
  duration: string | null;
  language: string | null;
  description: string | null;
  imageUrl: string | null;
  published: boolean;
  createdAt: string;
}

export async function listStudentPrograms(filters: {
  city?: string;
  major?: string;
  direction?: string;
  minCost?: number;
  maxCost?: number;
  search?: string;
} = {}) {
  const { data } = await client.get<StudentProgram[]>('/student-auth/programs', { params: filters });
  return data;
}

export async function getStudentProgramFilters() {
  const { data } = await client.get<{ cities: string[]; majors: string[] }>('/student-auth/programs/filters');
  return data;
}
