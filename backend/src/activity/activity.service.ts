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
  | 'DOCUMENT_DELETE';

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
