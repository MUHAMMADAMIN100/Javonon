import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PenaltyReason } from '@prisma/client';
import { SettingsService } from '../settings/settings.service';
import { tjStartOfDay, tjStartOfNextDay, tjStartOfMonth, tjStartOfNextMonth, tjLocalDay } from '../common/tj-time';

const VALID_REASONS: PenaltyReason[] = ['LATE_ARRIVAL', 'ABSENCE', 'TASK_OVERDUE', 'CUSTOM'];

const RATE_PER_LATE_MINUTE = 0.5; // $0.50 за минуту опоздания (legacy формула, для fallback)
// ТЗ §3: «при опоздании на 10-15 минут штраф должен автоматически
// фиксироваться». Раньше было 15 — это значило что опоздание 12 мин
// НЕ штрафовалось, противореча ТЗ. Понизили до 10, чтобы пример из ТЗ
// (10-15 мин) реально срабатывал. Грейс на 0-9 мин остаётся — мелкие
// задержки (пробка на 5 мин) не штрафуем.
const LATE_THRESHOLD_MIN = 10;

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
  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

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
    // Границы суток — по Asia/Dushanbe. setHours использует
    // часовой пояс сервера (UTC на Railway), из-за чего «день» съезжает
    // на 5 часов и penalty cron может промахнуться по записям, сделанным
    // около полуночи Душанбе.
    const from = tjStartOfDay(targetDate);
    const to = tjStartOfNextDay(targetDate);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        clockIn: { gte: from, lt: to },
        // ТЗ §3: «10-15 минут» — 10 ВКЛЮЧИТЕЛЬНО. gte, не gt.
        // Раньше было gt: 15, потом gt: 10 — и то и то пропускало
        // граничные значения, противореча примеру ТЗ.
        lateMinutes: { gte: LATE_THRESHOLD_MIN },
        latePenaltyApplied: false,
      },
      include: { user: { select: { id: true, fullName: true } } },
    });

    let created = 0;
    let excused = 0;
    let pending = 0;
    for (const e of entries) {
      // По ТЗ §5 — причина уходит на одобрение FOUNDER'у. Только
      // APPROVED отменяет штраф. PENDING — ждём решения (cron сегодня
      // пропускает, латеPenaltyApplied остаётся false → завтра попробуем
      // снова). REJECTED — штраф начисляем как обычно.
      const status = (e as any).lateExcuseStatus as string | null;
      if (status === 'APPROVED') {
        await this.prisma.timeEntry.update({
          where: { id: e.id },
          data: { latePenaltyApplied: true },
        });
        excused++;
        continue;
      }
      if (status === 'PENDING') {
        // Не штрафуем пока, но и не помечаем applied — следующий cron
        // ещё раз посмотрит. FOUNDER должен разобрать pending.
        pending++;
        continue;
      }
      // null (нет причины) или REJECTED → штрафуем.

      // Считаем сколько LATE_ARRIVAL штрафов уже было в этом месяце.
      // Границы месяца — в Asia/Dushanbe, иначе у юзера-полуночника
      // первое опоздание месяца может посчитаться вторым.
      const monthStart = tjStartOfMonth(from);
      const monthEnd = tjStartOfNextMonth(from);
      const priorLateCount = await this.prisma.penalty.count({
        where: {
          userId: e.userId,
          reason: 'LATE_ARRIVAL',
          date: { gte: monthStart, lt: monthEnd },
        },
      });

      // Сумма штрафа: сначала пробуем правило из SettingsService
      // (FOUNDER задаёт через /settings/penalty-rules). Если ни одно
      // не подходит — fallback на старую прогрессивную шкалу.
      let amount: number;
      let detailsRule: string;
      const rule = await this.settings.findPenaltyForLate(e.lateMinutes);
      if (rule) {
        amount = rule.amount;
        detailsRule = rule.comment
          ? ` · правило «${rule.comment}»`
          : ` · по правилу ${rule.minLateMinutes}-${rule.maxLateMinutes ?? '∞'} мин`;
      } else {
        amount = LATE_BASE_AMOUNT_TJS + priorLateCount * LATE_INCREMENT_TJS;
        detailsRule = ` · ${priorLateCount + 1}-е в этом месяце`;
      }

      // Создаём штраф + помечаем entry в одной транзакции
      await this.prisma.$transaction([
        this.prisma.penalty.create({
          data: {
            userId: e.userId,
            reason: 'LATE_ARRIVAL',
            amount,
            details: `Опоздание ${e.lateMinutes} мин${detailsRule} · без оправдания`,
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
    return { created, excused, pending, scanned: entries.length };
  }

  /** Сумма неучтённых штрафов за период (для зарплатного расчёта).
   *  Legacy — оставлен для backward compat. Новый код должен звать
   *  effectivePenaltiesForUser, который учитывает статус причины. */
  async pendingTotalForUser(userId: string, from: Date, to: Date) {
    const eff = await this.effectivePenaltiesForUser(userId, from, to);
    return eff.effective;
  }

  /**
   * Возвращает разбивку штрафов за период с учётом статуса
   * причины опоздания (lateExcuseStatus):
   *   - effective — реально вычитается из зарплаты (нет причины, или
   *     REJECTED, или не LATE_ARRIVAL)
   *   - pending — основатель ещё не разобрал причину (не вычитается)
   *   - excused — основатель одобрил причину (не вычитается)
   *
   *  По ТЗ §5: штраф за опоздание идёт в зарплату ТОЛЬКО если
   *  основатель не одобрил причину. До решения — не списываем.
   */
  async effectivePenaltiesForUser(userId: string, from: Date, to: Date) {
    const penalties = await this.prisma.penalty.findMany({
      where: { userId, applied: false, date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
    });
    if (penalties.length === 0) {
      return { effective: 0, pending: 0, excused: 0, items: [] as Array<any> };
    }
    // Подтянем TimeEntries за этот же период, чтобы понять статус
    // причины. Жмём в один запрос для всех дней.
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        clockIn: { gte: from, lte: to },
        lateMinutes: { gte: LATE_THRESHOLD_MIN },
      },
      select: { clockIn: true, lateExcuseStatus: true },
    });
    // Ключ — день в Asia/Dushanbe (penalty.date хранится setHours(0,0,0,0)
    // в локальной TZ сервера; entry.clockIn — реальный приход).
    // Берём «лучший» статус для юзера (APPROVED > PENDING > REJECTED > null).
    const STATUS_PRIORITY: Record<string, number> = {
      APPROVED: 3, PENDING: 2, REJECTED: 1,
    };
    const byDay = new Map<string, string | null>();
    for (const e of entries) {
      const day = tjLocalDay(e.clockIn);
      const cur = byDay.get(day) ?? null;
      const next = e.lateExcuseStatus as string | null;
      const curRank = cur ? STATUS_PRIORITY[cur] ?? 0 : 0;
      const nextRank = next ? STATUS_PRIORITY[next] ?? 0 : 0;
      if (nextRank > curRank) byDay.set(day, next);
      else if (!byDay.has(day)) byDay.set(day, next);
    }
    let effective = 0;
    let pending = 0;
    let excused = 0;
    const items: Array<any> = [];
    for (const p of penalties) {
      let excuseStatus: string | null = null;
      if (p.reason === 'LATE_ARRIVAL') {
        excuseStatus = byDay.get(tjLocalDay(p.date)) ?? null;
      }
      if (excuseStatus === 'APPROVED') {
        excused += p.amount;
        items.push({ ...p, excuseStatus });
      } else if (excuseStatus === 'PENDING') {
        pending += p.amount;
        items.push({ ...p, excuseStatus });
      } else {
        effective += p.amount;
        items.push({ ...p, excuseStatus });
      }
    }
    return { effective, pending, excused, items };
  }

  /** Помечает штрафы как учтённые (после создания SalaryRecord).
   *  Если переданы ids — помечает ТОЛЬКО их (используется чтобы
   *  не помечать pending/excused, которые не вошли в netAmount). */
  async markApplied(userId: string, from: Date, to: Date, ids?: string[]) {
    if (ids !== undefined) {
      if (ids.length === 0) return { count: 0 };
      return this.prisma.penalty.updateMany({
        where: { id: { in: ids }, userId, applied: false },
        data: { applied: true },
      });
    }
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

