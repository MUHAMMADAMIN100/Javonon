import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PenaltyReason } from '@prisma/client';

const VALID_REASONS: PenaltyReason[] = ['LATE_ARRIVAL', 'ABSENCE', 'TASK_OVERDUE', 'CUSTOM'];

const RATE_PER_LATE_MINUTE = 0.5; // $0.50 за минуту опоздания (legacy формула, для fallback)
const LATE_THRESHOLD_MIN = 15;    // штраф начисляется при опоздании > 15 мин

/**
 * Прогрессивная шкала штрафов за повторные опоздания в течение месяца:
 *  1-е опоздание → 200 TJS (сомони)
 *  2-е → 250 TJS
 *  3-е → 300 TJS
 *  каждое следующее +50 TJS
 *
 * Эти суммы можно настраивать через env или БД позже, пока зашиты.
 */
const LATE_BASE_AMOUNT_TJS = 200;
const LATE_INCREMENT_TJS = 50;
const LATE_CURRENCY = 'TJS';

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

  async createManual(userId: string, dto: { reason?: PenaltyReason; amount: number; details: string; date?: string }) {
    // QA-fix #25-28: типы, диапазоны, валидация enum, проверка существования.
    if (typeof dto.amount !== 'number' || !isFinite(dto.amount) || isNaN(dto.amount)) {
      throw new BadRequestException('Сумма должна быть числом');
    }
    if (dto.amount <= 0) throw new BadRequestException('Сумма должна быть > 0');
    if (dto.amount > 100_000) throw new BadRequestException('Сумма штрафа не может превышать 100 000');

    const reason = dto.reason || 'CUSTOM';
    if (!VALID_REASONS.includes(reason)) {
      throw new BadRequestException(`Неизвестная причина. Доступно: ${VALID_REASONS.join(', ')}`);
    }

    const details = (dto.details || '').trim();
    if (!details) throw new BadRequestException('Опишите причину штрафа');
    if (details.length > 500) throw new BadRequestException('Описание слишком длинное (макс. 500 символов)');
    if (/[<>]/.test(details)) throw new BadRequestException('Описание содержит недопустимые символы');

    let date: Date;
    if (dto.date) {
      const d = new Date(dto.date);
      if (isNaN(d.getTime())) throw new BadRequestException('Некорректная дата');
      date = d;
    } else {
      date = new Date();
    }

    // Проверяем существование пользователя — иначе FK даёт 500.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('Пользователь не найден');

    return this.prisma.penalty.create({
      data: { userId, reason, amount: dto.amount, details, date },
    });
  }

  async remove(id: string) {
    return this.prisma.penalty.delete({ where: { id } });
  }

  /**
   * Cron-задача: для каждого TimeEntry за указанную дату
   * с lateMinutes > 15 — создаём Penalty (LATE_ARRIVAL).
   *
   * Новая логика:
   *  - Если сотрудник предоставил оправдание (lateExcuseAt не null) —
   *    штраф НЕ начисляется (записываем latePenaltyApplied=true чтобы
   *    больше не проверять).
   *  - Если оправдания нет — начисляем штраф ПРОГРЕССИВНО:
   *    считаем сколько раз в текущем месяце сотрудник уже получал
   *    LATE_ARRIVAL штраф, и берём BASE + N × INCREMENT TJS.
   *  - Помечаем TimeEntry.latePenaltyApplied=true для идемпотентности.
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
        latePenaltyApplied: false,
      },
      include: { user: { select: { id: true, fullName: true } } },
    });

    let created = 0;
    let excused = 0;
    for (const e of entries) {
      // Если есть оправдание — не штрафуем (но помечаем applied, чтобы
      // повторный запуск Cron не штрафовал).
      if (e.lateExcuseAt) {
        await this.prisma.timeEntry.update({
          where: { id: e.id },
          data: { latePenaltyApplied: true },
        });
        excused++;
        continue;
      }

      // Считаем сколько LATE_ARRIVAL штрафов уже было в этом месяце
      const monthStart = new Date(from.getFullYear(), from.getMonth(), 1);
      const monthEnd = new Date(from.getFullYear(), from.getMonth() + 1, 1);
      const priorLateCount = await this.prisma.penalty.count({
        where: {
          userId: e.userId,
          reason: 'LATE_ARRIVAL',
          date: { gte: monthStart, lt: monthEnd },
        },
      });

      const amount = LATE_BASE_AMOUNT_TJS + priorLateCount * LATE_INCREMENT_TJS;

      // Создаём штраф + помечаем entry в одной транзакции
      await this.prisma.$transaction([
        this.prisma.penalty.create({
          data: {
            userId: e.userId,
            reason: 'LATE_ARRIVAL',
            amount,
            details: `Опоздание ${e.lateMinutes} мин · ${priorLateCount + 1}-е в этом месяце · без оправдания`,
            date: from,
          },
        }),
        this.prisma.timeEntry.update({
          where: { id: e.id },
          data: { latePenaltyApplied: true },
        }),
      ]);
      created++;
    }
    return { created, excused, scanned: entries.length };
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
