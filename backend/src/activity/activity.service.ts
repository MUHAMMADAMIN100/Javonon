import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuditEvent, RequestContext, StaffActor, currentStaffActor, staffActorOf } from '../common/request-context';

/** «3 000» / «2 500,5» — сумма в тексте журнала. */
function fmtSum(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, ' ');
}

const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(', ');

export type ActivityAction =
  | 'STATUS_CHANGE'
  | 'STUDENT_UPDATE'
  | 'STUDENT_CREATE'
  | 'STUDENT_DELETE'
  | 'MANAGER_CHANGE'
  | 'PROGRAM_CHANGE'
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_DELETE'
  // Finance audit trail: без этих action'ов POST/PATCH/DELETE
  // /finance/transactions не оставляли следа в /activity — FOUNDER не мог
  // ответить «кто создал/поменял/удалил транзакцию X, когда». См. audit HIGH
  // (finance.service.ts create/update/remove).
  | 'FINANCE_CREATE'
  | 'FINANCE_UPDATE'
  | 'FINANCE_DELETE'
  // Отдельный action для смены менеджера-получателя атрибуции у существующей
  // транзакции — управляет бонусами, поэтому логируется отдельно от общего
  // FINANCE_UPDATE, чтобы FOUNDER мог быстро найти именно эти изменения.
  | 'TRANSACTION_MANAGER_CHANGE'
  // approvePayment / changeStatus(CANCELLED) в SubmissionsService пишут
  // Transaction(INCOME/EXPENSE) внутри $transaction. Раньше эти строки
  // появлялись в БД без единой записи в ActivityLog — FOUNDER мог видеть
  // только сырой Transaction row с recordedById=reviewer и никак не мог
  // проследить, что INCOME был порождён approvePayment(paymentId=…) или
  // что EXPENSE — это авто-возврат по отменённой сделке.
  //   PAYMENT_APPROVED — approvePayment создал INCOME (TUITION_PAYMENT)
  //     по одобренному SubmissionPayment.
  //   PAYMENT_REFUND — changeStatus(CANCELLED) реверснул APPROVED-платёж:
  //     оригинальный INCOME помечен reversedAt + создан парный EXPENSE
  //     (OTHER_EXPENSE) как корректирующая запись.
  | 'PAYMENT_APPROVED'
  | 'PAYMENT_REFUND'
  // Revenue-scheme audit trail: до этих action'ов POST /admin/revenue-scheme/*
  // (включая reset, который сносит весь Фонд оплаты труда с именованными
  // зарплатами) не оставлял ни строки в ActivityLog. Если бы FOUNDER-токен
  // утёк или сам FOUNDER случайно нажал Reset — /activity показывал бы
  // пустоту, а восстанавливать пришлось бы из Postgres WAL. Схема
  // распределения дороже одной Transaction: она драйвит distribution() и
  // раскладку ФОТ, поэтому логируем каждую мутацию с before-payload для
  // UPDATE/DELETE/RESET, чтобы ревьюер видел, какое значение стояло до.
  | 'REVENUE_SCHEME_RESET'
  | 'REVENUE_BUCKET_CREATE'
  | 'REVENUE_BUCKET_UPDATE'
  | 'REVENUE_BUCKET_DELETE'
  | 'REVENUE_ITEM_CREATE'
  | 'REVENUE_ITEM_UPDATE'
  | 'REVENUE_ITEM_DELETE'
  // Партнёру НЕ начислена комиссия за клиента, которого он реально привёл:
  // истёк 90-дневный TTL атрибуции, партнёр оказался неактивен в момент
  // оплаты, либо сработал БД-гард дедупа. Раньше такой исход не оставлял
  // следа нигде — ни лога, ни строки аудита, — и на вопрос партнёра «почему
  // мне не заплатили» ответить было нечем. Начисление НЕ откладывается и НЕ
  // восстанавливается автоматически: строка фиксирует, что решение было
  // принято, кем/когда и по какому клиенту.
  | 'PARTNER_COMMISSION_SKIPPED'
  // Обращение к GET /submissions/partner-preview — «кто привёл вот этого
  // клиента» для формы создания сделки. Это ЕДИНСТВЕННОЕ место, где
  // партнёрские данные видит не-elevated роль (SALES_MANAGER/CLIENT_MANAGER),
  // поэтому каждое обращение обязано оставлять след: без него подбор по
  // списку известных номеров («этот клиент партнёрский? а этот?») не виден
  // в журнале вообще никак, и постфактум доказать/опровергнуть его нечем.
  //
  // Пишется на КАЖДЫЙ реальный lookup, включая отказ по скоупу (outcome
  // 'denied') и промах (outcome 'not-found'): именно серия отказов — самый
  // явный признак перебора, и терять её нельзя. Ответ клиенту при этом
  // одинаков во всех трёх исходах (null), так что журнал знает больше, чем
  // узнал вызывающий.
  | 'PARTNER_PREVIEW_LOOKUP'
  // Создание / удаление / восстановление записей (лиды, студенты, сделки,
  // платежи, партнёры, группы, курсы, звонки, задачи, программы, воронки,
  // уровни, сотрудники). Пишутся автоматически — см. prisma.service.ts.
  | 'RECORD_CREATE'
  | 'RECORD_DELETE'
  | 'RECORD_RESTORE'
  // «Войти как»: вход/выход основателя под сотрудником и каждое изменение,
  // сделанное в этом режиме.
  | 'IMPERSONATION'
  // Исправление явной ошибки в старом номере (+992992…, без «+») — QA №21.
  | 'PHONE_FIX';

/**
 * Action'ы, чьи details/payload содержат ПАРТНЁРСКИЕ данные (имя партнёра,
 * сумму комиссии, сам факт «клиент партнёрский»).
 *
 * GET /activity закрыт только JwtAuthGuard — любой аутентифицированный
 * сотрудник может дёрнуть его напрямую, минуя фронтовый гейт в Activity.tsx.
 * Партнёрский блок в карточках сделки/студента/заявки намеренно физически
 * отсутствует в ответе неэлевейтед-ролям (см. referrals.service
 * getPartnerAttributionView), и журнал активности не должен становиться
 * обходным путём к тем же данным. Поэтому такие строки отдаются и
 * транслируются по WS только FOUNDER/ADMIN/ACCOUNTANT.
 */
export const PARTNER_SENSITIVE_ACTIONS: ActivityAction[] = [
  'PARTNER_COMMISSION_SKIPPED',
  // Строка превью содержит referralCode найденного партнёра и сам факт
  // «клиент партнёрский» — то есть ровно то, что закрыто от менеджеров во
  // всех остальных местах. Открыть её в /activity значило бы вернуть им ту
  // же информацию про ЧУЖИХ клиентов, только через журнал.
  'PARTNER_PREVIEW_LOOKUP',
];

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private prisma: PrismaService, private realtime: RealtimeGateway) {}

  /**
   * Создания и удаления, накопленные за запрос (prisma.service.ts), — в
   * журнал. Вызывается после ответа и только для успешного запроса.
   */
  async flushRequestEvents(ctx: RequestContext) {
    const actor = staffActorOf(ctx.req);
    if (!actor || ctx.events.length === 0) return;
    for (const e of ctx.events) {
      try {
        const d = await this.describe(e);
        if (!d) continue;
        await this.log({
          actorId: actor.id,
          actorRole: actor.role,
          action: e.kind === 'create' ? 'RECORD_CREATE' : e.kind === 'restore' ? 'RECORD_RESTORE' : 'RECORD_DELETE',
          studentId: d.studentId ?? null,
          studentName: d.studentName ?? null,
          details: d.details,
          payload: { entity: e.model, id: e.row.id ?? null, kind: e.kind },
        }, actor);
      } catch (err) {
        this.logger.warn(`Журнал: ${e.model} ${e.kind} не записан: ${(err as Error).message}`);
      }
    }
  }

  /**
   * «Войти как»: каждое изменение, сделанное основателем под сотрудником, —
   * отдельной строкой (метод, адрес, итог). Чтение не пишем — это шум.
   */
  async logImpersonatedRequest(ctx: RequestContext, status: number) {
    const actor = staffActorOf(ctx.req);
    const method = String(ctx.req?.method || '').toUpperCase();
    if (!actor?.impersonatorId || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
    const path = String(ctx.req?.originalUrl || ctx.req?.url || '').split('?')[0];
    const outcome = status < 400 ? 'выполнено' : `отказ (${status})`;
    await this.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'IMPERSONATION',
      details: `${method} ${path} — ${outcome}`,
      payload: { method, path, status },
    }, actor);
  }

  /** Строка журнала для созданной/удалённой записи. */
  private async describe(e: AuditEvent): Promise<{ details: string; studentId?: string | null; studentName?: string | null } | null> {
    const r = e.row;
    const tail = e.kind === 'fire' ? ' (уволен)' : e.kind === 'restore' && e.model === 'User' ? ' (восстановлен)' : '';
    switch (e.model) {
      case 'Application':
        return { details: `Лид: ${join(r.fullName, r.phone)}`, studentId: r.studentId ?? null, studentName: r.fullName ?? null };
      case 'Student':
        return {
          details: `${r.academyOnly ? 'Ученик академии' : 'Студент'}: ${join(r.fullName, Array.isArray(r.phones) ? r.phones[0] : null)}`,
          studentId: e.kind === 'delete' ? null : r.id,
          studentName: r.fullName ?? null,
        };
      case 'SaleSubmission': {
        const client = await this.dealClient(r);
        return {
          details: `Сделка: ${client.name} · ${fmtSum(r.totalAmount)} ${r.currency || ''}`.trim(),
          studentId: client.studentId,
          studentName: client.name,
        };
      }
      case 'SubmissionPayment': {
        const deal = r.submissionId
          ? await this.prisma.saleSubmission.findUnique({
              where: { id: r.submissionId },
              select: { currency: true, newStudentName: true, studentId: true, student: { select: { fullName: true } } },
            })
          : null;
        const client = deal ? deal.student?.fullName || deal.newStudentName || '—' : '—';
        return {
          details: `Платёж ${fmtSum(r.amount)} ${deal?.currency || ''} по сделке: ${client}`.replace(/\s+/g, ' '),
          studentId: deal?.studentId ?? null,
          studentName: client,
        };
      }
      case 'Partner':
        return { details: `Партнёр: ${join(r.fullName, r.phone)}${e.kind === 'delete' && r.status === 'BANNED' ? ' (заблокирован: есть история начислений)' : ''}` };
      case 'StudyGroup':
        return { details: `Группа: ${r.name}` };
      case 'Course':
        return { details: `Курс: ${r.title}` };
      case 'Lesson':
        return { details: `Урок курса: ${r.title}` };
      case 'CallLog':
        return { details: `Звонок: ${join(r.clientName, r.clientPhone)}`, studentId: r.studentId ?? null, studentName: r.clientName ?? null };
      case 'Task':
        return { details: `Задача: ${r.title}` };
      case 'Program':
        return { details: `Программа: ${join(r.name, r.university)}` };
      case 'Pipeline':
        return { details: `Воронка: ${r.name}` };
      case 'PipelineStage':
        return { details: `Этап воронки: ${r.name}` };
      case 'AcademyLevel':
        return { details: `Уровень академии: ${r.name}` };
      case 'User':
        return { details: `Сотрудник: ${join(r.fullName, r.email)}${tail}` };
      default:
        return null;
    }
  }

  /** Клиент сделки: студент или «новый клиент» из самой сделки. */
  private async dealClient(r: Record<string, any>): Promise<{ name: string; studentId: string | null }> {
    if (r.newStudentName) return { name: r.newStudentName, studentId: r.studentId ?? null };
    if (r.studentId) {
      const st = await this.prisma.student.findUnique({ where: { id: r.studentId }, select: { fullName: true } });
      return { name: st?.fullName || '—', studentId: r.studentId };
    }
    return { name: '—', studentId: null };
  }

  async log(data: {
    actorId: string | null;
    actorName?: string;
    actorRole: string;
    action: ActivityAction;
    studentId?: string | null;
    studentName?: string | null;
    details: string;
    payload?: any;
  }, actorHint?: StaffActor | null) {
    // «Войти как»: действие сотрудника, которое на самом деле сделал
    // основатель. В журнал — основатель, с пометкой «от имени …».
    const actor = actorHint ?? currentStaffActor();
    if (actor?.impersonatorId && data.actorId === actor.id) {
      const target = await this.prisma.user.findUnique({ where: { id: actor.id }, select: { fullName: true } });
      data = {
        ...data,
        actorId: actor.impersonatorId,
        actorName: undefined,
        actorRole: 'FOUNDER',
        details: `${data.details} — от имени: ${target?.fullName || 'сотрудник'}`,
        payload: { ...(data.payload && typeof data.payload === 'object' ? data.payload : {}), onBehalfOf: actor.id },
      };
    }
    let actorName = data.actorName || '';
    if (!actorName && data.actorId) {
      const u = await this.prisma.user.findUnique({
        where: { id: data.actorId },
        select: { fullName: true },
      });
      actorName = u?.fullName || 'Неизвестный';
    }
    const entry = await this.prisma.activityLog.create({
      data: {
        actorId: data.actorId,
        actorName: actorName || 'Неизвестный',
        actorRole: data.actorRole,
        action: data.action,
        studentId: data.studentId || null,
        studentName: data.studentName || null,
        details: data.details,
        payload: data.payload ?? undefined,
      },
    });
    // Партнёрские строки уходят только в finance-staff (FOUNDER/ADMIN/
    // ACCOUNTANT). emitStaff вещает в комнату 'staff', куда входят и
    // SALES_MANAGER/CLIENT_MANAGER — через `socket.on('activity:new')` они
    // прочитали бы имя партнёра и сумму, которых им не отдаёт ни один REST-
    // эндпоинт. См. PARTNER_SENSITIVE_ACTIONS.
    if (PARTNER_SENSITIVE_ACTIONS.includes(data.action)) {
      this.realtime.emitFinanceStaff('activity:new', { entry });
    } else {
      // Журнал — только основателю (комната founders).
    this.realtime.server?.to('founders').emit('activity:new', { entry });
    }
    return entry;
  }

  async list(filters: {
    actorId?: string;
    studentId?: string;
    action?: ActivityAction;
    from?: Date;
    to?: Date;
    take?: number;
    /**
     * Результат canSeePartnerAttribution() для читателя. false/undefined ⇒
     * из выдачи вырезаются PARTNER_SENSITIVE_ACTIONS. Дефолт намеренно
     * fail-closed: новый вызывающий, забывший передать флаг, получит
     * УРЕЗАННУЮ выдачу, а не утечку партнёрских данных.
     */
    viewerCanSeePartnerData?: boolean;
  } = {}) {
    const where: any = {};
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.studentId) where.studentId = filters.studentId;
    if (filters.action) where.action = filters.action;

    if (!filters.viewerCanSeePartnerData) {
      if (filters.action && PARTNER_SENSITIVE_ACTIONS.includes(filters.action)) {
        // Прямой запрос партнёрского журнала неэлевейтед-ролью — пустой ответ.
        return [];
      }
      // Точечный фильтр по неопасному action уже сам исключает партнёрские
      // строки, поэтому notIn нужен только для «все действия».
      if (!filters.action) where.action = { notIn: PARTNER_SENSITIVE_ACTIONS };
    }
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = filters.from;
      if (filters.to) where.createdAt.lte = filters.to;
    }
    return this.prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filters.take ?? 200,
    });
  }
}
