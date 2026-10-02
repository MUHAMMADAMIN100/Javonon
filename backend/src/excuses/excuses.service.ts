import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LATE_THRESHOLD_MIN, PenaltiesService } from '../penalties/penalties.service';
import { tjCalendarDay, tjLocalDay } from '../common/tj-time';

/**
 * Статус одного опоздания в «Истории»:
 *   APPROVED / REJECTED / PENDING — решение по причине сотрудника;
 *   NONE  — причины нет, опоздание от 10 минут (штраф);
 *   MINOR — причины нет, короче 10 минут (без штрафа).
 */
export type LatenessStatus = 'APPROVED' | 'REJECTED' | 'PENDING' | 'NONE' | 'MINOR';
/** Фильтр «История»: «не одобрено» — отклонено или без причины, то есть со штрафом. */
export type LatenessFilter = 'approved' | 'not_approved' | 'pending';

/** Одно опоздание в «Истории»: утро или обед одной отметки прихода. */
export interface LatenessItem {
  /** id отметки прихода (TimeEntry) — у утра и обеда одного дня он общий. */
  id: string;
  kind: 'arrival' | 'lunch';
  user: { id: string; fullName: string; email: string; isActive: boolean };
  clockIn: Date;
  minutes: number;
  status: LatenessStatus;
  reason: string | null;
  url: string | null;
  reviewedAt: Date | null;
  /** Штрафы за этот день и вид опоздания, TJS; 0 — штрафа нет. */
  penalty: number;
}

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

  /**
   * «История» опозданий — ВСЕ опоздания (утро и обед), с причиной и без, а
   * не только объяснённые: основатель сверяет её с колонкой «Опоздания» в
   * «Зарплате» (там сумма TimeEntry.lateMinutes за период — те же утренние
   * минуты, что здесь при «Все статусы»).
   *
   * Фильтры: сотрудник, период по дню прихода (Asia/Dushanbe), статус.
   * Итоги — по ВСЕМ найденным, а не по странице: минуты (утро / обед, по
   * статусам) и штрафы за эти дни.
   */
  async history(opts: {
    userId?: string;
    from?: Date;
    to?: Date;
    status?: LatenessFilter;
    page: number;
    pageSize: number;
  }) {
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        ...(opts.userId && { userId: opts.userId }),
        ...((opts.from || opts.to) && {
          clockIn: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) },
        }),
        OR: [{ lateMinutes: { gt: 0 } }, { lateLunchMinutes: { gt: 0 } }],
      },
      select: {
        id: true,
        userId: true,
        clockIn: true,
        lateMinutes: true,
        lateLunchMinutes: true,
        lateExcuseAt: true,
        lateExcuseStatus: true,
        lateExcuseReason: true,
        lateExcuseUrl: true,
        lateExcuseReviewedAt: true,
        lunchLateExcuseAt: true,
        lunchLateExcuseStatus: true,
        lunchLateExcuseReason: true,
        lunchLateExcuseUrl: true,
        lunchLateExcuseReviewedAt: true,
        user: { select: { id: true, fullName: true, email: true, isActive: true } },
      },
      orderBy: { clockIn: 'desc' },
    });

    // Штрафы за эти дни: дата штрафа — календарный день опоздания
    // (см. tjCalendarDay), по ней и сопоставляем.
    const penaltyByKey = new Map<string, number>();
    if (entries.length) {
      const times = entries.map((e) => e.clockIn.getTime());
      const penalties = await this.prisma.penalty.findMany({
        where: {
          userId: { in: [...new Set(entries.map((e) => e.userId))] },
          reason: { in: ['LATE_ARRIVAL', 'LATE_FROM_LUNCH'] },
          date: {
            gte: tjCalendarDay(new Date(Math.min(...times))),
            lte: tjCalendarDay(new Date(Math.max(...times))),
          },
        },
        select: { userId: true, reason: true, date: true, amount: true },
      });
      for (const p of penalties) {
        const key = `${p.userId}|${p.date.toISOString().slice(0, 10)}|${p.reason}`;
        penaltyByKey.set(key, (penaltyByKey.get(key) ?? 0) + p.amount);
      }
    }

    const statusOf = (excuseAt: Date | null, excuseStatus: string | null, minutes: number): LatenessStatus => {
      if (excuseAt || excuseStatus) return ((excuseStatus as LatenessStatus | null) ?? 'PENDING');
      return minutes >= LATE_THRESHOLD_MIN ? 'NONE' : 'MINOR';
    };

    const items = entries.flatMap((e) => {
      const day = tjLocalDay(e.clockIn);
      const out: LatenessItem[] = [];
      if (e.lateMinutes > 0) {
        out.push({
          id: e.id,
          kind: 'arrival',
          user: e.user,
          clockIn: e.clockIn,
          minutes: e.lateMinutes,
          status: statusOf(e.lateExcuseAt, e.lateExcuseStatus, e.lateMinutes),
          reason: e.lateExcuseReason,
          url: e.lateExcuseUrl,
          reviewedAt: e.lateExcuseReviewedAt,
          penalty: penaltyByKey.get(`${e.userId}|${day}|LATE_ARRIVAL`) ?? 0,
        });
      }
      if (e.lateLunchMinutes > 0) {
        out.push({
          id: e.id,
          kind: 'lunch',
          user: e.user,
          clockIn: e.clockIn,
          minutes: e.lateLunchMinutes,
          status: statusOf(e.lunchLateExcuseAt, e.lunchLateExcuseStatus, e.lateLunchMinutes),
          reason: e.lunchLateExcuseReason,
          url: e.lunchLateExcuseUrl,
          reviewedAt: e.lunchLateExcuseReviewedAt,
          penalty: penaltyByKey.get(`${e.userId}|${day}|LATE_FROM_LUNCH`) ?? 0,
        });
      }
      return out;
    });

    const filtered = items.filter((it) => {
      if (opts.status === 'approved') return it.status === 'APPROVED';
      if (opts.status === 'not_approved') return it.status === 'REJECTED' || it.status === 'NONE';
      if (opts.status === 'pending') return it.status === 'PENDING';
      return true;
    });

    const sum = (pred: (it: LatenessItem) => boolean, f: (it: LatenessItem) => number) =>
      filtered.reduce((acc, it) => (pred(it) ? acc + f(it) : acc), 0);
    const minutes = (it: LatenessItem) => it.minutes;
    const totals = {
      count: filtered.length,
      minutes: sum(() => true, minutes),
      arrivalMinutes: sum((it) => it.kind === 'arrival', minutes),
      lunchMinutes: sum((it) => it.kind === 'lunch', minutes),
      approvedMinutes: sum((it) => it.status === 'APPROVED', minutes),
      notApprovedMinutes: sum((it) => it.status === 'REJECTED' || it.status === 'NONE', minutes),
      pendingMinutes: sum((it) => it.status === 'PENDING', minutes),
      minorMinutes: sum((it) => it.status === 'MINOR', minutes),
      penalties: Math.round(sum(() => true, (it) => it.penalty) * 100) / 100,
    };

    const start = (opts.page - 1) * opts.pageSize;
    return {
      items: filtered.slice(start, start + opts.pageSize),
      total: filtered.length,
      page: opts.page,
      pageSize: opts.pageSize,
      totals,
    };
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
