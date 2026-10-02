import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PenaltiesService } from '../penalties/penalties.service';
import { tjCalendarDay } from '../common/tj-time';

/**
 * Workflow одобрения причин опоздания (ТЗ §5).
 *
 * Сотрудник через /time/:id/excuse прикладывает причину + фото →
 * TimeEntry.lateExcuseStatus = PENDING. FOUNDER на странице /excuses
 * (см. ExcusesController) видит pending-список и решает:
 *   APPROVE — штраф не списывается. Если cron уже создал штраф
 *             за это опоздание — удаляем его.
 *   REJECT  — штраф остаётся, а если его ещё нет — создаётся сразу.
 */
@Injectable()
export class ExcusesService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private penalties: PenaltiesService,
  ) {}

  /** Список pending-причин для FOUNDER'а — что нужно разобрать.
   *  Объединяем утренние и обеденные опоздания. У каждой записи
   *  есть discriminator `kind`, чтобы фронт мог различить. */
  async listPending() {
    const [arrival, lunch] = await Promise.all([
      this.prisma.timeEntry.findMany({
        where: { lateExcuseStatus: 'PENDING' as any },
        include: { user: { select: { id: true, fullName: true, isActive: true, role: true, email: true } } },
        orderBy: { lateExcuseAt: 'desc' },
      }),
      this.prisma.timeEntry.findMany({
        where: { lunchLateExcuseStatus: 'PENDING' as any },
        include: { user: { select: { id: true, fullName: true, isActive: true, role: true, email: true } } },
        orderBy: { lunchLateExcuseAt: 'desc' },
      }),
    ]);
    const items = [
      ...arrival.map((e) => ({ ...e, kind: 'arrival' as const })),
      ...lunch.map((e) => ({ ...e, kind: 'lunch' as const })),
    ];
    return items.sort((a, b) => {
      const aT = (a.kind === 'arrival' ? a.lateExcuseAt : a.lunchLateExcuseAt)?.getTime() ?? 0;
      const bT = (b.kind === 'arrival' ? b.lateExcuseAt : b.lunchLateExcuseAt)?.getTime() ?? 0;
      return bT - aT;
    });
  }

  /** История всех разобранных + текущих причин (с фильтром).
   *  Тоже объединяем оба типа. */
  async listAll(opts: { status?: 'PENDING' | 'APPROVED' | 'REJECTED'; userId?: string; take?: number } = {}) {
    const take = Math.min(opts.take || 100, 500);
    const [arrival, lunch] = await Promise.all([
      this.prisma.timeEntry.findMany({
        where: {
          lateExcuseAt: { not: null },
          ...(opts.status && { lateExcuseStatus: opts.status as any }),
          ...(opts.userId && { userId: opts.userId }),
        },
        include: { user: { select: { id: true, fullName: true, isActive: true, role: true, email: true } } },
        orderBy: { lateExcuseAt: 'desc' },
        take,
      }),
      this.prisma.timeEntry.findMany({
        where: {
          lunchLateExcuseAt: { not: null },
          ...(opts.status && { lunchLateExcuseStatus: opts.status as any }),
          ...(opts.userId && { userId: opts.userId }),
        },
        include: { user: { select: { id: true, fullName: true, isActive: true, role: true, email: true } } },
        orderBy: { lunchLateExcuseAt: 'desc' },
        take,
      }),
    ]);
    const items = [
      ...arrival.map((e) => ({ ...e, kind: 'arrival' as const })),
      ...lunch.map((e) => ({ ...e, kind: 'lunch' as const })),
    ];
    return items
      .sort((a, b) => {
        const aT = (a.kind === 'arrival' ? a.lateExcuseAt : a.lunchLateExcuseAt)?.getTime() ?? 0;
        const bT = (b.kind === 'arrival' ? b.lateExcuseAt : b.lunchLateExcuseAt)?.getTime() ?? 0;
        return bT - aT;
      })
      .slice(0, take);
  }

  async approve(entryId: string, reviewerId: string) {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Запись не найдена');
    if (!entry.lateExcuseAt) {
      throw new BadRequestException('У этой записи нет причины опоздания');
    }
    // Если cron уже создал штраф за этот день — отменяем его. Penalty.date —
    // календарный день по Душанбе (см. tjCalendarDay).
    const deleted = await this.prisma.penalty.deleteMany({
      where: {
        userId: entry.userId,
        reason: 'LATE_ARRIVAL',
        applied: false,  // если уже учтён в зарплате — не трогаем
        date: tjCalendarDay(entry.clockIn),
      },
    });
    await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        lateExcuseStatus: 'APPROVED' as any,
        lateExcuseReviewedAt: new Date(),
        lateExcuseReviewedBy: reviewerId,
        latePenaltyApplied: true,  // больше не пытаемся штрафовать
      },
    });
    // Сотрудник на странице /time сразу увидит обновлённый статус.
    this.realtime.emitUser(entry.userId, 'excuse:approved', { entryId });
    // FOUNDER'у обновляем список pending.
    this.realtime.emitStaff('excuse:reviewed', { entryId });
    return { ok: true, penaltiesRemoved: deleted.count };
  }

  async reject(entryId: string, reviewerId: string) {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Запись не найдена');
    if (!entry.lateExcuseAt) {
      throw new BadRequestException('У этой записи нет причины опоздания');
    }
    await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        lateExcuseStatus: 'REJECTED' as any,
        lateExcuseReviewedAt: new Date(),
        lateExcuseReviewedBy: reviewerId,
      },
    });
    // Штраф — сразу. Раньше ждали «следующего cron'а», но он смотрел только
    // свои сутки, и штраф за отклонённую причину не появлялся никогда.
    // Если штраф за этот день уже есть, проход его не задвоит.
    const penalty = await this.penalties.settleLateEntry(entryId, 'arrival');
    this.realtime.emitUser(entry.userId, 'excuse:rejected', { entryId });
    this.realtime.emitStaff('excuse:reviewed', { entryId });
    return { ok: true, penaltyCreated: penalty === 'created' };
  }

  /** APPROVE для обеденного опоздания. */
  async approveLunch(entryId: string, reviewerId: string) {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Запись не найдена');
    if (!entry.lunchLateExcuseAt) {
      throw new BadRequestException('У этой записи нет причины опоздания с обеда');
    }
    const deleted = await this.prisma.penalty.deleteMany({
      where: {
        userId: entry.userId,
        reason: 'LATE_FROM_LUNCH',
        applied: false,
        date: tjCalendarDay(entry.clockIn),
      },
    });
    await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        lunchLateExcuseStatus: 'APPROVED' as any,
        lunchLateExcuseReviewedAt: new Date(),
        lunchLateExcuseReviewedBy: reviewerId,
        lateLunchPenaltyApplied: true,
      },
    });
    this.realtime.emitUser(entry.userId, 'excuse:approved', { entryId, kind: 'lunch' });
    this.realtime.emitStaff('excuse:reviewed', { entryId, kind: 'lunch' });
    return { ok: true, penaltiesRemoved: deleted.count };
  }

  /** REJECT для обеденного опоздания. */
  async rejectLunch(entryId: string, reviewerId: string) {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Запись не найдена');
    if (!entry.lunchLateExcuseAt) {
      throw new BadRequestException('У этой записи нет причины опоздания с обеда');
    }
    await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        lunchLateExcuseStatus: 'REJECTED' as any,
        lunchLateExcuseReviewedAt: new Date(),
        lunchLateExcuseReviewedBy: reviewerId,
      },
    });
    const penalty = await this.penalties.settleLateEntry(entryId, 'lunch');
    this.realtime.emitUser(entry.userId, 'excuse:rejected', { entryId, kind: 'lunch' });
    this.realtime.emitStaff('excuse:reviewed', { entryId, kind: 'lunch' });
    return { ok: true, penaltyCreated: penalty === 'created' };
  }
}
