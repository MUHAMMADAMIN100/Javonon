import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

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
  | 'REVENUE_ITEM_DELETE';

@Injectable()
export class ActivityService {
  constructor(private prisma: PrismaService, private realtime: RealtimeGateway) {}

  async log(data: {
    actorId: string | null;
    actorName?: string;
    actorRole: string;
    action: ActivityAction;
    studentId?: string | null;
    studentName?: string | null;
    details: string;
    payload?: any;
  }) {
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
    this.realtime.emitStaff('activity:new', { entry });
    return entry;
  }

  async list(filters: {
    actorId?: string;
    studentId?: string;
    action?: ActivityAction;
    from?: Date;
    to?: Date;
    take?: number;
  } = {}) {
    const where: any = {};
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.studentId) where.studentId = filters.studentId;
    if (filters.action) where.action = filters.action;
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
