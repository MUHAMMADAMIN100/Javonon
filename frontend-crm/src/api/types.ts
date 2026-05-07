export type Role = 'ADMIN' | 'EMPLOYEE' | 'ACCOUNTANT';
export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Администратор',
  EMPLOYEE: 'Сотрудник',
  ACCOUNTANT: 'Бухгалтер',
};
export type Direction =
  | 'BACHELOR'
  | 'MASTER'
  | 'LANGUAGE'
  | 'LANGUAGE_COLLEGE'
  | 'LANGUAGE_BACHELOR'
  | 'COLLEGE';
export type ApplicationStatus =
  | 'NEW'
  | 'DOCS_REVIEW'
  | 'DOCS_SUBMITTED'
  | 'PRE_ADMISSION'
  | 'AWAITING_PAYMENT'
  | 'ENROLLED'
  // legacy (migrated automatically)
  | 'IN_PROGRESS'
  | 'COMPLETED';

export const APPLICATION_STAGES: ApplicationStatus[] = [
  'NEW',
  'DOCS_REVIEW',
  'DOCS_SUBMITTED',
  'PRE_ADMISSION',
  'AWAITING_PAYMENT',
  'ENROLLED',
];

export const STAGE_INDEX: Record<ApplicationStatus, number> = {
  NEW: 0,
  DOCS_REVIEW: 1,
  IN_PROGRESS: 1, // legacy
  DOCS_SUBMITTED: 2,
  PRE_ADMISSION: 3,
  AWAITING_PAYMENT: 4,
  ENROLLED: 5,
  COMPLETED: 5, // legacy
};
export type StudentStatus = 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'ARCHIVED';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  createdAt?: string;
}

export interface ManagerInfo {
  id: string;
  fullName: string;
  email: string;
}

export interface Application {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  direction: Direction;
  comment: string | null;
  status: ApplicationStatus;
  studentId: string | null;
  student?: Student | null;
  managerId: string | null;
  manager?: ManagerInfo | null;
  chinaManagerId: string | null;
  chinaManager?: ManagerInfo | null;
  createdAt: string;
}

export interface Document {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  type: string;
  createdAt: string;
}

export interface Student {
  id: string;
  fullName: string;
  phones: string[];
  email: string | null;
  photoUrl: string | null;
  direction: Direction;
  cabinet: number;
  status: StudentStatus;
  comment: string | null;
  managerId: string | null;
  manager?: ManagerInfo | null;
  chinaManagerId: string | null;
  chinaManager?: ManagerInfo | null;
  applicationForm?: any;
  documents?: Document[];
  applications?: Application[];
  createdAt: string;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  payload: any;
  read: boolean;
  createdAt: string;
}

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedToId: string;
  assignedTo?: { id: string; fullName: string; email: string };
  createdById: string | null;
  createdBy?: { id: string; fullName: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'К выполнению',
  IN_PROGRESS: 'В работе',
  DONE: 'Выполнено',
};

export const TASK_STATUS_BADGE: Record<TaskStatus, string> = {
  TODO: 'badge-info',
  IN_PROGRESS: 'badge-warning',
  DONE: 'badge-success',
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  BACHELOR: 'Бакалавриат',
  MASTER: 'Магистратура',
  LANGUAGE: 'Языковые курсы',
  LANGUAGE_COLLEGE: 'Языковой + колледж',
  LANGUAGE_BACHELOR: 'Языковой + бакалавриат',
  COLLEGE: 'Колледж',
};

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  NEW: 'Новая заявка',
  DOCS_REVIEW: 'Документы на проверке',
  DOCS_SUBMITTED: 'Подача документов',
  PRE_ADMISSION: 'Предварительное зачисление',
  AWAITING_PAYMENT: 'Ожидание оплаты',
  ENROLLED: 'Зачислен',
  IN_PROGRESS: 'Документы на проверке',
  COMPLETED: 'Зачислен',
};

export const STATUS_SHORT: Record<ApplicationStatus, string> = {
  NEW: 'Новая',
  DOCS_REVIEW: 'Проверка',
  DOCS_SUBMITTED: 'Подача',
  PRE_ADMISSION: 'Предв. зачисление',
  AWAITING_PAYMENT: 'Оплата',
  ENROLLED: 'Зачислен',
  IN_PROGRESS: 'Проверка',
  COMPLETED: 'Зачислен',
};

export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  ACTIVE: 'Активный',
  PAUSED: 'Приостановлен',
  GRADUATED: 'Выпустился',
  ARCHIVED: 'В архиве',
};

export const STATUS_BADGE: Record<ApplicationStatus, string> = {
  NEW: 'badge-info',
  DOCS_REVIEW: 'badge-warning',
  DOCS_SUBMITTED: 'badge-warning',
  PRE_ADMISSION: 'badge-info',
  AWAITING_PAYMENT: 'badge-warning',
  ENROLLED: 'badge-success',
  IN_PROGRESS: 'badge-warning',
  COMPLETED: 'badge-success',
};

export const STUDENT_STATUS_BADGE: Record<StudentStatus, string> = {
  ACTIVE: 'badge-success',
  PAUSED: 'badge-warning',
  GRADUATED: 'badge-info',
  ARCHIVED: 'badge-gray',
};
