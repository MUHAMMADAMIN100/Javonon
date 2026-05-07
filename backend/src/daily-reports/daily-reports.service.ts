import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';

export interface DailyReportInput {
  date?: string;
  callsCount?: number;
  meetingsCount?: number;
  applicationsContacted?: number;
  salesCount?: number;
  salesAmount?: number;
  activitySummary?: string;
  challenges?: string;
}

@Injectable()
export class DailyReportsService {
  constructor(private prisma: PrismaService) {}

  /** Сотрудник создаёт/обновляет отчёт за день (upsert по userId+date). */
  async upsert(userId: string, dto: DailyReportInput) {
    const date = this.startOfDay(dto.date ? new Date(dto.date) : new Date());
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Некорректная дата');

    const data = {
      callsCount: dto.callsCount ?? 0,
      meetingsCount: dto.meetingsCount ?? 0,
      applicationsContacted: dto.applicationsContacted ?? 0,
      salesCount: dto.salesCount ?? 0,
      salesAmount: dto.salesAmount ?? 0,
      activitySummary: dto.activitySummary?.trim() || null,
      challenges: dto.challenges?.trim() || null,
    };

    return this.prisma.dailyReport.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, ...data },
      update: data,
    });
  }

  /** Сегодняшний отчёт текущего сотрудника. */
  async getToday(userId: string) {
    const date = this.startOfDay(new Date());
    return this.prisma.dailyReport.findUnique({
      where: { userId_date: { userId, date } },
    });
  }

  /** История отчётов сотрудника. */
  async myList(userId: string, filters: { from?: Date; to?: Date; take?: number }) {
    return this.prisma.dailyReport.findMany({
      where: {
        userId,
        ...(filters.from || filters.to
          ? { date: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }
          : {}),
      },
      orderBy: { date: 'desc' },
      take: filters.take ?? 60,
    });
  }

  /** Админский список — по любому сотруднику или всем. */
  async adminList(filters: { userId?: string; from?: Date; to?: Date }) {
    return this.prisma.dailyReport.findMany({
      where: {
        ...(filters.userId && { userId: filters.userId }),
        ...(filters.from || filters.to
          ? { date: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }
          : {}),
      },
      orderBy: [{ date: 'desc' }, { user: { fullName: 'asc' } }],
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
  }

  async remove(id: string, requesterId: string, role: Role) {
    const rec = await this.prisma.dailyReport.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Отчёт не найден');
    if (role !== 'ADMIN' && rec.userId !== requesterId) {
      throw new BadRequestException('Можно удалять только свой отчёт');
    }
    await this.prisma.dailyReport.delete({ where: { id } });
    return { ok: true };
  }

  private startOfDay(d: Date) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
}
