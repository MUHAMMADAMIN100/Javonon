import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeEntryStatus } from '@prisma/client';

// Норма прихода в офис — 09:00 локального времени.
const OFFICE_START_HOUR = 9;
const OFFICE_START_MIN = 0;

@Injectable()
export class TimeTrackingService {
  constructor(private prisma: PrismaService) {}

  /** Возвращает активную запись (WORKING или ON_LUNCH) либо null. */
  async getActive(userId: string) {
    return this.prisma.timeEntry.findFirst({
      where: { userId, status: { in: [TimeEntryStatus.WORKING, TimeEntryStatus.ON_LUNCH] } },
      orderBy: { clockIn: 'desc' },
    });
  }

  /** Сегодняшняя запись (любая) — для UI. */
  async getToday(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return this.prisma.timeEntry.findFirst({
      where: { userId, clockIn: { gte: today, lt: tomorrow } },
      orderBy: { clockIn: 'desc' },
    });
  }

  async clockIn(userId: string) {
    const active = await this.getActive(userId);
    if (active) {
      throw new BadRequestException('Сначала закройте текущую сессию (Закончить день)');
    }
    const now = new Date();
    const expected = new Date(now);
    expected.setHours(OFFICE_START_HOUR, OFFICE_START_MIN, 0, 0);
    const lateMinutes = Math.max(0, Math.round((now.getTime() - expected.getTime()) / 60000));

    return this.prisma.timeEntry.create({
      data: {
        userId,
        clockIn: now,
        date: now,
        status: TimeEntryStatus.WORKING,
        lateMinutes,
      },
    });
  }

  async lunchOut(userId: string) {
    const active = await this.getActive(userId);
    if (!active) throw new NotFoundException('Нет активной рабочей сессии');
    if (active.status !== TimeEntryStatus.WORKING) {
      throw new BadRequestException('Вы уже на обеде или вне работы');
    }
    return this.prisma.timeEntry.update({
      where: { id: active.id },
      data: { status: TimeEntryStatus.ON_LUNCH, lunchOut: new Date() },
    });
  }

  async lunchIn(userId: string) {
    const active = await this.getActive(userId);
    if (!active) throw new NotFoundException('Нет активной сессии');
    if (active.status !== TimeEntryStatus.ON_LUNCH) {
      throw new BadRequestException('Вы не на обеде');
    }
    const now = new Date();
    const lunchMs = active.lunchOut ? now.getTime() - active.lunchOut.getTime() : 0;
    const lunchMin = Math.max(0, Math.round(lunchMs / 60000));
    return this.prisma.timeEntry.update({
      where: { id: active.id },
      data: {
        status: TimeEntryStatus.WORKING,
        lunchIn: now,
        totalLunchMinutes: active.totalLunchMinutes + lunchMin,
      },
    });
  }

  async clockOut(userId: string) {
    const active = await this.getActive(userId);
    if (!active) throw new NotFoundException('Нет активной сессии');
    const now = new Date();

    let extraLunch = 0;
    if (active.status === TimeEntryStatus.ON_LUNCH && active.lunchOut) {
      extraLunch = Math.max(0, Math.round((now.getTime() - active.lunchOut.getTime()) / 60000));
    }
    const totalLunch = active.totalLunchMinutes + extraLunch;
    const totalMs = now.getTime() - active.clockIn.getTime();
    const totalMin = Math.max(0, Math.round(totalMs / 60000) - totalLunch);

    return this.prisma.timeEntry.update({
      where: { id: active.id },
      data: {
        status: TimeEntryStatus.OFF,
        clockOut: now,
        totalMinutes: totalMin,
        totalLunchMinutes: totalLunch,
      },
    });
  }

  async history(userId: string, opts: { from?: Date; to?: Date; take?: number } = {}) {
    return this.prisma.timeEntry.findMany({
      where: {
        userId,
        ...(opts.from || opts.to
          ? { clockIn: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
          : {}),
      },
      orderBy: { clockIn: 'desc' },
      take: opts.take ?? 60,
    });
  }

  /** Для админа: команда — кто сейчас работает / на обеде / закончил. */
  async teamStatus() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayEntries = await this.prisma.timeEntry.findMany({
      where: { clockIn: { gte: today, lt: tomorrow } },
      include: { user: { select: { id: true, fullName: true, role: true, email: true } } },
      orderBy: { clockIn: 'desc' },
    });

    return todayEntries;
  }

  /** Сводка по сотруднику за период (для зарплатного модуля). */
  async summaryForUser(userId: string, from: Date, to: Date) {
    const entries = await this.prisma.timeEntry.findMany({
      where: { userId, clockIn: { gte: from, lte: to } },
    });
    const workedMinutes = entries.reduce((s, e) => s + e.totalMinutes, 0);
    const lateMinutes = entries.reduce((s, e) => s + e.lateMinutes, 0);
    return { workedMinutes, lateMinutes, days: entries.length };
  }
}
