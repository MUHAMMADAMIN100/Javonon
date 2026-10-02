import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, PenaltyReason } from '@prisma/client';
import { SettingsService } from '../settings/settings.service';
import {
  parseCalendarDateUtc,
  tjCalendarDay,
  tjLocalDay,
  tjStartOfDay,
  tjStartOfMonth,
  tjStartOfNextDay,
} from '../common/tj-time';

/** Утреннее опоздание или позднее возвращение с обеда. */
export type LateKind = 'arrival' | 'lunch';
type SettleOutcome = 'created' | 'excused' | 'pending' | 'below' | 'none';

const ENTRY_SELECT = {
  id: true,
  userId: true,
  clockIn: true,
  lateMinutes: true,
  lateLunchMinutes: true,
  lateExcuseStatus: true,
  lunchLateExcuseStatus: true,
} as const;
type LateEntry = Prisma.TimeEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

const VALID_REASONS: PenaltyReason[] = ['LATE_ARRIVAL', 'LATE_FROM_LUNCH', 'ABSENCE', 'TASK_OVERDUE', 'CUSTOM'];

const RATE_PER_LATE_MINUTE = 0.5; // $0.50 за минуту опоздания (legacy формула, для fallback)
// ТЗ §3: «при опоздании на 10-15 минут штраф должен автоматически
// фиксироваться». Раньше было 15 — это значило что опоздание 12 мин
// НЕ штрафовалось, противореча ТЗ. Понизили до 10, чтобы пример из ТЗ
// (10-15 мин) реально срабатывал. Грейс на 0-9 мин остаётся — мелкие
// задержки (пробка на 5 мин) не штрафуем.
const LATE_THRESHOLD_MIN = 10;

/**
 * Встроенная шкала — ТОЛЬКО когда в Настройках нет ни одного активного
 * правила штрафов (см. SettingsService.findPenaltyForLate):
 *  1-е опоздание за месяц → 200 TJS, 2-е → 250, 3-е → 300, далее +50.
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
        // Penalty.date — календарный день (DATE), границы периода переводим
        // в дни по Душанбе, см. tjCalendarDay.
        ...(filters.from || filters.to
          ? {
              date: {
                ...(filters.from && { gte: tjCalendarDay(filters.from) }),
                ...(filters.to && { lte: tjCalendarDay(filters.to) }),
              },
            }
          : {}),
      },
      orderBy: { date: 'desc' },
      include: { user: { select: { id: true, fullName: true, isActive: true, role: true } } },
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

    // Календарный день: «YYYY-MM-DD» как есть, без даты — сегодня по
    // Душанбе (сырое new Date() ночью легло бы вчерашним UTC-числом).
    let date: Date;
    if (dto.date) {
      const d = parseCalendarDateUtc(dto.date);
      if (isNaN(d.getTime())) throw new BadRequestException('Некорректная дата');
      date = d;
    } else {
      date = tjCalendarDay();
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
   * Догоняющий проход штрафов за опоздания (утро и обед).
   *
   * ПОЧЕМУ НЕ «ТОЛЬКО СЕГОДНЯ». Раньше cron в 22:00 пн–пт брал опоздания
   * ровно за текущие сутки. Всё, что в этот момент не обработалось, не
   * обрабатывалось уже никогда: суббота/воскресенье, вечер, когда сервер
   * перезапускался на выкладке, и — главное — причина «на рассмотрении»:
   * cron её пропускал, а после отклонения следующий запуск смотрел уже
   * свой день. Теперь проход берёт ВСЕ ещё не обработанные опоздания окна
   * (текущий и прошлый месяц по Душанбе); пропущенный день догоняется
   * первым же проходом.
   *
   * includeToday=false — проход при старте сервера: сегодняшний день не
   * трогаем до вечера, сотрудник ещё может объяснить опоздание.
   *
   * Повторно одну запись не обработать: см. settleEntry (захват флага).
   */
  async generatePendingLatePenalties(opts: { includeToday: boolean; now?: Date }) {
    const now = opts.now ?? new Date();
    const prevMonthStart = tjStartOfMonth(new Date(tjStartOfMonth(now).getTime() - 1));
    const until = opts.includeToday ? tjStartOfNextDay(now) : tjStartOfDay(now);
    const arrival = await this.settleWindow('arrival', prevMonthStart, until);
    const lunch = await this.settleWindow('lunch', prevMonthStart, until);
    return { arrival, lunch };
  }

  /**
   * Начислить (или закрыть без штрафа) одно опоздание — вызывается при
   * отклонении причины, чтобы штраф появился сразу, а не «следующим cron'ом».
   */
  async settleLateEntry(entryId: string, kind: LateKind) {
    const e = await this.prisma.timeEntry.findUnique({ where: { id: entryId }, select: ENTRY_SELECT });
    if (!e) return 'none' as const;
    return this.settleEntry(kind, e);
  }

  private async settleWindow(kind: LateKind, from: Date, until: Date) {
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        clockIn: { gte: from, lt: until },
        ...(kind === 'arrival'
          ? { lateMinutes: { gte: LATE_THRESHOLD_MIN }, latePenaltyApplied: false }
          : { lateLunchMinutes: { gte: LATE_THRESHOLD_MIN }, lateLunchPenaltyApplied: false }),
      },
      select: ENTRY_SELECT,
      // По порядку дней: встроенная шкала (когда правил нет) считает
      // «N-е опоздание в месяце» по уже созданным штрафам.
      orderBy: { clockIn: 'asc' },
    });
    const stats = { created: 0, excused: 0, pending: 0, below: 0, scanned: entries.length };
    for (const e of entries) {
      const outcome = await this.settleEntry(kind, e);
      if (outcome === 'created') stats.created++;
      else if (outcome === 'excused') stats.excused++;
      else if (outcome === 'pending') stats.pending++;
      else if (outcome === 'below') stats.below++;
    }
    return stats;
  }

  /**
   * Решение по одному опозданию:
   *   APPROVED — штрафа нет, запись закрыта;
   *   PENDING  — ждём основателя, запись остаётся открытой;
   *   нет причины / REJECTED — штраф по шкале из Настроек.
   *
   * Запись «захватывается» условным UPDATE флага в той же транзакции, что и
   * создание штрафа: проход при старте, вечерний cron и отклонение причины
   * могут встретиться на одной записи — штраф всё равно будет один.
   */
  private async settleEntry(kind: LateKind, e: LateEntry): Promise<SettleOutcome> {
    const minutes = kind === 'arrival' ? e.lateMinutes : e.lateLunchMinutes;
    const status = (kind === 'arrival' ? e.lateExcuseStatus : e.lunchLateExcuseStatus) as string | null;
    const claimWhere = kind === 'arrival'
      ? { id: e.id, latePenaltyApplied: false }
      : { id: e.id, lateLunchPenaltyApplied: false };
    const claimData = kind === 'arrival' ? { latePenaltyApplied: true } : { lateLunchPenaltyApplied: true };
    const claim = async (db: Prisma.TransactionClient) =>
      (await db.timeEntry.updateMany({ where: claimWhere, data: claimData })).count === 1;

    if (minutes < LATE_THRESHOLD_MIN) return 'none';
    if (status === 'APPROVED') return (await claim(this.prisma)) ? 'excused' : 'none';
    if (status === 'PENDING') return 'pending';

    const reason: PenaltyReason = kind === 'arrival' ? 'LATE_ARRIVAL' : 'LATE_FROM_LUNCH';
    const day = tjCalendarDay(e.clockIn);
    const { rule, hasRules, beyond } = await this.settings.findPenaltyForLate(minutes);
    // Правила есть, но опоздание короче самого первого — шкала компании его
    // не штрафует.
    if (hasRules && !rule) return (await claim(this.prisma)) ? 'below' : 'none';

    let amount: number;
    let ruleText: string;
    if (rule) {
      amount = rule.amount;
      ruleText = rule.comment
        ? `правило «${rule.comment}»`
        : `${beyond ? 'по последнему правилу' : 'по правилу'} ${rule.minLateMinutes}-${rule.maxLateMinutes ?? '∞'} мин`;
    } else {
      // Правил в Настройках нет — встроенная шкала: 200, 250, 300… за
      // каждое следующее опоздание этого вида в месяце.
      const prior = await this.prisma.penalty.count({
        where: { userId: e.userId, reason, date: { gte: tjCalendarDay(tjStartOfMonth(e.clockIn)), lt: day } },
      });
      amount = LATE_BASE_AMOUNT_TJS + prior * LATE_INCREMENT_TJS;
      ruleText = `${prior + 1}-е в этом месяце`;
    }
    const [, mm, dd] = tjLocalDay(e.clockIn).split('-');
    // Дата в скобках — не только для людей: по ней миграция
    // migrate-penalty-dates.ts отличает новые штрафы от старых (у старых
    // после минут сразу « · »).
    const label = kind === 'arrival' ? 'Опоздание' : 'Позднее возвращение с обеда';
    const details = `${label} ${minutes} мин (${dd}.${mm}) · ${ruleText} · ${status === 'REJECTED' ? 'причина отклонена' : 'без оправдания'}`;

    return this.prisma.$transaction(async (tx) => {
      if (!(await claim(tx))) return 'none' as const;
      await tx.penalty.create({ data: { userId: e.userId, reason, amount, details, date: day } });
      return 'created' as const;
    });
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
      where: { userId, applied: false, date: { gte: tjCalendarDay(from), lte: tjCalendarDay(to) } },
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
        OR: [
          { lateMinutes: { gte: LATE_THRESHOLD_MIN } },
          { lateLunchMinutes: { gte: LATE_THRESHOLD_MIN } },
        ],
      },
      select: {
        clockIn: true,
        lateExcuseStatus: true,
        lunchLateExcuseStatus: true,
      },
    });
    // Ключ — день в Asia/Dushanbe (penalty.date хранится setHours(0,0,0,0)
    // в локальной TZ сервера; entry.clockIn — реальный приход).
    // Берём «лучший» статус для юзера (APPROVED > PENDING > REJECTED > null).
    const STATUS_PRIORITY: Record<string, number> = {
      APPROVED: 3, PENDING: 2, REJECTED: 1,
    };
    const arrivalByDay = new Map<string, string | null>();
    const lunchByDay = new Map<string, string | null>();
    const pickBest = (map: Map<string, string | null>, day: string, next: string | null) => {
      const cur = map.get(day) ?? null;
      const curRank = cur ? STATUS_PRIORITY[cur] ?? 0 : 0;
      const nextRank = next ? STATUS_PRIORITY[next] ?? 0 : 0;
      if (nextRank > curRank) map.set(day, next);
      else if (!map.has(day)) map.set(day, next);
    };
    for (const e of entries) {
      const day = tjLocalDay(e.clockIn);
      pickBest(arrivalByDay, day, e.lateExcuseStatus as string | null);
      pickBest(lunchByDay, day, e.lunchLateExcuseStatus as string | null);
    }
    let effective = 0;
    let pending = 0;
    let excused = 0;
    const items: Array<any> = [];
    for (const p of penalties) {
      let excuseStatus: string | null = null;
      if (p.reason === 'LATE_ARRIVAL') {
        excuseStatus = arrivalByDay.get(tjLocalDay(p.date)) ?? null;
      } else if (p.reason === 'LATE_FROM_LUNCH') {
        excuseStatus = lunchByDay.get(tjLocalDay(p.date)) ?? null;
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
        date: { gte: tjCalendarDay(from), lte: tjCalendarDay(to) },
      },
      data: { applied: true },
    });
  }

  /**
   * Удалили начисленную (не выплаченную) зарплату — её штрафы снова
   * «не учтены», иначе при новом начислении за тот же период они бы не
   * вычлись: effectivePenaltiesForUser берёт только applied = false.
   *
   * Связи «штраф → запись зарплаты» в БД нет, поэтому снимаем отметку у
   * учтённых штрафов периода, которые не попадают ни в одну ОСТАВШУЮСЯ
   * запись этого сотрудника — их могла учесть только удаляемая. Окно шире
   * периода на день с каждой стороны: до 2026-10-02 штраф за опоздание
   * писался на день раньше (см. migrate-penalty-dates.ts), и запись за
   * сентябрь могла учесть опоздание 1 октября.
   */
  async releaseForRemovedSalary(
    db: Prisma.TransactionClient,
    userId: string,
    period: { periodStart: Date; periodEnd: Date },
    remaining: Array<{ periodStart: Date; periodEnd: Date }>,
  ) {
    const DAY = 24 * 60 * 60 * 1000;
    const from = new Date(tjCalendarDay(period.periodStart).getTime() - DAY);
    const to = new Date(tjCalendarDay(period.periodEnd).getTime() + DAY);
    const applied = await db.penalty.findMany({
      where: { userId, applied: true, date: { gte: from, lte: to } },
      select: { id: true, date: true },
    });
    const covered = (d: Date) =>
      remaining.some((r) => d >= tjCalendarDay(r.periodStart) && d <= tjCalendarDay(r.periodEnd));
    const ids = applied.filter((p) => !covered(p.date)).map((p) => p.id);
    if (ids.length === 0) return 0;
    const res = await db.penalty.updateMany({ where: { id: { in: ids } }, data: { applied: false } });
    return res.count;
  }
}

