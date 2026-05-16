import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CallDirection, CallOutcome } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateCallDto {
  clientName: string;
  clientPhone?: string;
  studentId?: string | null;
  direction?: CallDirection;
  outcome?: CallOutcome;
  durationSeconds?: number;
  notes?: string;
  occurredAt?: string;
}

const VALID_DIRECTIONS: CallDirection[] = ['INCOMING', 'OUTGOING'];
const VALID_OUTCOMES: CallOutcome[] = [
  'ANSWERED', 'NO_ANSWER', 'BUSY', 'CALLBACK', 'CONVERTED',
];

@Injectable()
export class CallsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateCallDto) {
    const clientName = (dto.clientName || '').trim();
    if (!clientName) throw new BadRequestException('Укажи имя клиента');
    if (clientName.length > 120) throw new BadRequestException('Имя слишком длинное');

    if (dto.direction && !VALID_DIRECTIONS.includes(dto.direction)) {
      throw new BadRequestException('Неизвестное направление звонка');
    }
    if (dto.outcome && !VALID_OUTCOMES.includes(dto.outcome)) {
      throw new BadRequestException('Неизвестный результат звонка');
    }

    let duration = 0;
    if (dto.durationSeconds !== undefined && dto.durationSeconds !== null) {
      const d = Number(dto.durationSeconds);
      if (!Number.isFinite(d) || d < 0) {
        throw new BadRequestException('Длительность некорректна');
      }
      if (d > 24 * 3600) throw new BadRequestException('Длительность слишком большая');
      duration = Math.floor(d);
    }

    return this.prisma.callLog.create({
      data: {
        userId,
        clientName,
        clientPhone: dto.clientPhone?.trim() || null,
        studentId: dto.studentId || null,
        direction: dto.direction || 'OUTGOING',
        outcome: dto.outcome || 'ANSWERED',
        durationSeconds: duration,
        notes: dto.notes?.trim() || null,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      },
      include: {
        student: { select: { id: true, fullName: true } },
        user: { select: { id: true, fullName: true } },
      },
    });
  }

  /** Список звонков. mine=true → только свои; иначе (ADMIN) все. */
  async list(opts: {
    userId?: string;
    from?: Date;
    to?: Date;
    take?: number;
  }) {
    return this.prisma.callLog.findMany({
      where: {
        ...(opts.userId && { userId: opts.userId }),
        ...(opts.from || opts.to
          ? { occurredAt: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
          : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(opts.take || 100, 500),
      include: {
        student: { select: { id: true, fullName: true } },
        user: { select: { id: true, fullName: true } },
      },
    });
  }

  /**
   * Статистика звонков по сотрудникам за период: количество, минут
   * на линии, конверсий. Для KPI / эффективности команды.
   */
  async stats(opts: { from?: Date; to?: Date }) {
    const where = {
      ...(opts.from || opts.to
        ? { occurredAt: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
        : {}),
    };
    const grouped = await this.prisma.callLog.groupBy({
      by: ['userId'],
      where,
      _sum: { durationSeconds: true },
      _count: true,
    });
    const converted = await this.prisma.callLog.groupBy({
      by: ['userId'],
      where: { ...where, outcome: 'CONVERTED' },
      _count: true,
    });
    const convMap = new Map(converted.map((c) => [c.userId, c._count]));

    const userIds = grouped.map((g) => g.userId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, fullName: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return grouped
      .map((g) => ({
        user: userMap.get(g.userId) || { id: g.userId, fullName: '—' },
        totalCalls: g._count,
        totalSeconds: g._sum.durationSeconds || 0,
        conversions: convMap.get(g.userId) || 0,
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls);
  }

  async remove(id: string, userId: string, isAdmin: boolean) {
    const call = await this.prisma.callLog.findUnique({ where: { id } });
    if (!call) throw new NotFoundException('Звонок не найден');
    if (!isAdmin && call.userId !== userId) {
      throw new BadRequestException('Можно удалять только свои звонки');
    }
    return this.prisma.callLog.delete({ where: { id } });
  }
}
