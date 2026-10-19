import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Weekday } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { hasPermission, isElevated, isFounder } from '../auth/role-utils';
import { tjLocalDay, tjStartOfDay } from '../common/tj-time';
import {
  diaryFirstDay,
  diaryFromFor,
  diaryLastDay,
  diaryWindow,
  isWorkdayKey,
  taskDiaryDays,
  weekdayOfKey,
  workdayEnd,
  type WeekSchedule,
  type WriteBlock,
} from './task-diary';

/** За сколько до конца рабочего дня напоминать о пустой записи. */
const REMIND_BEFORE_MS = 60 * 60_000;
const REMINDER_TYPE = 'TASK_DIARY_REMINDER';
const TEXT_MAX = 2000;

/**
 * Видит и ведёт все задачи, а не только свои: руководство по должности;
 * сотрудник с ролью — с «Задачи — все, не только свои».
 */
export function seesAllTasks(user: any): boolean {
  if (isFounder(user)) return true;
  if (user?.hasCustomRole) return hasPermission(user, 'tasks:all');
  return isElevated(user);
}

type TaskPeople = {
  assignedToId: string | null;
  controllerId: string | null;
  createdById?: string | null;
  assignees?: Array<{ id: string }>;
};

/** Исполнитель задачи (список исполнителей или старое одиночное поле). */
export function isTaskAssignee(task: TaskPeople, userId: string): boolean {
  return task.assignedToId === userId || !!task.assignees?.some((a) => a.id === userId);
}

/** Кто видит задачу (и её дневник): все задачи — руководство; иначе исполнитель, контролёр, автор. */
export function canSeeTask(task: TaskPeople, user: any): boolean {
  if (!user) return false;
  return (
    seesAllTasks(user) ||
    isTaskAssignee(task, user.id) ||
    task.controllerId === user.id ||
    (!!task.createdById && task.createdById === user.id)
  );
}

const WRITE_BLOCK_MESSAGE: Record<WriteBlock, string> = {
  'no-deadline': 'У задачи нет дедлайна — дневника у неё нет',
  done: 'Задача выполнена — дневник закрыт',
  'not-started': 'Дневник задачи ещё не начался',
  'after-deadline': 'Срок задачи прошёл — дневник закрыт',
  'day-off': 'Сегодня нерабочий день по графику — записи нет',
  'day-closed': 'Рабочий день закончился — запись за сегодня закрыта',
};

/** off — день не рабочий для дневника (попал в таблицу только из-за чьей-то записи). */
export type DiaryCellState = 'written' | 'open' | 'missed' | 'future' | 'done' | 'off';

/**
 * Дневник задачи (как дневник ДЗ): что исполнители сделали по рабочим дням
 * с постановки по дедлайн. Правила дней и окна записи — tasks/task-diary.ts.
 */
@Injectable()
export class TaskDiaryService {
  private readonly logger = new Logger(TaskDiaryService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private realtime: RealtimeGateway,
  ) {}

  /** График компании по дням недели (Настройки → График работы; нет — Пн–Пт 09:00–18:00). */
  async weekSchedule(): Promise<WeekSchedule> {
    const rows = await this.settings.getSchedule(null);
    const out = {} as WeekSchedule;
    for (const r of rows) out[r.weekday as Weekday] = { isWorkday: r.isWorkday, endMinute: r.endMinute };
    return out;
  }

  /** Первый день дневника для дедлайна, поставленного сейчас. */
  async diaryFromNow(): Promise<string> {
    return diaryFromFor(new Date(), await this.weekSchedule());
  }

  /** Таблица «исполнители × дни» и что можно мне. Видит тот, кто видит задачу. */
  async view(taskId: string, user: any) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assignees: { select: { id: true, fullName: true, isActive: true } },
        assignedTo: { select: { id: true, fullName: true, isActive: true } },
      },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (!canSeeTask(task, user)) throw new ForbiddenException('Это не ваша задача');
    if (!task.deadline) return { enabled: false as const };

    const sched = await this.weekSchedule();
    const now = new Date();
    const win = diaryWindow(task, sched, now);
    const logs = await this.prisma.taskLog.findMany({
      where: { taskId },
      select: { userId: true, day: true, text: true, createdAt: true, updatedAt: true },
    });
    // Дни дневника + дни, за которые запись уже есть (график или срок с тех пор
    // поменяли — написанное не пропадает; остальным такой день не пропуск).
    const diaryDays = new Set(taskDiaryDays(task, sched));
    const days = [...new Set([...diaryDays, ...logs.map((l) => l.day)])].sort();
    const people = [...task.assignees];
    if (task.assignedTo && !people.some((p) => p.id === task.assignedTo!.id)) people.unshift(task.assignedTo);
    // Строки — по алфавиту: порядок исполнителей в базе не задан.
    people.sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
    const byKey = new Map(logs.map((l) => [`${l.userId}|${l.day}`, l]));
    const doneDay = task.status === 'DONE' && task.doneAt ? tjLocalDay(task.doneAt) : null;

    const cell = (userId: string, day: string) => {
      const log = byKey.get(`${userId}|${day}`);
      if (log) return { state: 'written' as DiaryCellState, text: log.text, createdAt: log.createdAt, updatedAt: log.updatedAt };
      if (!diaryDays.has(day)) return { state: 'off' as DiaryCellState };
      if (day > win.today) return { state: 'future' as DiaryCellState };
      if (doneDay && day >= doneDay) return { state: 'done' as DiaryCellState };
      if (day === win.today && win.open) return { state: 'open' as DiaryCellState };
      return { state: 'missed' as DiaryCellState };
    };

    const isAssignee = people.some((p) => p.id === user.id);
    return {
      enabled: true as const,
      from: diaryFirstDay(task),
      lastDay: diaryLastDay(task),
      today: win.today,
      days: days.map((day) => ({ day, weekday: weekdayOfKey(day) })),
      rows: people.map((p) => ({
        user: { id: p.id, fullName: p.fullName, isActive: p.isActive },
        cells: Object.fromEntries(days.map((day) => [day, cell(p.id, day)])),
      })),
      me: {
        isAssignee,
        canWrite: isAssignee && win.open,
        // Отсчёт «до конца рабочего дня» — момент закрытия сегодняшней записи.
        closesAt: win.closesAt,
        block: isAssignee ? win.block : null,
        todayText: isAssignee ? byKey.get(`${user.id}|${win.today}`)?.text ?? null : null,
      },
    };
  }

  /** Запись исполнителя за сегодня: только в окне до конца рабочего дня; повторная — правка. */
  async write(taskId: string, user: any, rawText: unknown) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw new BadRequestException('Напишите, что вы сделали за день');
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true, deadline: true, diaryFrom: true, doneAt: true, status: true,
        assignedToId: true, controllerId: true, assignees: { select: { id: true } },
      },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (!isTaskAssignee(task, user.id)) {
      throw new ForbiddenException('Писать в дневник задачи могут только её исполнители');
    }
    const win = diaryWindow(task, await this.weekSchedule());
    if (!win.open) throw new BadRequestException(WRITE_BLOCK_MESSAGE[win.block ?? 'day-closed']);

    const saved = await this.prisma.taskLog.upsert({
      where: { taskId_userId_day: { taskId, userId: user.id, day: win.today } },
      create: { taskId, userId: user.id, day: win.today, text: text.slice(0, TEXT_MAX) },
      update: { text: text.slice(0, TEXT_MAX) },
      select: { day: true, text: true, createdAt: true, updatedAt: true },
    });
    this.realtime.emitStaff('task:diary', { taskId, userId: user.id, day: win.today });
    return { ...saved, closesAt: win.closesAt };
  }

  /**
   * Моя запись за сегодня по задачам списка: 'open' — ещё не написал (идёт
   * отсчёт до конца рабочего дня), 'written' — написал (можно поправить до
   * closesAt). Задачам без открытого сегодня дневника — null.
   */
  async myToday<T extends { id: string; deadline: Date | null; diaryFrom: string | null; doneAt: Date | null; status: string; assignedToId: string | null; assignees?: Array<{ id: string }> }>(
    tasks: T[],
    userId: string,
  ): Promise<Map<string, { state: 'open' | 'written'; closesAt: Date }>> {
    const out = new Map<string, { state: 'open' | 'written'; closesAt: Date }>();
    const mine = tasks.filter((t) => t.deadline && t.status !== 'DONE' && isTaskAssignee(t as any, userId));
    if (!mine.length) return out;
    const sched = await this.weekSchedule();
    const now = new Date();
    const open = mine
      .map((t) => ({ t, win: diaryWindow(t, sched, now) }))
      .filter((x) => x.win.open);
    if (!open.length) return out;
    const written = new Set(
      (
        await this.prisma.taskLog.findMany({
          where: { userId, day: tjLocalDay(now), taskId: { in: open.map((x) => x.t.id) } },
          select: { taskId: true },
        })
      ).map((l) => l.taskId),
    );
    for (const { t, win } of open) {
      out.set(t.id, { state: written.has(t.id) ? 'written' : 'open', closesAt: win.closesAt! });
    }
    return out;
  }

  /**
   * За час до конца рабочего дня — одно уведомление сотруднику со списком
   * задач, где у него нет записи за сегодня. Раз в день (проверка по уже
   * отправленным уведомлениям этого типа).
   */
  @Cron('* * * * *', { timeZone: 'Asia/Dushanbe' })
  async remindToday() {
    try {
      const now = new Date();
      const sched = await this.weekSchedule();
      const today = tjLocalDay(now);
      if (!isWorkdayKey(today, sched)) return;
      const left = workdayEnd(today, sched).getTime() - now.getTime();
      // Рабочий день уже кончился или до конца больше часа — не время.
      if (left <= 0 || left > REMIND_BEFORE_MS) return;

      const tasks = await this.prisma.task.findMany({
        where: { deadline: { not: null }, status: { not: 'DONE' } },
        select: {
          id: true, title: true, deadline: true, diaryFrom: true, doneAt: true, status: true,
          assignedTo: { select: { id: true, isActive: true } },
          assignees: { select: { id: true, isActive: true } },
        },
      });
      const open = tasks.filter((t) => diaryWindow(t, sched, now).open);
      if (!open.length) return;
      const logs = await this.prisma.taskLog.findMany({
        where: { day: today, taskId: { in: open.map((t) => t.id) } },
        select: { taskId: true, userId: true },
      });
      const wrote = new Set(logs.map((l) => `${l.taskId}|${l.userId}`));
      const byUser = new Map<string, Array<{ id: string; title: string }>>();
      for (const t of open) {
        const people = [...t.assignees, ...(t.assignedTo ? [t.assignedTo] : [])].filter((p) => p.isActive);
        for (const uid of new Set(people.map((p) => p.id))) {
          if (wrote.has(`${t.id}|${uid}`)) continue;
          if (!byUser.has(uid)) byUser.set(uid, []);
          byUser.get(uid)!.push({ id: t.id, title: t.title });
        }
      }
      if (!byUser.size) return;
      const already = await this.prisma.notification.findMany({
        where: { type: REMINDER_TYPE, createdAt: { gte: tjStartOfDay(now) }, userId: { in: [...byUser.keys()] } },
        select: { userId: true },
      });
      const sent = new Set(already.map((n) => n.userId));
      for (const [uid, list] of byUser) {
        if (sent.has(uid)) continue;
        const names = list.slice(0, 3).map((t) => `«${t.title}»`).join(', ');
        const more = list.length > 3 ? ` и ещё ${list.length - 3}` : '';
        await this.notifications.notifyUser(uid, {
          type: REMINDER_TYPE,
          title: 'Запишите, что сделали за день',
          message: `До конца рабочего дня меньше часа. Задачи: ${names}${more}`,
          payload: { day: today, taskId: list[0].id, taskIds: list.map((t) => t.id) },
        });
      }
    } catch (e: any) {
      this.logger.warn(`Напоминание о дневнике задач не отправлено: ${e?.message ?? e}`);
    }
  }
}
