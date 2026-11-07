import { AsyncLocalStorage } from 'async_hooks';

/**
 * Контекст HTTP-запроса — кто его делает. Нужен там, где пользователя нельзя
 * протащить параметром: журнал действий пишет создания и удаления прямо из
 * слоя базы (prisma.service.ts), а «Войти как» помечает действия основателя.
 *
 * `req` хранится целиком: req.user появляется позже (его ставит JwtAuthGuard
 * уже после того, как контекст открыт), поэтому читаем его в момент записи.
 */
export interface AuditEvent {
  kind: 'create' | 'delete' | 'restore' | 'fire';
  model: string;
  row: Record<string, any>;
}

export interface RequestContext {
  req: any;
  /** Создания/удаления за запрос — уходят в журнал, только если запрос успешен. */
  events: AuditEvent[];
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Сотрудник, от чьего имени идёт запрос (не студент, не партнёр, не сайт). */
export interface StaffActor {
  id: string;
  role: string;
  /** Основатель, вошедший «как этот сотрудник» (см. auth/impersonation). */
  impersonatorId: string | null;
}

export function staffActorOf(req: any): StaffActor | null {
  const u = req?.user;
  // У токена сотрудника всегда есть sid (сессия) — так его не спутать со
  // студентом и партнёром, у которых свои токены.
  if (!u || !u.id || !u.sid || u.role === 'STUDENT') return null;
  return { id: u.id, role: String(u.role || ''), impersonatorId: u.impersonatorId ?? null };
}

export function currentStaffActor(): StaffActor | null {
  return staffActorOf(requestContext.getStore()?.req);
}

/**
 * Записи, создание и удаление которых видно в «Журнале активности». Пишет
 * их prisma.service.ts сам — на каждый create/delete этих моделей в запросе
 * сотрудника. Заявки с сайта, кабинеты студента/партнёра и фоновые задачи
 * сюда не попадают: у них нет сотрудника.
 */
export const AUDITED_MODELS = new Set([
  'Application', 'Student', 'SaleSubmission', 'SubmissionPayment', 'Partner',
  'StudyGroup', 'Course', 'Lesson', 'CallLog', 'Task', 'Program',
  'Pipeline', 'PipelineStage', 'AcademyLevel', 'User',
]);

/** Явно положить событие в журнал запроса (мягкое удаление «по-своему»). */
export function queueAuditEvent(kind: AuditEvent['kind'], model: string, row: Record<string, any>) {
  const ctx = requestContext.getStore();
  if (ctx && staffActorOf(ctx.req)) ctx.events.push({ kind, model, row });
}
