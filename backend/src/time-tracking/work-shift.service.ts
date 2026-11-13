import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { AbsenceKind, ExcuseStatus, Prisma, TimeBreakKind, TimeEntry, TimeEntryStatus, Weekday } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TimeTrackingService } from './time-tracking.service';
import { tjCalendarDay, tjLocalDay, tjMinutesFromMidnight } from '../common/tj-time';
import { LATE_THRESHOLD_MIN } from '../penalties/penalties.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Рабочая смена «как в Sabt» (13.11.2026): кнопка «Начать работу» в меню,
 * карточка «Моя смена» (перерыв с причиной, «Приду позже», «Поправить
 * время»), «Активность и смены» у руководителя (табель месяца, смены
 * сегодня, отгулы).
 *
 * Правила Javonon сохранены: приход — с геолокацией или фото/видео
 * (TimeTrackingService.clockIn), обед — прежний lunchOut/lunchIn со штрафом
 * за позднее возвращение, опоздания — шкала штрафов и причины опозданий.
 * Здесь — то, что добавилось сверху.
 */

const WEEKDAYS: Weekday[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as Weekday[];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

type PauseKind = 'LUNCH' | 'WORK' | 'PERSONAL';

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMinute = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Момент «день + минуты по Душанбе». */
const at = (day: string, minute: number) => new Date(`${day}T${hhmm(minute)}:00+05:00`);
const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};

interface Viewer {
  id: string;
  role?: string;
  roles?: string[];
  hasCustomRole?: boolean;
  permissions?: string[];
}

@Injectable()
export class WorkShiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeGateway,
    private readonly time: TimeTrackingService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ─── Общие расчёты ───────────────────────────────────────────────────

  private weekdayOf(day: string): Weekday {
    return WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
  }

  private async scheduleFor(userId: string, day: string) {
    return this.settings.getEffectiveScheduleForUser(userId, this.weekdayOf(day));
  }

  /** Норма дня: конец − начало − обед по графику. */
  private normOf(s: { isWorkday: boolean; startMinute: number; endMinute: number; lunchStartMinute: number | null; lunchEndMinute: number | null }) {
    if (!s.isWorkday) return 0;
    const lunch = s.lunchStartMinute != null && s.lunchEndMinute != null ? Math.max(0, s.lunchEndMinute - s.lunchStartMinute) : 0;
    return Math.max(0, s.endMinute - s.startMinute - lunch);
  }

  /** Отработано за запись: закрытая — totalMinutes, открытая — по часам сейчас. */
  workedOf(e: TimeEntry, openBreak?: { kind: TimeBreakKind; startedAt: Date } | null, now = new Date()): number {
    if (e.status === TimeEntryStatus.OFF) return e.totalMinutes;
    let minutes = minutesBetween(e.clockIn, now) - e.totalLunchMinutes - e.pausedMinutes - e.personalBreakMinutes;
    if (e.status === TimeEntryStatus.ON_LUNCH && e.lunchOut) minutes -= minutesBetween(e.lunchOut, now);
    if (e.status === TimeEntryStatus.ON_BREAK && openBreak?.kind === TimeBreakKind.PERSONAL) minutes -= minutesBetween(openBreak.startedAt, now);
    return Math.max(0, minutes);
  }

  /** Опоздание считается, если оно не меньше порога шкалы и не прощено. */
  private isLate(e: Pick<TimeEntry, 'lateMinutes' | 'lateExcuseStatus'>) {
    return e.lateMinutes >= LATE_THRESHOLD_MIN && e.lateExcuseStatus !== ExcuseStatus.APPROVED;
  }

  canViewTeam(u: Viewer): boolean {
    if (u.role === 'FOUNDER' || u.roles?.includes('FOUNDER')) return true;
    return !!u.hasCustomRole && !!u.permissions?.includes('attendance:read');
  }

  canDecide(u: Viewer): boolean {
    if (u.role === 'FOUNDER' || u.roles?.includes('FOUNDER')) return true;
    return !!u.hasCustomRole && !!u.permissions?.some((p) => p === 'excuses:approve' || p === 'attendance:manage');
  }

  private assertTeam(u: Viewer) {
    if (!this.canViewTeam(u)) throw new ForbiddenException('Нет доступа к сменам команды');
  }

  private assertDecide(u: Viewer) {
    if (!this.canDecide(u)) throw new ForbiddenException('Решать может основатель или сотрудник с правом «Причины опозданий — одобрение»');
  }

  /** Кого показывать в сменах: сотрудники, кроме основателя и учителей академии. */
  private async people(extraIds: string[] = []) {
    const users = await this.prisma.user.findMany({
      where: { OR: [{ isActive: true }, { id: { in: extraIds } }] },
      select: { id: true, fullName: true, role: true, roles: true, isActive: true, customRole: { select: { name: true, isActive: true } } },
      orderBy: { fullName: 'asc' },
    });
    return users.filter((u) => {
      const roles = new Set([u.role, ...(u.roles ?? [])]);
      if (roles.has('FOUNDER' as any)) return false;
      if (roles.size === 1 && roles.has('TEACHER' as any)) return false;
      return true;
    });
  }

  private personOf(u: { id: string; fullName: string; role: string; customRole: { name: string; isActive: boolean } | null; isActive: boolean }) {
    return {
      id: u.id,
      name: u.fullName,
      role: u.role,
      position: u.customRole && u.customRole.isActive !== false ? u.customRole.name : null,
      isActive: u.isActive,
    };
  }

  // ─── Моя смена ───────────────────────────────────────────────────────

  async my(userId: string) {
    const now = new Date();
    const today = tjLocalDay(now);
    const entry = await this.prisma.timeEntry.findFirst({
      where: { userId, OR: [{ status: { not: TimeEntryStatus.OFF } }, { clockIn: { gte: at(today, 0) } }] },
      orderBy: { clockIn: 'desc' },
      include: { breaks: { orderBy: { startedAt: 'asc' } } },
    });
    const sched = await this.scheduleFor(userId, today);
    const openBreak = entry?.breaks.find((b) => !b.endedAt) ?? null;
    let state: 'idle' | 'working' | 'lunch' | 'break' = 'idle';
    let since: Date | null = null;
    if (entry && entry.status === TimeEntryStatus.WORKING) {
      state = 'working';
      const lastBack = [entry.lunchIn, ...entry.breaks.map((b) => b.endedAt)].filter(Boolean) as Date[];
      since = lastBack.length ? new Date(Math.max(entry.clockIn.getTime(), ...lastBack.map((d) => d.getTime()))) : entry.clockIn;
    } else if (entry && entry.status === TimeEntryStatus.ON_LUNCH) {
      state = 'lunch';
      since = entry.lunchOut;
    } else if (entry && entry.status === TimeEntryStatus.ON_BREAK) {
      state = 'break';
      since = openBreak?.startedAt ?? null;
    }
    const breaks = [
      ...(entry?.lunchOut ? [{ kind: 'LUNCH', from: entry.lunchOut, to: entry.status === TimeEntryStatus.ON_LUNCH ? null : entry.lunchIn }] : []),
      ...(entry?.breaks ?? []).map((b) => ({ kind: b.kind, from: b.startedAt, to: b.endedAt })),
    ]
      .sort((a, b) => a.from.getTime() - b.from.getTime())
      .map((b) => ({
        kind: b.kind,
        from: b.from.toISOString(),
        to: b.to ? b.to.toISOString() : null,
        minutes: minutesBetween(b.from, b.to ?? now),
        // Обед — по графику идёт в зачёт, «по работе» — тоже; «личное» — нет.
        paid: b.kind !== 'PERSONAL',
      }));

    const [notices, edits, week] = await Promise.all([
      this.prisma.lateNotice.findMany({ where: { userId }, orderBy: { date: 'desc' }, take: 5 }),
      this.prisma.shiftEditRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 5 }),
      this.weekOf(userId, today),
    ]);
    return {
      state,
      pauseKind: state === 'lunch' ? 'LUNCH' : state === 'break' ? openBreak?.kind ?? null : null,
      since: since ? since.toISOString() : null,
      entryId: entry?.id ?? null,
      startedAt: entry ? entry.clockIn.toISOString() : null,
      endedAt: entry?.clockOut ? entry.clockOut.toISOString() : null,
      autoClosed: !!entry?.autoClosed,
      workedMinutes: entry ? this.workedOf(entry, openBreak, now) : 0,
      norm: { isWorkday: sched.isWorkday, start: hhmm(sched.startMinute), end: hhmm(sched.endMinute), minutes: this.normOf(sched) },
      isLate: !!entry && this.isLate(entry),
      lateMinutes: entry?.lateMinutes ?? 0,
      // Опоздание без причины: карточка зовёт объяснить его (правило Javonon).
      needsExcuse: !!entry && entry.lateMinutes >= LATE_THRESHOLD_MIN && !entry.lateExcuseAt,
      breaks,
      notices: notices.map((n) => this.noticeView(n)),
      edits: edits.map((r) => this.editView(r)),
      week,
      today,
    };
  }

  /** Последние 7 дней (сегодня — последний): отработанные минуты по дням. */
  private async weekOf(userId: string, today: string) {
    const from = addDays(today, -6);
    const entries = await this.prisma.timeEntry.findMany({
      where: { userId, clockIn: { gte: at(from, 0), lt: at(addDays(today, 1), 0) } },
      include: { breaks: { where: { endedAt: null } } },
    });
    const byDay = new Map<string, number>();
    for (const e of entries) {
      const d = tjLocalDay(e.clockIn);
      byDay.set(d, (byDay.get(d) ?? 0) + this.workedOf(e, e.breaks[0] ?? null));
    }
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(from, i);
      return { date: d, day: Number(d.slice(8, 10)), minutes: byDay.get(d) ?? 0 };
    });
  }

  /** Перерыв с причиной: обед — прежней механикой, «по работе» и «личное» — отрезком. */
  async pause(userId: string, kind: PauseKind) {
    if (kind === 'LUNCH') {
      await this.time.lunchOut(userId);
      return this.my(userId);
    }
    if (kind !== 'WORK' && kind !== 'PERSONAL') throw new BadRequestException('Выберите причину перерыва');
    const active = await this.time.getActive(userId);
    if (!active) throw new NotFoundException('Смена не начата');
    if (active.status !== TimeEntryStatus.WORKING) throw new BadRequestException('Вы уже на перерыве');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.timeBreak.create({ data: { entryId: active.id, userId, kind, startedAt: now } }),
      this.prisma.timeEntry.update({ where: { id: active.id }, data: { status: TimeEntryStatus.ON_BREAK } }),
    ]);
    this.realtime.emitStaff('attendance:updated', { userId, entryId: active.id, action: 'breakStart' });
    return this.my(userId);
  }

  /** «Продолжить» — после обеда или перерыва. */
  async resume(userId: string) {
    const active = await this.time.getActive(userId);
    if (!active) throw new NotFoundException('Смена не начата');
    if (active.status === TimeEntryStatus.ON_LUNCH) {
      const r: any = await this.time.lunchIn(userId);
      return { ...(await this.my(userId)), requiresLunchExcuse: !!r?.requiresLunchExcuse, entryId: active.id };
    }
    if (active.status !== TimeEntryStatus.ON_BREAK) throw new BadRequestException('Вы не на перерыве');
    const personal = await this.time.closeOpenBreak(active.id, new Date());
    await this.prisma.timeEntry.update({
      where: { id: active.id },
      data: { status: TimeEntryStatus.WORKING, ...(personal ? { personalBreakMinutes: { increment: personal } } : {}) },
    });
    this.realtime.emitStaff('attendance:updated', { userId, entryId: active.id, action: 'breakEnd' });
    return this.my(userId);
  }

  // ─── «Приду позже» ───────────────────────────────────────────────────

  private noticeView(n: { id: string; userId: string; date: Date; plannedMinute: number; reason: string | null; status: ExcuseStatus; createdAt: Date }, name?: string) {
    return {
      id: n.id,
      userId: n.userId,
      ...(name ? { name } : {}),
      date: isoDay(n.date),
      plannedTime: hhmm(n.plannedMinute),
      reason: n.reason,
      status: n.status,
      createdAt: n.createdAt.toISOString(),
    };
  }

  private cleanText(v: unknown, field: string, max = 300): string | null {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new BadRequestException(`${field}: нужен текст`);
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (s.length > max) throw new BadRequestException(`${field}: не длиннее ${max} символов`);
    if (/[<>]/.test(s)) throw new BadRequestException(`${field}: нельзя использовать знаки < и >`);
    return s;
  }

  async createNotice(userId: string, body: { date?: string; time?: string; reason?: string }) {
    const today = tjLocalDay();
    const date = body?.date || today;
    if (!DATE_RE.test(date)) throw new BadRequestException('Укажите дату');
    if (date < today) throw new BadRequestException('Предупредить можно о сегодняшнем или будущем дне');
    if (date > addDays(today, 30)) throw new BadRequestException('Не дальше чем на 30 дней вперёд');
    if (!body?.time || !TIME_RE.test(body.time)) throw new BadRequestException('Укажите время прихода');
    const plannedMinute = toMinute(body.time);
    const sched = await this.scheduleFor(userId, date);
    if (!sched.isWorkday) throw new BadRequestException('Это нерабочий день по графику');
    if (plannedMinute <= sched.startMinute) throw new BadRequestException(`Рабочий день начинается в ${hhmm(sched.startMinute)} — предупреждать не нужно`);
    if (plannedMinute >= sched.endMinute) throw new BadRequestException('Время прихода — позже конца рабочего дня');
    if (date === today) {
      const started = await this.prisma.timeEntry.findFirst({ where: { userId, clockIn: { gte: at(today, 0) } } });
      if (started) throw new BadRequestException('Вы уже на работе — если опоздали, объясните причину в «Моей смене»');
    }
    const reason = this.cleanText(body.reason, 'Причина');
    const existing = await this.prisma.lateNotice.findUnique({ where: { userId_date: { userId, date: dayDate(date) } } });
    if (existing?.status === ExcuseStatus.APPROVED) throw new BadRequestException('На этот день просьба уже одобрена');
    const n = existing
      ? await this.prisma.lateNotice.update({ where: { id: existing.id }, data: { plannedMinute, reason, status: ExcuseStatus.PENDING, reviewedAt: null, reviewedById: null } })
      : await this.prisma.lateNotice.create({ data: { userId, date: dayDate(date), plannedMinute, reason } });
    this.realtime.emitStaff('shift:requests', { kind: 'notice' });
    await this.notifyDeciders('Просьба прийти позже', userId, `${date.slice(8, 10)}.${date.slice(5, 7)} — приду в ${body.time}${reason ? ` · ${reason}` : ''}`);
    return this.noticeView(n);
  }

  async myNotices(userId: string) {
    const rows = await this.prisma.lateNotice.findMany({ where: { userId }, orderBy: { date: 'desc' }, take: 10 });
    return rows.map((n) => this.noticeView(n));
  }

  async notices(viewer: Viewer) {
    this.assertTeam(viewer);
    const rows = await this.prisma.lateNotice.findMany({
      where: { status: ExcuseStatus.PENDING, date: { gte: dayDate(tjLocalDay()) } },
      include: { user: { select: { fullName: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((n) => this.noticeView(n, n.user.fullName));
  }

  async decideNotice(id: string, approve: boolean, viewer: Viewer) {
    this.assertDecide(viewer);
    const n = await this.prisma.lateNotice.findUnique({ where: { id } });
    if (!n) throw new NotFoundException('Просьба не найдена');
    if (n.status !== ExcuseStatus.PENDING) throw new BadRequestException('По этой просьбе уже решили');
    const saved = await this.prisma.lateNotice.update({
      where: { id },
      data: { status: approve ? ExcuseStatus.APPROVED : ExcuseStatus.REJECTED, reviewedAt: new Date(), reviewedById: viewer.id },
    });
    // Сотрудник уже пришёл — пересчитываем опоздание этого дня.
    if (approve) {
      const day = isoDay(n.date);
      const entry = await this.prisma.timeEntry.findFirst({ where: { userId: n.userId, clockIn: { gte: at(day, 0), lt: at(addDays(day, 1), 0) } }, orderBy: { clockIn: 'asc' } });
      if (entry) await this.time.applyApprovedNotice(entry.id);
    }
    this.realtime.emitUser(n.userId, 'shift:decided', { kind: 'notice', id, approve });
    this.realtime.emitStaff('shift:requests', { kind: 'notice' });
    await this.notifications
      ?.notifyUser(n.userId, {
        type: 'SHIFT_NOTICE',
        title: approve ? 'Просьба прийти позже одобрена' : 'Просьба прийти позже отклонена',
        message: `${isoDay(n.date).slice(8, 10)}.${isoDay(n.date).slice(5, 7)} — в ${hhmm(n.plannedMinute)}`,
      })
      .catch(() => undefined);
    return this.noticeView(saved);
  }

  // ─── «Поправить время» ───────────────────────────────────────────────

  private editView(r: { id: string; userId: string; date: Date; field: string; requestedMinute: number; currentMinute: number | null; note: string | null; status: ExcuseStatus; createdAt: Date }, name?: string) {
    return {
      id: r.id,
      userId: r.userId,
      ...(name ? { name } : {}),
      date: isoDay(r.date),
      field: r.field,
      requestedTime: hhmm(r.requestedMinute),
      currentTime: r.currentMinute == null ? null : hhmm(r.currentMinute),
      note: r.note,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async entryOfDay(userId: string, day: string) {
    return this.prisma.timeEntry.findFirst({
      where: { userId, clockIn: { gte: at(day, 0), lt: at(addDays(day, 1), 0) } },
      orderBy: { clockIn: 'asc' },
    });
  }

  async requestEdit(userId: string, body: { date?: string; field?: string; time?: string; note?: string }) {
    const today = tjLocalDay();
    const date = body?.date || today;
    if (!DATE_RE.test(date)) throw new BadRequestException('Укажите дату');
    if (date > today) throw new BadRequestException('Поправить можно только прошедший или сегодняшний день');
    if (date < addDays(today, -31)) throw new BadRequestException('Поправить можно только последний месяц');
    if (body?.field !== 'start' && body?.field !== 'end') throw new BadRequestException('Что поправить: начало или конец');
    if (!body?.time || !TIME_RE.test(body.time)) throw new BadRequestException('Укажите время');
    const minute = toMinute(body.time);
    const entry = await this.entryOfDay(userId, date);
    if (!entry) throw new BadRequestException('В этот день смены не было — сначала нажмите «Начать работу»');
    const startMin = tjMinutesFromMidnight(entry.clockIn);
    const endMin = entry.clockOut && tjLocalDay(entry.clockOut) === date ? tjMinutesFromMidnight(entry.clockOut) : null;
    if (body.field === 'start' && endMin != null && minute >= endMin) throw new BadRequestException('Начало должно быть раньше конца смены');
    if (body.field === 'end' && minute <= startMin) throw new BadRequestException('Конец должен быть позже начала смены');
    if (date === today && minute > tjMinutesFromMidnight()) throw new BadRequestException('Это время ещё не наступило');
    const note = this.cleanText(body.note, 'Комментарий');
    // Новая просьба на то же поле того же дня заменяет прежнюю нерешённую.
    await this.prisma.shiftEditRequest.deleteMany({ where: { userId, date: dayDate(date), field: body.field, status: ExcuseStatus.PENDING } });
    const r = await this.prisma.shiftEditRequest.create({
      data: { userId, date: dayDate(date), field: body.field, requestedMinute: minute, currentMinute: body.field === 'start' ? startMin : endMin, note },
    });
    this.realtime.emitStaff('shift:requests', { kind: 'edit' });
    await this.notifyDeciders('Просьба поправить время', userId, `${date.slice(8, 10)}.${date.slice(5, 7)} · ${body.field === 'start' ? 'начало' : 'конец'} → ${body.time}`);
    return this.editView(r);
  }

  async edits(viewer: Viewer) {
    this.assertTeam(viewer);
    const rows = await this.prisma.shiftEditRequest.findMany({
      where: { status: ExcuseStatus.PENDING },
      include: { user: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.editView(r, r.user.fullName));
  }

  async decideEdit(id: string, approve: boolean, viewer: Viewer) {
    this.assertDecide(viewer);
    const r = await this.prisma.shiftEditRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Просьба не найдена');
    if (r.status !== ExcuseStatus.PENDING) throw new BadRequestException('По этой просьбе уже решили');
    if (approve) await this.applyEdit(r.userId, isoDay(r.date), r.field as 'start' | 'end', r.requestedMinute);
    const saved = await this.prisma.shiftEditRequest.update({
      where: { id },
      data: { status: approve ? ExcuseStatus.APPROVED : ExcuseStatus.REJECTED, reviewedAt: new Date(), reviewedById: viewer.id },
    });
    this.realtime.emitUser(r.userId, 'shift:decided', { kind: 'edit', id, approve });
    this.realtime.emitStaff('shift:requests', { kind: 'edit' });
    this.realtime.emitStaff('attendance:updated', { userId: r.userId, action: 'edit' });
    return this.editView(saved);
  }

  /** Применить правку: приход — пересчитать опоздание; уход — закрыть день этим временем. */
  private async applyEdit(userId: string, day: string, field: 'start' | 'end', minute: number) {
    const entry = await this.entryOfDay(userId, day);
    if (!entry) throw new BadRequestException('Смены этого дня больше нет');
    const moment = at(day, minute);
    await this.prisma.$transaction(async (tx) => {
      if (field === 'start') {
        if (entry.clockOut && moment >= entry.clockOut) throw new BadRequestException('Начало должно быть раньше конца смены');
        const sched = await this.scheduleFor(userId, day);
        const lateMinutes = sched.isWorkday ? Math.max(0, minute - sched.startMinute) : 0;
        // Штраф, начисленный по прежнему времени и ещё не учтённый в зарплате, снимаем —
        // опоздание пересчитается по новому (вечерний проход штрафов).
        await tx.penalty.deleteMany({ where: { userId, reason: 'LATE_ARRIVAL', applied: false, date: tjCalendarDay(entry.clockIn) } });
        const total = entry.status === TimeEntryStatus.OFF && entry.clockOut
          ? Math.max(0, minutesBetween(moment, entry.clockOut) - entry.totalLunchMinutes - entry.pausedMinutes - entry.personalBreakMinutes)
          : entry.totalMinutes;
        await tx.timeEntry.update({
          where: { id: entry.id },
          data: {
            clockIn: moment,
            lateMinutes,
            totalMinutes: total,
            ...(entry.lateExcuseStatus === ExcuseStatus.APPROVED ? {} : { latePenaltyApplied: lateMinutes < LATE_THRESHOLD_MIN }),
          },
        });
      } else {
        if (moment <= entry.clockIn) throw new BadRequestException('Конец должен быть позже начала смены');
        let lunch = entry.totalLunchMinutes;
        if (entry.status === TimeEntryStatus.ON_LUNCH && entry.lunchOut) lunch += minutesBetween(entry.lunchOut, moment);
        let personal = entry.personalBreakMinutes;
        if (entry.status === TimeEntryStatus.ON_BREAK) personal += await this.time.closeOpenBreak(entry.id, moment, tx);
        await tx.timeEntry.update({
          where: { id: entry.id },
          data: {
            status: TimeEntryStatus.OFF,
            clockOut: moment,
            autoClosed: false,
            totalLunchMinutes: lunch,
            personalBreakMinutes: personal,
            totalMinutes: Math.max(0, minutesBetween(entry.clockIn, moment) - lunch - entry.pausedMinutes - personal),
          },
        });
      }
    });
    if (field === 'start') await this.time.applyApprovedNotice(entry.id);
  }

  async myEdits(userId: string) {
    const rows = await this.prisma.shiftEditRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 });
    return rows.map((r) => this.editView(r));
  }

  // ─── Отгул / отпуск / больничный ─────────────────────────────────────

  async setAbsence(viewer: Viewer, body: { userId?: string; date?: string; kind?: AbsenceKind }) {
    this.assertDecide(viewer);
    if (!body?.userId) throw new BadRequestException('Кого отмечаем');
    const date = body.date || tjLocalDay();
    if (!DATE_RE.test(date)) throw new BadRequestException('Укажите дату');
    if (!body.kind || !['DAYOFF', 'VACATION', 'SICK', 'HOLIDAY'].includes(body.kind)) throw new BadRequestException('Выберите: отгул, отпуск, больничный или праздник');
    const user = await this.prisma.user.findUnique({ where: { id: body.userId }, select: { id: true } });
    if (!user) throw new NotFoundException('Сотрудник не найден');
    const row = await this.prisma.shiftAbsence.upsert({
      where: { userId_date: { userId: body.userId, date: dayDate(date) } },
      update: { kind: body.kind, createdById: viewer.id },
      create: { userId: body.userId, date: dayDate(date), kind: body.kind, createdById: viewer.id },
    });
    this.realtime.emitStaff('attendance:updated', { userId: body.userId, action: 'absence' });
    return { userId: row.userId, date: isoDay(row.date), kind: row.kind };
  }

  async removeAbsence(viewer: Viewer, userId: string, date: string) {
    this.assertDecide(viewer);
    if (!DATE_RE.test(date)) throw new BadRequestException('Укажите дату');
    await this.prisma.shiftAbsence.deleteMany({ where: { userId, date: dayDate(date) } });
    this.realtime.emitStaff('attendance:updated', { userId, action: 'absence' });
    return { ok: true };
  }

  // ─── Смены сегодня ───────────────────────────────────────────────────

  async team(viewer: Viewer) {
    this.assertTeam(viewer);
    const now = new Date();
    const today = tjLocalDay(now);
    const weekFrom = addDays(today, -6);
    const [people, entries, absences, notices] = await Promise.all([
      this.people(),
      this.prisma.timeEntry.findMany({
        where: { clockIn: { gte: at(weekFrom, 0), lt: at(addDays(today, 1), 0) } },
        include: { breaks: { where: { endedAt: null } } },
      }),
      this.prisma.shiftAbsence.findMany({ where: { date: dayDate(today) } }),
      this.prisma.lateNotice.findMany({ where: { date: dayDate(today), status: ExcuseStatus.APPROVED } }),
    ]);
    const sched = await this.scheduleFor('', today);
    const nowMin = tjMinutesFromMidnight(now);
    const items = people.map((u) => {
      const mine = entries.filter((e) => e.userId === u.id);
      const todays = mine.filter((e) => tjLocalDay(e.clockIn) === today).sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());
      const e = todays[todays.length - 1];
      const first = todays[0];
      const absence = absences.find((a) => a.userId === u.id);
      const excused = notices.some((n) => n.userId === u.id);
      let status: 'working' | 'paused' | 'closed' | 'off' | 'absent' | 'waiting';
      if (e && e.status === TimeEntryStatus.WORKING) status = 'working';
      else if (e && (e.status === TimeEntryStatus.ON_LUNCH || e.status === TimeEntryStatus.ON_BREAK)) status = 'paused';
      else if (e) status = 'closed';
      else if (absence || !sched.isWorkday) status = 'off';
      else status = nowMin < sched.startMinute ? 'waiting' : 'absent';
      return {
        ...this.personOf(u),
        status,
        pauseKind: e?.status === TimeEntryStatus.ON_LUNCH ? 'LUNCH' : e?.status === TimeEntryStatus.ON_BREAK ? e.breaks[0]?.kind ?? null : null,
        absenceKind: absence?.kind ?? null,
        startedAt: first ? first.clockIn.toISOString() : null,
        late: !!first && this.isLate(first),
        excused,
        todayMinutes: todays.reduce((s, x) => s + this.workedOf(x, x.breaks[0] ?? null, now), 0),
        weekMinutes: mine.reduce((s, x) => s + this.workedOf(x, x.breaks[0] ?? null, now), 0),
      };
    });
    return { date: today, workday: sched.isWorkday, start: hhmm(sched.startMinute), items };
  }

  // ─── Табель месяца ───────────────────────────────────────────────────

  async month(viewer: Viewer, ym?: string) {
    this.assertTeam(viewer);
    return this.buildMonth(ym);
  }

  async myMonth(userId: string, ym?: string) {
    const r = await this.buildMonth(ym, userId);
    return { ...r, item: r.items[0] ?? null };
  }

  private async buildMonth(ym?: string, onlyUserId?: string) {
    const now = new Date();
    const today = tjLocalDay(now);
    const month = typeof ym === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(ym) ? ym : today.slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const from = `${month}-01`;
    const to = addDays(`${month}-${String(daysInMonth).padStart(2, '0')}`, 1);
    const [entries, absences] = await Promise.all([
      this.prisma.timeEntry.findMany({
        where: { clockIn: { gte: at(from, 0), lt: at(to, 0) }, ...(onlyUserId ? { userId: onlyUserId } : {}) },
        include: { breaks: { orderBy: { startedAt: 'asc' } } },
        orderBy: { clockIn: 'asc' },
      }),
      this.prisma.shiftAbsence.findMany({ where: { date: { gte: dayDate(from), lt: dayDate(to) }, ...(onlyUserId ? { userId: onlyUserId } : {}) } }),
    ]);
    const extra = [...new Set(entries.map((e) => e.userId))];
    let people = await this.people(extra);
    if (onlyUserId) {
      const me = await this.prisma.user.findUnique({
        where: { id: onlyUserId },
        select: { id: true, fullName: true, role: true, roles: true, isActive: true, customRole: { select: { name: true, isActive: true } } },
      });
      people = me ? [me] : [];
    }
    const sched = await this.scheduleFor('', today);
    const items = people
      .map((u) => {
        const mine = entries.filter((e) => e.userId === u.id);
        const days: Record<number, number> = {};
        const segments: Record<number, Array<{ from: string; to: string | null; auto: boolean; minutes: number }>> = {};
        const breaks: Record<number, Array<{ kind: string; from: string; to: string | null; minutes: number }>> = {};
        const lateDays: number[] = [];
        const autoDays: number[] = [];
        for (const e of mine) {
          const d = Number(tjLocalDay(e.clockIn).slice(8, 10));
          const open = e.breaks.find((b) => !b.endedAt) ?? null;
          const worked = this.workedOf(e, open, now);
          days[d] = (days[d] ?? 0) + worked;
          (segments[d] ||= []).push({
            from: hhmm(tjMinutesFromMidnight(e.clockIn)),
            to: e.clockOut ? hhmm(tjMinutesFromMidnight(e.clockOut)) : null,
            auto: e.autoClosed,
            minutes: worked,
          });
          const list = (breaks[d] ||= []);
          if (e.lunchOut) {
            const end = e.status === TimeEntryStatus.ON_LUNCH ? null : e.lunchIn;
            list.push({ kind: 'LUNCH', from: hhmm(tjMinutesFromMidnight(e.lunchOut)), to: end ? hhmm(tjMinutesFromMidnight(end)) : null, minutes: e.totalLunchMinutes });
          }
          for (const b of e.breaks) {
            list.push({ kind: b.kind, from: hhmm(tjMinutesFromMidnight(b.startedAt)), to: b.endedAt ? hhmm(tjMinutesFromMidnight(b.endedAt)) : null, minutes: b.endedAt ? b.minutes : minutesBetween(b.startedAt, now) });
          }
          if (this.isLate(e) && !lateDays.includes(d) && mine.filter((x) => tjLocalDay(x.clockIn) === tjLocalDay(e.clockIn))[0]?.id === e.id) lateDays.push(d);
          if (e.autoClosed && !autoDays.includes(d)) autoDays.push(d);
        }
        const absence: Record<number, AbsenceKind> = {};
        for (const a of absences.filter((x) => x.userId === u.id)) absence[Number(isoDay(a.date).slice(8, 10))] = a.kind;
        const workedDays = Object.values(days).filter((v) => v > 0).length;
        const totalMinutes = Object.values(days).reduce((s, v) => s + v, 0);
        return {
          ...this.personOf(u),
          days,
          segments,
          breaks,
          lateDays,
          autoDays,
          absence,
          workedDays,
          totalMinutes,
          avgMinutes: workedDays ? Math.round(totalMinutes / workedDays) : 0,
        };
      })
      .sort((a, b) => b.totalMinutes - a.totalMinutes || a.name.localeCompare(b.name, 'ru'));
    return {
      month,
      daysInMonth,
      today,
      workStart: hhmm(sched.startMinute),
      lateAfter: hhmm(sched.startMinute + LATE_THRESHOLD_MIN),
      items,
    };
  }

  // ─── Уведомления руководителям ───────────────────────────────────────

  private async notifyDeciders(title: string, userId: string, message: string) {
    if (!this.notifications) return;
    try {
      const who = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      const deciders = await this.prisma.user.findMany({
        where: {
          isActive: true,
          OR: [
            { role: 'FOUNDER' as any },
            { roles: { has: 'FOUNDER' as any } },
            { customRole: { isActive: true, permissions: { hasSome: ['excuses:approve', 'attendance:manage'] } } },
          ],
        },
        select: { id: true },
      });
      for (const d of deciders) {
        await this.notifications.notifyUser(d.id, { type: 'SHIFT_REQUEST', title, message: `${who?.fullName ?? ''}: ${message}`, payload: { link: '/workday?tab=today' } });
      }
    } catch {
      /* уведомление — не причина ронять просьбу */
    }
  }
}
