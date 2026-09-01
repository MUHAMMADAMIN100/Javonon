import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Лента посещаемости всех сотрудников (ТЗ §3).
 * Показывает все TimeEntry: когда пришёл, когда ушёл на обед, вернулся
 * с обеда, закончил рабочий день, опоздание. (Переработка убрана из системы.)
 */
@Injectable()
export class AttendanceService {
  constructor(private prisma: PrismaService) {}

  async list(opts: { userId?: string; from?: Date; to?: Date; take?: number } = {}) {
    const where: any = {};
    if (opts.userId) where.userId = opts.userId;
    if (opts.from || opts.to) {
      where.clockIn = {};
      if (opts.from) where.clockIn.gte = opts.from;
      if (opts.to) where.clockIn.lte = opts.to;
    }
    return this.prisma.timeEntry.findMany({
      where,
      include: {
        user: { select: { id: true, fullName: true, role: true, email: true } },
      },
      orderBy: { clockIn: 'desc' },
      take: Math.min(opts.take || 100, 500),
    });
  }
}
