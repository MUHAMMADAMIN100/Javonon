import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Weekday } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const WEEKDAYS: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function clampMinute(v: any): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) throw new BadRequestException('Минуты некорректны');
  if (n < 0 || n > 1439) throw new BadRequestException('Минуты должны быть 0..1439');
  return n;
}

/**
 * SettingsService — общий сервис для FOUNDER-настраиваемых вещей:
 * рабочих графиков, штрафных правил, гео-зоны рабочего места.
 * По ТЗ всё это управляется только основателем (RolesGuard
 * на контроллере), сотрудники только читают.
 */
@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  // ===== Work Schedule =====

  /**
   * Расписание для конкретного сотрудника (или дефолт компании, если
   * userId=null). Возвращает массив из 7 записей (по одной на день
   * недели). Отсутствующие дни возвращаются как «нерабочие» с дефолтным
   * 09:00-18:00, 12:00-13:00 обед (не сохраняются в БД до явного
   * редактирования).
   */
  async getSchedule(userId: string | null) {
    const rows = await this.prisma.workSchedule.findMany({
      where: { userId },
    });
    const byDay = new Map(rows.map((r) => [r.weekday, r]));
    return WEEKDAYS.map((wd) => byDay.get(wd) || {
      id: null,
      userId,
      weekday: wd,
      isWorkday: wd !== 'SAT' && wd !== 'SUN',
      startMinute: 540,
      endMinute: 1080,
      lunchStartMinute: 720,
      lunchEndMinute: 780,
    });
  }

  /**
   * Полностью удалить график (все 7 дней) для указанного userId.
   * Если userId=null — удаляется компанийский дефолт (clockIn упадёт
   * на hardcoded fallback). Если userId=кого-то — этот сотрудник
   * перестаёт иметь личный график и возвращается к компанийскому
   * дефолту. Закрывает «D» в CRUD по ТЗ §3.
   */
  async deleteSchedule(userId: string | null) {
    // Prisma deleteMany с null в фильтре работает (в отличие от findUnique).
    const r = await this.prisma.workSchedule.deleteMany({
      where: { userId },
    });
    return { deleted: r.count };
  }

  /**
   * Сохранить полный набор графика (7 дней) для пользователя или
   * дефолта. Upsert по (userId, weekday). Используется как "массовое
   * сохранение" с UI вместо 7 отдельных PATCH.
   */
  async upsertSchedule(
    userId: string | null,
    days: Array<{
      weekday: Weekday;
      isWorkday?: boolean;
      startMinute?: number;
      endMinute?: number;
      lunchStartMinute?: number | null;
      lunchEndMinute?: number | null;
    }>,
  ) {
    if (!Array.isArray(days)) throw new BadRequestException('days должно быть массивом');
    const results: any[] = [];
    for (const d of days) {
      if (!WEEKDAYS.includes(d.weekday)) {
        throw new BadRequestException(`Неизвестный день недели: ${d.weekday}`);
      }
      const start = d.startMinute !== undefined ? clampMinute(d.startMinute) : 540;
      const end = d.endMinute !== undefined ? clampMinute(d.endMinute) : 1080;
      if (start >= end) throw new BadRequestException(`Конец дня должен быть позже начала (${d.weekday})`);
      const lunchStart =
        d.lunchStartMinute !== undefined && d.lunchStartMinute !== null
          ? clampMinute(d.lunchStartMinute)
          : null;
      const lunchEnd =
        d.lunchEndMinute !== undefined && d.lunchEndMinute !== null
          ? clampMinute(d.lunchEndMinute)
          : null;
      if (lunchStart !== null && lunchEnd !== null && lunchStart >= lunchEnd) {
        throw new BadRequestException(`Обед некорректен (${d.weekday})`);
      }
      // КРИТИЧНО: для userId=null (компанийского дефолта) Prisma upsert
      // через compound unique НЕ РАБОТАЕТ — findUnique возвращает null,
      // и каждый вызов плодит дубликаты (Postgres разрешает множественные
      // null в UNIQUE). Поэтому для null делаем ручной find+update/create.
      let r: any;
      if (userId === null) {
        const existing = await this.prisma.workSchedule.findFirst({
          where: { userId: null, weekday: d.weekday },
        });
        const data = {
          isWorkday: d.isWorkday ?? true,
          startMinute: start,
          endMinute: end,
          lunchStartMinute: lunchStart,
          lunchEndMinute: lunchEnd,
        };
        r = existing
          ? await this.prisma.workSchedule.update({ where: { id: existing.id }, data })
          : await this.prisma.workSchedule.create({ data: { userId: null, weekday: d.weekday, ...data } });
      } else {
        r = await this.prisma.workSchedule.upsert({
        where: { userId_weekday: { userId, weekday: d.weekday } },
        update: {
          isWorkday: d.isWorkday ?? true,
          startMinute: start,
          endMinute: end,
          lunchStartMinute: lunchStart,
          lunchEndMinute: lunchEnd,
        },
        create: {
          userId,
          weekday: d.weekday,
          isWorkday: d.isWorkday ?? true,
          startMinute: start,
          endMinute: end,
          lunchStartMinute: lunchStart,
          lunchEndMinute: lunchEnd,
        },
        });
      }
      results.push(r);
    }
    return results;
  }

  // ===== Penalty Rules =====

  async listPenaltyRules() {
    return this.prisma.penaltyRule.findMany({
      orderBy: { minLateMinutes: 'asc' },
    });
  }

  async createPenaltyRule(data: {
    minLateMinutes: number;
    maxLateMinutes?: number | null;
    amount: number;
    currency?: string;
    comment?: string;
  }) {
    const clean = this.validatePenaltyRuleFields(data);
    return this.prisma.penaltyRule.create({
      data: {
        minLateMinutes: clean.min,
        maxLateMinutes: clean.max,
        amount: clean.amount,
        currency: clean.currency,
        comment: clean.comment,
      },
    });
  }

  /**
   * Валидация полей правила штрафа. Раньше controller принимал
   * `body: any`, service делал базовый Number-check но без upper bound /
   * currency whitelist / HTML-protection на comment. Реальные риски:
   *   - amount: typo «50000» вместо «500» → массовые ошибочные штрафы
   *   - currency: любая строка → ломает downstream бухгалтерию
   *   - comment: `<script>` стримился в audit logs и notifications
   */
  private validatePenaltyRuleFields(data: {
    minLateMinutes?: number;
    maxLateMinutes?: number | null;
    amount?: number;
    currency?: string;
    comment?: string;
  }): { min: number; max: number | null; amount: number; currency: string; comment: string | null } {
    const VALID_CURRENCIES = new Set(['TJS', 'USD', 'EUR', 'CNY', 'RUB']);
    const min = Math.floor(Number(data.minLateMinutes));
    if (!Number.isFinite(min) || min < 0) throw new BadRequestException('minLateMinutes ≥ 0');
    if (min > 24 * 60) throw new BadRequestException('minLateMinutes слишком велик (макс. 1440 = сутки)');
    let max: number | null = null;
    if (data.maxLateMinutes !== undefined && data.maxLateMinutes !== null) {
      max = Math.floor(Number(data.maxLateMinutes));
      if (!Number.isFinite(max) || max <= min) {
        throw new BadRequestException('maxLateMinutes должен быть > minLateMinutes');
      }
      if (max > 24 * 60) throw new BadRequestException('maxLateMinutes слишком велик (макс. 1440)');
    }
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('amount > 0');
    if (amount > 1_000_000) {
      // Защита от typo (50000 вместо 500). Реальный штраф < 10k TJS.
      throw new BadRequestException('amount слишком велик (макс. 1 000 000)');
    }
    const currency = (data.currency || 'TJS').toUpperCase();
    if (!VALID_CURRENCIES.has(currency)) {
      throw new BadRequestException(`currency должен быть один из: ${[...VALID_CURRENCIES].join(', ')}`);
    }
    const commentRaw = (data.comment || '').trim();
    if (commentRaw.length > 200) {
      throw new BadRequestException('comment слишком длинный (макс. 200 символов)');
    }
    if (/[<>]/.test(commentRaw)) {
      throw new BadRequestException('comment не должен содержать HTML-теги');
    }
    return { min, max, amount, currency, comment: commentRaw || null };
  }

  async updatePenaltyRule(
    id: string,
    patch: {
      minLateMinutes?: number;
      maxLateMinutes?: number | null;
      amount?: number;
      currency?: string;
      isActive?: boolean;
      comment?: string;
    },
  ) {
    const exists = await this.prisma.penaltyRule.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Правило не найдено');
    // Тот же валидатор что в createPenaltyRule. Объединяем patch с
    // существующими значениями, чтобы cross-field check (max > min)
    // корректно сработал даже если patch меняет только одно поле.
    const merged = {
      minLateMinutes: patch.minLateMinutes ?? exists.minLateMinutes,
      maxLateMinutes: patch.maxLateMinutes !== undefined ? patch.maxLateMinutes : exists.maxLateMinutes,
      amount: patch.amount ?? exists.amount,
      currency: patch.currency ?? exists.currency,
      comment: patch.comment ?? exists.comment ?? '',
    };
    const clean = this.validatePenaltyRuleFields(merged);
    return this.prisma.penaltyRule.update({
      where: { id },
      data: {
        ...(patch.minLateMinutes !== undefined && { minLateMinutes: clean.min }),
        ...(patch.maxLateMinutes !== undefined && { maxLateMinutes: clean.max }),
        ...(patch.amount !== undefined && { amount: clean.amount }),
        ...(patch.currency !== undefined && { currency: clean.currency }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        ...(patch.comment !== undefined && { comment: clean.comment }),
      },
    });
  }

  async deletePenaltyRule(id: string) {
    await this.prisma.penaltyRule.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Подобрать активное правило для конкретного опоздания (в минутах).
   * Используется PenaltiesService вместо хардкода. Возвращает null если
   * правил нет (тогда штраф не начисляется).
   */
  async findPenaltyForLate(lateMinutes: number) {
    const rules = await this.prisma.penaltyRule.findMany({
      where: { isActive: true },
      orderBy: { minLateMinutes: 'desc' },
    });
    // Берём первое (по убыванию) правило, у которого minLateMinutes <= late
    // и (maxLateMinutes IS NULL OR late < maxLateMinutes).
    return rules.find((r) =>
      lateMinutes >= r.minLateMinutes &&
      (r.maxLateMinutes === null || lateMinutes < r.maxLateMinutes),
    ) || null;
  }

  // ===== Work Location =====

  async getActiveLocation() {
    return this.prisma.workLocation.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listLocations() {
    return this.prisma.workLocation.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createLocation(data: {
    name?: string;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  }) {
    const clean = this.validateWorkLocationFields(data);
    // Деактивируем предыдущие активные — активная только одна.
    await this.prisma.workLocation.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });
    return this.prisma.workLocation.create({
      data: {
        name: clean.name,
        latitude: clean.lat,
        longitude: clean.lng,
        radiusMeters: clean.radius,
        isActive: true,
      },
    });
  }

  /**
   * Валидация полей рабочей локации. Раньше controller принимал
   * `body: any`, и service делал только lat/lng range. Не хватало:
   *   - name length cap + HTML guard (попадает в audit logs)
   *   - radius upper bound (1М метров = весь континент = clockIn
   *     везде проходит)
   */
  private validateWorkLocationFields(data: {
    name?: string;
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
  }): { name: string; lat: number; lng: number; radius: number } {
    const lat = Number(data.latitude);
    const lng = Number(data.longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new BadRequestException('Широта некорректна');
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new BadRequestException('Долгота некорректна');
    }
    // 20м — минимум для GPS-точности, 10км — разумный максимум
    // (больше = смысл гео-проверки теряется).
    const radius = Math.max(20, Math.min(10_000, Math.floor(Number(data.radiusMeters) || 150)));
    const nameRaw = (data.name || '').trim();
    if (nameRaw.length > 100) {
      throw new BadRequestException('Название локации слишком длинное (макс. 100 символов)');
    }
    if (/[<>]/.test(nameRaw)) {
      throw new BadRequestException('Название локации не должно содержать HTML-теги');
    }
    return { name: nameRaw || 'Главный офис', lat, lng, radius };
  }

  async updateLocation(
    id: string,
    patch: { name?: string; latitude?: number; longitude?: number; radiusMeters?: number; isActive?: boolean },
  ) {
    const exists = await this.prisma.workLocation.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Локация не найдена');
    if (patch.isActive === true) {
      await this.prisma.workLocation.updateMany({
        where: { isActive: true, id: { not: id } },
        data: { isActive: false },
      });
    }
    // Тот же validator что в createLocation. Объединяем patch с
    // существующими значениями для cross-field range check.
    const merged = {
      name: patch.name ?? exists.name,
      latitude: patch.latitude ?? exists.latitude,
      longitude: patch.longitude ?? exists.longitude,
      radiusMeters: patch.radiusMeters ?? exists.radiusMeters,
    };
    const clean = this.validateWorkLocationFields(merged);
    return this.prisma.workLocation.update({
      where: { id },
      data: {
        ...(patch.name !== undefined && { name: clean.name }),
        ...(patch.latitude !== undefined && { latitude: clean.lat }),
        ...(patch.longitude !== undefined && { longitude: clean.lng }),
        ...(patch.radiusMeters !== undefined && { radiusMeters: clean.radius }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      },
    });
  }

  async deleteLocation(id: string) {
    await this.prisma.workLocation.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Эффективный график на конкретный день для конкретного сотрудника.
   * Логика: личный (userId=userId) → если не задан, компанийский default
   * (userId=null) → если и того нет, хардкодный fallback (09:00-18:00,
   * обед 12:00-13:00, будний день).
   *
   * Это сердце привязки графиков из ТЗ §3 к реальной фиксации lateMinutes
   * в time-tracking — без этого графики хранятся в БД но никак не влияют
   * на clockIn.
   */
  async getEffectiveScheduleForUser(userId: string, weekday: Weekday): Promise<{
    isWorkday: boolean;
    startMinute: number;
    endMinute: number;
    lunchStartMinute: number | null;
    lunchEndMinute: number | null;
  }> {
    // findUnique с compound (userId, weekday) работает для не-null userId.
    const personal = await this.prisma.workSchedule.findFirst({
      where: { userId, weekday },
    });
    if (personal) {
      return {
        isWorkday: personal.isWorkday,
        startMinute: personal.startMinute,
        endMinute: personal.endMinute,
        lunchStartMinute: personal.lunchStartMinute,
        lunchEndMinute: personal.lunchEndMinute,
      };
    }
    // КРИТИЧНО: для null userId (компанийского дефолта) Prisma findUnique
    // с null в compound unique возвращает null даже если запись есть.
    // Поэтому ОБЯЗАТЕЛЬНО findFirst({userId: null}) — иначе компанийский
    // график из БД не находится и clockIn проваливается в hardcode 09:00.
    const companyDefault = await this.prisma.workSchedule.findFirst({
      where: { userId: null, weekday },
    });
    if (companyDefault) {
      return {
        isWorkday: companyDefault.isWorkday,
        startMinute: companyDefault.startMinute,
        endMinute: companyDefault.endMinute,
        lunchStartMinute: companyDefault.lunchStartMinute,
        lunchEndMinute: companyDefault.lunchEndMinute,
      };
    }
    // Hardcoded fallback — стандартная 5-дневная неделя 09:00-18:00,
    // обед 12:00-13:00. Применяется если никаких графиков ещё не задано.
    return {
      isWorkday: weekday !== 'SAT' && weekday !== 'SUN',
      startMinute: 540,
      endMinute: 1080,
      lunchStartMinute: 720,
      lunchEndMinute: 780,
    };
  }

  /**
   * Дистанция в метрах между двумя точками (haversine). Используется
   * time-tracking для проверки радиуса при clock-in.
   */
  static distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}
