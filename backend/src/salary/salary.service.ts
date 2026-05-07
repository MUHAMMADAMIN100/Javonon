import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeTrackingService } from '../time-tracking/time-tracking.service';

const PENALTY_PER_LATE_MINUTE = 0.5; // $0.50 за каждую минуту опоздания

@Injectable()
export class SalaryService {
  constructor(
    private prisma: PrismaService,
    private timeSvc: TimeTrackingService,
  ) {}

  async list(filters: { userId?: string; from?: Date; to?: Date }) {
    return this.prisma.salaryRecord.findMany({
      where: {
        ...(filters.userId && { userId: filters.userId }),
        ...(filters.from && { periodStart: { gte: filters.from } }),
        ...(filters.to && { periodEnd: { lte: filters.to } }),
      },
      orderBy: { periodStart: 'desc' },
      include: { user: { select: { id: true, fullName: true, role: true, email: true } } },
    });
  }

  /**
   * Считает (без сохранения) зарплату сотрудника за период:
   *   - hours/minutes — берём из TimeEntry
   *   - sales — сумма транзакций INCOME, у которых managerId = этот сотрудник, в периоде
   *   - bonus = sales × bonusPercent
   *   - penalty = lateMinutes × PENALTY_PER_LATE_MINUTE
   *   - net = base + bonus + kpi - penalty
   */
  async preview(userId: string, periodStart: Date, periodEnd: Date, kpiBonus = 0) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Сотрудник не найден');

    const time = await this.timeSvc.summaryForUser(userId, periodStart, periodEnd);

    const salesAgg = await this.prisma.transaction.aggregate({
      where: {
        managerId: userId,
        type: 'INCOME',
        date: { gte: periodStart, lte: periodEnd },
      },
      _sum: { amount: true },
    });
    const salesAmount = salesAgg._sum.amount || 0;
    const bonusPercent = user.bonusPercent || 0;
    const bonusAmount = (salesAmount * bonusPercent) / 100;

    const baseSalary = user.baseSalary || 0;
    const hourlyRate = user.hourlyRate || 0;
    // Итоговая базовая ставка: либо фикс., либо почасовая.
    const hours = time.workedMinutes / 60;
    const baseAmount = baseSalary > 0 ? baseSalary : hourlyRate * hours;
    const penalties = time.lateMinutes * PENALTY_PER_LATE_MINUTE;

    const net = baseAmount + bonusAmount + kpiBonus - penalties;

    return {
      userId,
      user: { id: user.id, fullName: user.fullName, role: user.role, email: user.email },
      periodStart,
      periodEnd,
      workedMinutes: time.workedMinutes,
      lateMinutes: time.lateMinutes,
      baseAmount: round(baseAmount),
      salesAmount: round(salesAmount),
      bonusAmount: round(bonusAmount),
      bonusPercent,
      kpiBonus: round(kpiBonus),
      penalties: round(penalties),
      netAmount: round(net),
      currency: 'USD',
    };
  }

  async create(dto: {
    userId: string;
    periodStart: string;
    periodEnd: string;
    kpiBonus?: number;
    comment?: string;
  }) {
    const start = new Date(dto.periodStart);
    const end = new Date(dto.periodEnd);
    if (end < start) throw new BadRequestException('Конец периода раньше начала');

    const preview = await this.preview(dto.userId, start, end, dto.kpiBonus || 0);

    return this.prisma.salaryRecord.create({
      data: {
        userId: dto.userId,
        periodStart: start,
        periodEnd: end,
        workedMinutes: preview.workedMinutes,
        lateMinutes: preview.lateMinutes,
        baseAmount: preview.baseAmount,
        salesAmount: preview.salesAmount,
        bonusAmount: preview.bonusAmount,
        kpiBonus: preview.kpiBonus,
        penalties: preview.penalties,
        netAmount: preview.netAmount,
        currency: preview.currency,
        comment: dto.comment?.trim() || null,
      },
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
  }

  async markPaid(id: string) {
    const rec = await this.prisma.salaryRecord.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Запись не найдена');
    // При выплате создаём расходную транзакцию.
    await this.prisma.transaction.create({
      data: {
        type: 'EXPENSE',
        category: 'SALARY',
        amount: rec.netAmount,
        currency: rec.currency,
        managerId: rec.userId,
        comment: `Зарплата за период ${rec.periodStart.toISOString().slice(0, 10)} — ${rec.periodEnd.toISOString().slice(0, 10)}`,
        date: new Date(),
      },
    });
    return this.prisma.salaryRecord.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
    });
  }

  async remove(id: string) {
    return this.prisma.salaryRecord.delete({ where: { id } });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
