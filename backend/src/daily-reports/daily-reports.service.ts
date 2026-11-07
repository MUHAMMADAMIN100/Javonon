import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import { tjCalendarDay, tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';

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

/** Потолки «разумного» дня: больше — почти наверняка опечатка. */
const MAX_DAY_COUNT = 1000;
const MAX_DAY_SALES_AMOUNT = 10_000_000;
export const MAX_REPORT_TEXT = 2000;

/**
 * День отчёта. Колонка DailyReport.date — DATE, поэтому кладём календарный
 * день Душанбе как UTC-полночь (как Penalty.date, см. tjCalendarDay). Раньше
 * здесь стояла полночь Душанбе (19:00 UTC накануне) — DATE отрезал время, и
 * отчёт за 7-е сохранялся 6-м. Старые строки по решению заказчика не трогаем.
 */
export function reportDay(d: Date = new Date()): Date {
  return tjCalendarDay(d);
}

/** Границы периода «с … по …» из фильтра (YYYY-MM-DD) для колонки DATE. */
export function reportDayRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: reportDay(tjParseLocalDate(from)) } : {}),
    ...(to ? { lte: reportDay(tjParseLocalDateEnd(to)) } : {}),
  };
}

/**
 * Проверка полей отчёта — ОДНА для обоих адресов (/reports и /daily-reports).
 * Раньше CRM писала через /reports, где проверок не было вовсе: принимались
 * «−5 звонков» и сумма 99999999999999999999.
 */
export function validateDailyReportInput(dto: DailyReportInput) {
  const checkInt = (v: unknown, name: string) => {
    if (v === undefined || v === null) return 0;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new BadRequestException(`${name}: введите число`);
    }
    if (v < 0) throw new BadRequestException(`${name}: не может быть меньше 0`);
    if (!Number.isInteger(v)) throw new BadRequestException(`${name}: только целое число`);
    if (v > MAX_DAY_COUNT) throw new BadRequestException(`${name}: не больше ${MAX_DAY_COUNT} за день`);
    return v;
  };
  const checkMoney = (v: unknown, name: string) => {
    if (v === undefined || v === null) return 0;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new BadRequestException(`${name}: введите число`);
    }
    if (v < 0) throw new BadRequestException(`${name}: не может быть меньше 0`);
    if (v > MAX_DAY_SALES_AMOUNT) {
      throw new BadRequestException(`${name}: не больше ${MAX_DAY_SALES_AMOUNT.toLocaleString('ru-RU')} TJS за день`);
    }
    return Math.round(v * 100) / 100;
  };
  const checkText = (v: unknown, name: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new BadRequestException(`${name}: должно быть текстом`);
    const t = v.trim();
    if (!t) return null;
    if (t.length > MAX_REPORT_TEXT) throw new BadRequestException(`${name}: не длиннее ${MAX_REPORT_TEXT} символов`);
    if (/[<>]/.test(t)) throw new BadRequestException(`${name}: нельзя использовать символы < и >`);
    return t;
  };

  const data = {
    callsCount: checkInt(dto.callsCount, 'Звонков'),
    meetingsCount: checkInt(dto.meetingsCount, 'Встреч'),
    applicationsContacted: checkInt(dto.applicationsContacted, 'Контактов по лидам'),
    salesCount: checkInt(dto.salesCount, 'Продаж (шт.)'),
    salesAmount: checkMoney(dto.salesAmount, 'Сумма продаж'),
    offlineConsultations: checkInt(dto.offlineConsultations, 'Оффлайн-консультаций'),
    onlineConsultations: checkInt(dto.onlineConsultations, 'Онлайн-консультаций'),
    activitySummary: checkText(dto.activitySummary, 'Что сделал за день'),
    challenges: checkText(dto.challenges, 'Блокеры / проблемы'),
  };
  // Перекрёстная проверка: сумма продаж без единой продажи — опечатка.
  if (data.salesAmount > 0 && data.salesCount === 0) {
    throw new BadRequestException('Указана сумма продаж, но «Продаж (шт.)» = 0. Укажите количество продаж.');
  }
  return data;
}

@Injectable()
export class DailyReportsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Сотрудник создаёт/обновляет отчёт за день (upsert по userId+date).
   * Дата из запроса — только сегодня или прошлое (по Душанбе).
   */
  async upsert(userId: string, dto: DailyReportInput) {
    const date = reportDay(dto.date ? tjParseLocalDate(dto.date) : new Date());
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Некорректная дата');
    if (date.getTime() > reportDay().getTime()) {
      throw new BadRequestException('Нельзя создать отчёт на будущую дату');
    }
    const data = validateDailyReportInput(dto);
    return this.prisma.dailyReport.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, ...data },
      update: data,
    });
  }

  /** Сегодняшний отчёт текущего сотрудника. */
  async getToday(userId: string) {
    return this.prisma.dailyReport.findUnique({
      where: { userId_date: { userId, date: reportDay() } },
    });
  }

  /** История отчётов сотрудника. */
  async myList(userId: string, filters: { from?: string; to?: string; take?: number }) {
    const date = reportDayRange(filters.from, filters.to);
    return this.prisma.dailyReport.findMany({
      where: { userId, ...(date ? { date } : {}) },
      orderBy: { date: 'desc' },
      take: filters.take ?? 60,
    });
  }

  /** Админский список — по любому сотруднику или всем. */
  async adminList(filters: { userId?: string; from?: string; to?: string; take?: number }) {
    const date = reportDayRange(filters.from, filters.to);
    return this.prisma.dailyReport.findMany({
      where: {
        ...(filters.userId && { userId: filters.userId }),
        ...(date ? { date } : {}),
      },
      orderBy: [{ date: 'desc' }, { user: { fullName: 'asc' } }],
      ...(filters.take ? { take: filters.take } : {}),
      include: { user: { select: { id: true, fullName: true, isActive: true, role: true } } },
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
}
