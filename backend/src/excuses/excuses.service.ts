import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Workflow одобрения причин опоздания (ТЗ §5).
 *
 * Сотрудник через /time/:id/excuse прикладывает причину + фото →
 * TimeEntry.lateExcuseStatus = PENDING. FOUNDER на странице /excuses
 * (см. ExcusesController) видит pending-список и решает:
 *   APPROVE — штраф не списывается. Если cron уже создал штраф
 *             за это опоздание — удаляем его.
 *   REJECT  — штраф остаётся (или создаётся при следующем cron'е).
 */
@Injectable()
export class ExcusesService {
  constructor(private prisma: PrismaService) {}

  /** Список pending-причин для FOUNDER'а — что нужно разобрать. */
  async listPending() {
    return this.prisma.timeEntry.findMany({
      where: {
        lateExcuseStatus: 'PENDING' as any,
      },
      include: {
        user: { select: { id: true, fullName: true, role: true, email: true } },
      },
      orderBy: { lateExcuseAt: 'desc' },
    });
  }

  /** История всех разобранных + текущих причин (с фильтром). */
  async listAll(opts: { status?: 'PENDING' | 'APPROVED' | 'REJECTED'; userId?: string; take?: number } = {}) {
    return this.prisma.timeEntry.findMany({
      where: {
        lateExcuseAt: { not: null },
        ...(opts.status && { lateExcuseStatus: opts.status as any }),
        ...(opts.userId && { userId: opts.userId }),
      },
      include: {
        user: { select: { id: true, fullName: true, role: true, email: true } },
      },
      orderBy: { lateExcuseAt: 'desc' },
      take: Math.min(opts.take || 100, 500),
    });
  }

  async approve(entryId: string, reviewerId: string) {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Запись не найдена');
    if (!entry.lateExcuseAt) {
      throw new BadRequestException('У этой записи нет причины опоздания');
    }
    // Если cron уже создал штраф за этот день — отменяем его.
    const dayStart = new Date(entry.clockIn);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const deleted = await this.prisma.penalty.deleteMany({
      where: {
        userId: entry.userId,
        reason: 'LATE_ARRIVAL',
        applied: false,  // если уже учтён в зарплате — не трогаем
        date: { gte: dayStart, lt: dayEnd },
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
        // latePenaltyApplied НЕ трогаем — следующий cron штраф создаст.
        // Если cron уже был и пропустил из-за PENDING, теперь увидит
        // REJECTED + applied=false и создаст штраф.
      },
    });
    return { ok: true };
  }
}
