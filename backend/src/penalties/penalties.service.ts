import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PenaltyReason } from '@prisma/client';

const RATE_PER_LATE_MINUTE = 0.5; // $0.50 за минуту опоздания
const LATE_THRESHOLD_MIN = 15;    // штраф начисляется при опоздании > 15 мин

@Injectable()
export class PenaltiesService {
  constructor(private prisma: PrismaService) {}

  async list(filters: { userId?: string; from?: Date; to?: Date; applied?: boolean }) {
    return this.prisma.penalty.findMany({
      where: {
        ...(filters.userId && { userId: filters.userId }),
        ...(filters.applied !== undefined && { applied: filters.applied }),
        ...(filters.from || filters.to
          ? { date: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }
          : {}),
      },
      orderBy: { date: 'desc' },
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
  }

  async createManual(userId: string, dto: { reason: PenaltyReason; amount: number; details: string; date?: string }) {
    if (!dto.amount || dto.amount <= 0) throw new BadRequestException('Сумма должна быть > 0');
    return this.prisma.penalty.create({
      data: {
        userId,
        reason: dto.reason || 'CUSTOM',
        amount: dto.amount,
        details: dto.details.trim(),
        date: dto.date ? new Date(dto.date) : new Date(),
      },
    });
  }

  async remove(id: string) {
    return this.prisma.penalty.delete({ where: { id } });
  }

  /**
   * Cron-задача: для каждого TimeEntry за указанную дату
   * с lateMinutes > 15 — создаём Penalty (LATE_ARRIVAL).
   * Идемпотентно: если штраф за эту дату по этому юзеру уже есть — пропускаем.
   */
  async generateLatePenaltiesForDate(targetDate: Date) {
    const from = new Date(targetDate);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        clockIn: { gte: from, lt: to },
        lateMinutes: { gt: LATE_THRESHOLD_MIN },
      },
      include: { user: { select: { id: true, fullName: true } } },
    });

    let created = 0;
    for (const e of entries) {
      // Проверка идемпотентности: уже есть штраф за этот день?
      const existing = await this.prisma.penalty.findFirst({
        where: {
          userId: e.userId,
          reason: 'LATE_ARRIVAL',
          date: from,
        },
      });
      if (existing) continue;

      await this.prisma.penalty.create({
        data: {
          userId: e.userId,
          reason: 'LATE_ARRIVAL',
          amount: Math.round(e.lateMinutes * RATE_PER_LATE_MINUTE * 100) / 100,
          details: `Опоздание ${e.lateMinutes} мин × $${RATE_PER_LATE_MINUTE}/мин`,
          date: from,
        },
      });
      created++;
    }
    return { created, scanned: entries.length };
  }

  /** Сумма неучтённых штрафов за период (для зарплатного расчёта). */
  async pendingTotalForUser(userId: string, from: Date, to: Date) {
    const agg = await this.prisma.penalty.aggregate({
      where: {
        userId,
        applied: false,
        date: { gte: from, lte: to },
      },
      _sum: { amount: true },
    });
    return agg._sum.amount || 0;
  }

  /** Помечает штрафы как учтённые (после создания SalaryRecord). */
  async markApplied(userId: string, from: Date, to: Date) {
    return this.prisma.penalty.updateMany({
      where: {
        userId,
        applied: false,
        date: { gte: from, lte: to },
      },
      data: { applied: true },
    });
  }
}
