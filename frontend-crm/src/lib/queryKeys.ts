/**
 * Централизованные queryKey-фабрики, чтобы invalidate не разъезжался по проекту.
 * Используй keys.tasks.list({mine,search}) вместо ['tasks', mine, search].
 */
export const keys = {
  tasks: {
    all: ['tasks'] as const,
    list: (p: { mine?: boolean; search?: string } = {}) => ['tasks', 'list', p] as const,
    one: (id: string) => ['tasks', 'one', id] as const,
    stats: () => ['tasks', 'stats'] as const,
  },
  students: {
    all: ['students'] as const,
    list: (p: Record<string, unknown> = {}) => ['students', 'list', p] as const,
    one: (id: string) => ['students', 'one', id] as const,
    payments: (id: string) => ['students', 'payments', id] as const,
    stats: () => ['students', 'stats'] as const,
  },
  applications: {
    all: ['applications'] as const,
    list: (p: Record<string, unknown> = {}) => ['applications', 'list', p] as const,
    one: (id: string) => ['applications', 'one', id] as const,
  },
  users: {
    all: ['users'] as const,
    list: () => ['users', 'list'] as const,
    one: (id: string) => ['users', 'one', id] as const,
  },
  payments: {
    all: ['payments'] as const,
    list: (p: { status?: string } = {}) => ['payments', 'list', p] as const,
  },
  finance: {
    all: ['finance'] as const,
    transactions: (p: Record<string, unknown> = {}) => ['finance', 'transactions', p] as const,
    summary: (p: Record<string, unknown> = {}) => ['finance', 'summary', p] as const,
    byCategory: (p: Record<string, unknown> = {}) => ['finance', 'byCategory', p] as const,
    timeseries: (p: Record<string, unknown> = {}) => ['finance', 'timeseries', p] as const,
    pending: () => ['finance', 'pending'] as const,
  },
  salary: {
    all: ['salary'] as const,
    list: (p: Record<string, unknown> = {}) => ['salary', 'list', p] as const,
    preview: (p: Record<string, unknown>) => ['salary', 'preview', p] as const,
  },
  penalties: {
    all: ['penalties'] as const,
    list: (p: Record<string, unknown> = {}) => ['penalties', 'list', p] as const,
  },
  chat: {
    all: ['chat'] as const,
    rooms: () => ['chat', 'rooms'] as const,
    room: (id: string) => ['chat', 'room', id] as const,
    unread: () => ['chat', 'unread'] as const,
  },
  lms: {
    all: ['lms'] as const,
    courses: () => ['lms', 'courses'] as const,
    course: (id: string) => ['lms', 'course', id] as const,
  },
  interactions: {
    all: ['interactions'] as const,
    list: (studentId: string) => ['interactions', 'list', studentId] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: () => ['notifications', 'list'] as const,
    unread: () => ['notifications', 'unread'] as const,
  },
  programs: {
    all: ['programs'] as const,
    list: () => ['programs', 'list'] as const,
    public: () => ['programs', 'public'] as const,
    one: (id: string) => ['programs', 'one', id] as const,
  },
  time: {
    all: ['time'] as const,
    today: () => ['time', 'today'] as const,
    history: (p: Record<string, unknown> = {}) => ['time', 'history', p] as const,
    team: () => ['time', 'team'] as const,
  },
  reports: {
    all: ['reports'] as const,
    today: () => ['reports', 'today'] as const,
    mine: (p: Record<string, unknown> = {}) => ['reports', 'mine', p] as const,
    admin: (p: Record<string, unknown> = {}) => ['reports', 'admin', p] as const,
  },
  calls: {
    all: ['calls'] as const,
    list: (p: Record<string, unknown> = {}) => ['calls', 'list', p] as const,
    stats: (p: Record<string, unknown> = {}) => ['calls', 'stats', p] as const,
  },
} as const;
