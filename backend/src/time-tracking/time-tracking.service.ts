import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeEntryStatus } from '@prisma/client';
import { SettingsService } from '../settings/settings.service';

// Норма прихода в офис — 09:00 локального времени.
const OFFICE_START_HOUR = 9;
const OFFICE_START_MIN = 0;

// КРИТИЧНО: timezone бизнеса. Railway/Docker контейнеры обычно в UTC,
// а Душанбе на UTC+5. Без явного учёта зоны getDay()/setHours() работают
// с UTC временем → штрафы за опоздание считаются неправильно (в пределах
// типичного рабочего дня в Душанбе UTC-час всегда меньше графического,
// поэтому lateMinutes выходит 0 даже для реальных опозданий).
const BUSINESS_TZ = 'Asia/Dushanbe';

const WEEKDAY_MAP: Record<string, 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'> = {
  Sun: 'SUN', Mon: 'MON', Tue: 'TUE', Wed: 'WED', Thu: 'THU', Fri: 'FRI', Sat: 'SAT',
};

/**
 * Возвращает день недели и минуты с полуночи в Asia/Dushanbe для
 * переданной даты. Использует Intl.DateTimeFormat — единственный
 * надёжный способ работать с timezone в Node без внешних пакетов.
 */
function localDayAndMinutes(date: Date): { weekday: any; minutesFromMidnight: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const wkRaw = parts.find((p) => p.type === 'weekday')?.value || 'Mon';
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return {
    weekday: WEEKDAY_MAP[wkRaw] || 'MON',
    minutesFromMidnight: hour * 60 + minute,
  };
}

@Injectable()
export class TimeTrackingService {
  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

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

  async clockIn(userId: string, opts?: {
    lat?: number;
    lon?: number;
    proofUrl?: string;
  }) {
    const active = await this.getActive(userId);
    if (active) {
      throw new BadRequestException('Сначала закройте текущую сессию (Закончить день)');
    }
    // ТРЕБОВАНИЕ: хотя бы одно подтверждение — геолокация ИЛИ
    // фото/видео рабочего места. Без этого clock-in невозможен.
    const hasGeo = typeof opts?.lat === 'number' && typeof opts?.lon === 'number';
    const hasProof = !!opts?.proofUrl;
    if (!hasGeo && !hasProof) {
      throw new BadRequestException(
        'Для начала рабочего дня нужно подтверждение: геолокация или фото/видео рабочего места',
      );
    }

    // Гео-зона: если задана активная WorkLocation И сотрудник прислал
    // координаты — проверяем, что он внутри радиуса. Если ушёл по проверке
    // через фото/видео (proofUrl) — гео-проверка не обязательна.
    if (hasGeo) {
      const loc = await this.settings.getActiveLocation();
      if (loc) {
        const distance = SettingsService.distanceMeters(
          opts!.lat!, opts!.lon!, loc.latitude, loc.longitude,
        );
        if (distance > loc.radiusMeters) {
          throw new BadRequestException(
            `Ты за пределами рабочей зоны (${Math.round(distance)}м от «${loc.name}», ` +
            `допустимо до ${loc.radiusMeters}м). Подойди ближе или приложи фото/видео.`,
          );
        }
      }
    }

    const now = new Date();
    // Считаем день недели и минуты с полуночи в БИЗНЕС-таймзоне (Душанбе),
    // не в UTC. Без этого штрафы за опоздание на UTC сервере выходят 0 для
    // типичного рабочего дня — см. BUSINESS_TZ комментарий выше.
    const { weekday, minutesFromMidnight } = localDayAndMinutes(now);
    const sched = await this.settings.getEffectiveScheduleForUser(userId, weekday);
    // Если день нерабочий по графику — lateMinutes=0 (выход в субботу
    // на переработку не штрафуется).
    const lateMinutes = sched.isWorkday
      ? Math.max(0, minutesFromMidnight - sched.startMinute)
      : 0;

    return this.prisma.timeEntry.create({
      data: {
        userId,
        clockIn: now,
        date: now,
        status: TimeEntryStatus.WORKING,
        lateMinutes,
        clockInLat: hasGeo ? opts!.lat : null,
        clockInLon: hasGeo ? opts!.lon : null,
        clockInProofUrl: hasProof ? opts!.proofUrl : null,
      },
    });
  }

  /**
   * Сотрудник присылает оправдание опоздания (видео/фото + текст).
   * Если уже есть оправдание — обновляем. Если опоздания не было —
   * возвращаем ошибку.
   */
  async submitLateExcuse(userId: string, entryId: string, body: {
    excuseUrl?: string;
    excuseReason?: string;
  }) {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('Запись не найдена');
    if (entry.userId !== userId) {
      throw new BadRequestException('Это не ваша запись');
    }
    if (entry.lateMinutes <= 0) {
      throw new BadRequestException('Опоздания не было');
    }
    if (entry.latePenaltyApplied) {
      throw new BadRequestException('Штраф уже начислен, оправдание поздно');
    }
    if (!body.excuseUrl && (!body.excuseReason || body.excuseReason.trim().length < 5)) {
      throw new BadRequestException('Укажи причину (мин. 5 символов) или приложи фото/видео');
    }
    return this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        lateExcuseUrl: body.excuseUrl || null,
        lateExcuseReason: body.excuseReason?.trim() || null,
        lateExcuseAt: new Date(),
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
    // Норма рабочего дня берётся из ГРАФИКА сотрудника (по ТЗ §3).
    // workingDay = end - start - запланированный обед.
    // Если расписания нет — fallback на 8 часов (480 мин).
    const { weekday: clockInWeekday } = localDayAndMinutes(active.clockIn);
    const sched = await this.settings.getEffectiveScheduleForUser(userId, clockInWeekday);
    // Если рабочий день — норма = длина окна минус запланированный обед.
    // Если выходной — норма = 0, ВСЕ часы засчитываются как переработка
    // (по ТЗ §3 «учет переработок»: работа вне графика = overtime).
    let standardDayMin = 0;
    if (sched.isWorkday) {
      const lunch = (sched.lunchStartMinute !== null && sched.lunchEndMinute !== null)
        ? Math.max(0, sched.lunchEndMinute - sched.lunchStartMinute)
        : 0;
      standardDayMin = Math.max(60, sched.endMinute - sched.startMinute - lunch);
    }
    const overtimeMinutes = Math.max(0, totalMin - standardDayMin);

    return this.prisma.timeEntry.update({
      where: { id: active.id },
      data: {
        status: TimeEntryStatus.OFF,
        clockOut: now,
        totalMinutes: totalMin,
        totalLunchMinutes: totalLunch,
        overtimeMinutes,
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
