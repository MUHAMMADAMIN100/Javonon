import { api } from './client';

export interface Course {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  published: boolean;
  authorId: string | null;
  author?: { id: string; fullName: string };
  createdAt: string;
  _count?: { lessons: number; enrollments: number };
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  content: string | null;
  videoUrl: string | null;
  attachmentUrl: string | null;
  order: number;
  createdAt: string;
}

export interface CourseDetail extends Course {
  lessons: Lesson[];
}

export const listCourses = () => api.get<Course[]>('/lms/courses').then((r) => r.data);
export const getCourseAdmin = (id: string) =>
  api.get<CourseDetail>(`/lms/courses/${id}`).then((r) => r.data);
export const createCourse = (data: { title: string; description?: string; coverUrl?: string }) =>
  api.post<Course>('/lms/courses', data).then((r) => r.data);
export const updateCourse = (id: string, data: Partial<{ title: string; description: string; coverUrl: string; published: boolean }>) =>
  api.patch<Course>(`/lms/courses/${id}`, data).then((r) => r.data);
export const deleteCourse = (id: string) =>
  api.delete(`/lms/courses/${id}`).then((r) => r.data);
export const addLesson = (courseId: string, data: { title: string; content?: string; videoUrl?: string; attachmentUrl?: string; order?: number }) =>
  api.post<Lesson>(`/lms/courses/${courseId}/lessons`, data).then((r) => r.data);
export const updateLesson = (id: string, data: Partial<Lesson>) =>
  api.patch<Lesson>(`/lms/lessons/${id}`, data).then((r) => r.data);
export const deleteLesson = (id: string) =>
  api.delete(`/lms/lessons/${id}`).then((r) => r.data);
export const enrollStudent = (courseId: string, studentId: string) =>
  api.post(`/lms/courses/${courseId}/enroll`, { studentId }).then((r) => r.data);
