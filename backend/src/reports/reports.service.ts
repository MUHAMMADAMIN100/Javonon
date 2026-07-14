import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { tjStartOfDay } from '../common/tj-time';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async upsertDaily(
    userId: string,
    date: Date,
    data: {
      callsCount?: number;
      meetingsCount?: number;
      applicationsContacted?: number;
      salesCount?: number;
      salesAmount?: number;
      activitySummary?: string;
      challenges?: string;
    },
  ) {
    // Anchor day-key to Asia/Dushanbe midnight so this path collides on the same
    // userId_date row that daily-reports.service (also tjStartOfDay) upserts.
    // Using setUTCHours(0) here would produce 00:00Z = 05:00 TJT and split the
    // same TJT-day into two anchors, breaking the unique constraint.
    const day = tjStartOfDay(date);
    return this.prisma.dailyReport.upsert({
      where: { userId_date: { userId, date: day } },
      update: {
        callsCount: data.callsCount ?? undefined,
        meetingsCount: data.meetingsCount ?? undefined,
        applicationsContacted: data.applicationsContacted ?? undefined,
        salesCount: data.salesCount ?? undefined,
        salesAmount: data.salesAmount ?? undefined,
        activitySummary: data.activitySummary ?? undefined,
        challenges: data.challenges ?? undefined,
      },
      create: {
        userId,
        date: day,
        callsCount: data.callsCount ?? 0,
        meetingsCount: data.meetingsCount ?? 0,
        applicationsContacted: data.applicationsContacted ?? 0,
        salesCount: data.salesCount ?? 0,
        salesAmount: data.salesAmount ?? 0,
        activitySummary: data.activitySummary ?? null,
        challenges: data.challenges ?? null,
      },
    });
  }

  async list(userId: string | undefined, opts: { from?: Date; to?: Date; take?: number }) {
    return this.prisma.dailyReport.findMany({
      where: {
        ...(userId && { userId }),
        ...(opts.from || opts.to
          ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
          : {}),
      },
      orderBy: { date: 'desc' },
      take: opts.take ?? 60,
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
  }

  async todayForUser(userId: string) {
    // Same anchor as upsertDaily / daily-reports.service — Asia/Dushanbe midnight.
    const day = tjStartOfDay(new Date());
    return this.prisma.dailyReport.findUnique({
      where: { userId_date: { userId, date: day } },
    });
  }
}
