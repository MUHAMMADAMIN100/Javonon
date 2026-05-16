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
  offlineConsultations?: number;
  onlineConsultations?: number;
  activitySummary?: string;
  challenges?: string;
}

@Injectable()
export class DailyReportsService {
  constructor(private prisma: PrismaService) {}

  /** Сотрудник создаёт/обновляет отчёт за день (upsert по userId+date). */
  async upsert(userId: string, dto: DailyReportInput) {
    // QA-fix #33: запрещаем будущие даты (отчёт за 2099 — нонсенс).
    const date = this.startOfDay(dto.date ? new Date(dto.date) : new Date());
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Некорректная дата');
    const today = this.startOfDay(new Date());
    if (date.getTime() > today.getTime()) {
      throw new BadRequestException('Нельзя создать отчёт на будущую дату');
    }

    // QA-fix #30/#32: типы и неотрицательные числа.
    const checkInt = (v: unknown, name: string, max = 10000) => {
      if (v === undefined || v === null) return 0;
      if (typeof v !== 'number' || !Number.isFinite(v) || Number.isNaN(v)) {
        throw new BadRequestException(`${name}: должно быть числом`);
      }
      if (v < 0) throw new BadRequestException(`${name}: не может быть отрицательным`);
      if (v > max) throw new BadRequestException(`${name}: слишком большое значение`);
      return Math.floor(v);
    };
    const checkFloat = (v: unknown, name: string, max = 1e9) => {
      if (v === undefined || v === null) return 0;
      if (typeof v !== 'number' || !Number.isFinite(v) || Number.isNaN(v)) {
        throw new BadRequestException(`${name}: должно быть числом`);
      }
      if (v < 0) throw new BadRequestException(`${name}: не может быть отрицательным`);
      if (v > max) throw new BadRequestException(`${name}: слишком большое значение`);
      return v;
    };

    // QA-fix #34/#35: ограничиваем длину текстовых полей и блокируем HTML.
    const checkText = (v: unknown, name: string, max = 5000): string | null => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string') throw new BadRequestException(`${name}: должно быть строкой`);
      const t = v.trim();
      if (!t) return null;
      if (t.length > max) throw new BadRequestException(`${name}: слишком длинное (макс. ${max})`);
      if (/[<>]/.test(t)) throw new BadRequestException(`${name}: содержит недопустимые символы`);
      return t;
    };

    const data = {
      callsCount: checkInt(dto.callsCount, 'callsCount'),
      meetingsCount: checkInt(dto.meetingsCount, 'meetingsCount'),
      applicationsContacted: checkInt(dto.applicationsContacted, 'applicationsContacted'),
      salesCount: checkInt(dto.salesCount, 'salesCount'),
      salesAmount: checkFloat(dto.salesAmount, 'salesAmount'),
      offlineConsultations: checkInt(dto.offlineConsultations, 'offlineConsultations'),
      onlineConsultations: checkInt(dto.onlineConsultations, 'onlineConsultations'),
      activitySummary: checkText(dto.activitySummary, 'activitySummary'),
      challenges: checkText(dto.challenges, 'challenges'),
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
