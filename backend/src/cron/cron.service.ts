import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PenaltiesService } from '../penalties/penalties.service';

const TASK_OVERDUE_PENALTY_USD = 10; // ТЗ §3.9: «Нарушение → штраф» за просроченную задачу

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private penalties: PenaltiesService,
  ) {}

  /**
   * Каждый рабочий день в 22:00 — генерируем штрафы за опоздания
   * за этот день. По ТЗ §3.9: «Нарушение → штраф».
   */
  @Cron('0 22 * * 1-5', { timeZone: 'Asia/Dushanbe' })
  async autoLatePenalties() {
    this.logger.log('Cron: autoLatePenalties');
    const today = new Date();
    const result = await this.penalties.generateLatePenaltiesForDate(today);
    this.logger.log(`Created ${result.created} penalties from ${result.scanned} late entries`);
  }

  /**
   * Каждый рабочий день в 09:30 — проверяем кто опоздал > 15 минут
   * и кто вообще не пришёл. Шлём уведомление админам.
   */
  @Cron('30 9 * * 1-5', { timeZone: 'Asia/Dushanbe' })
  async checkLateArrivals() {
    this.logger.log('Cron: checkLateArrivals');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const employees = await this.prisma.user.findMany({
      where: { role: { in: ['EMPLOYEE', 'ACCOUNTANT'] } },
      select: { id: true, fullName: true },
    });
    const todayEntries = await this.prisma.timeEntry.findMany({
      where: { clockIn: { gte: today, lt: tomorrow } },
    });
    const presentIds = new Set(todayEntries.map((e) => e.userId));

    for (const emp of employees) {
      const entry = todayEntries.find((e) => e.userId === emp.id);
      if (entry && entry.lateMinutes > 15) {
        await this.notifications.notifyAdmins({
          type: 'EMPLOYEE_LATE',
          title: '⏰ Опоздание',
          message: `${emp.fullName} опоздал на ${entry.lateMinutes} мин.`,
          payload: { userId: emp.id, lateMinutes: entry.lateMinutes },
        });
      } else if (!presentIds.has(emp.id)) {
        await this.notifications.notifyAdmins({
          type: 'EMPLOYEE_ABSENT',
          title: '🚫 Не на работе',
          message: `${emp.fullName} ещё не отметился на работе`,
          payload: { userId: emp.id },
        });
      }
    }
  }

  /**
   * Каждый день в 18:00 — кто забыл нажать "Закончить день".
   */
  @Cron('0 18 * * 1-5', { timeZone: 'Asia/Dushanbe' })
  async remindClockOut() {
    this.logger.log('Cron: remindClockOut');
    const open = await this.prisma.timeEntry.findMany({
      where: { status: { in: ['WORKING', 'ON_LUNCH'] } },
      include: { user: { select: { id: true, fullName: true } } },
    });
    for (const e of open) {
      await this.notifications.notifyUser(e.userId, {
        type: 'CLOCKOUT_REMINDER',
        title: '🌙 Не забудь отметить уход',
        message: 'Рабочий день заканчивается. Нажми «Закончить день» в разделе «Время».',
        payload: { entryId: e.id },
      });
    }
  }

  /**
   * Каждый час — напоминание о приближающемся дедлайне (за 24ч)
   * + уведомление о просрочке. Идемпотентно через флаги в Task.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async deadlineReminders() {
    this.logger.log('Cron: deadlineReminders');
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // 1) Напомнить за 24 часа до дедлайна (один раз)
    const upcoming = await this.prisma.task.findMany({
      where: {
        status: { in: ['TODO', 'IN_PROGRESS'] },
        deadline: { lte: in24h, gt: now },
        deadlineReminderSent: false,
      },
      include: { assignedTo: { select: { id: true, fullName: true } } },
    });
    for (const t of upcoming) {
      await this.notifications.notifyUser(t.assignedToId, {
        type: 'TASK_DEADLINE_SOON',
        title: '⏳ Дедлайн через 24 часа',
        message: `«${t.title}» — закрой или попроси перенос.`,
        payload: { taskId: t.id, deadline: t.deadline },
      });
      await this.prisma.task.update({
        where: { id: t.id },
        data: { deadlineReminderSent: true },
      });
    }

    // 2) Уведомить о просрочке (один раз)
    const overdue = await this.prisma.task.findMany({
      where: {
        status: { in: ['TODO', 'IN_PROGRESS'] },
        deadline: { lt: now },
        overdueNotified: false,
      },
    });
    for (const t of overdue) {
      await this.notifications.notifyUser(t.assignedToId, {
        type: 'TASK_OVERDUE',
        title: '🔴 Задача просрочена',
        message: `«${t.title}» — дедлайн прошёл. Применён штраф $${TASK_OVERDUE_PENALTY_USD}.`,
        payload: { taskId: t.id, deadline: t.deadline },
      });
      // Уведомляем и админов
      await this.notifications.notifyAdmins({
        type: 'TASK_OVERDUE_ADMIN',
        title: '🔴 Задача просрочена сотрудником',
        message: `«${t.title}»`,
        payload: { taskId: t.id, assignedToId: t.assignedToId },
      });
      // ТЗ §3.9: «Нарушение → штраф». Создаём Penalty для нарушителя.
      await this.penalties.createManual(t.assignedToId, {
        reason: 'TASK_OVERDUE',
        amount: TASK_OVERDUE_PENALTY_USD,
        details: `Просроченная задача: «${t.title}»`,
      });
      await this.prisma.task.update({
        where: { id: t.id },
        data: { overdueNotified: true },
      });
    }
  }

  /**
   * Каждое утро в 09:00 — напоминание о просроченных/висящих задачах.
   */
  @Cron('0 9 * * 1-5', { timeZone: 'Asia/Dushanbe' })
  async remindOpenTasks() {
    this.logger.log('Cron: remindOpenTasks');
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const stale = await this.prisma.task.findMany({
      where: {
        status: { in: ['TODO', 'IN_PROGRESS'] },
        updatedAt: { lt: threeDaysAgo },
      },
      include: { assignedTo: { select: { id: true, fullName: true } } },
    });

    for (const t of stale) {
      await this.notifications.notifyUser(t.assignedToId, {
        type: 'TASK_REMINDER',
        title: '📋 Задача висит уже 3+ дня',
        message: `«${t.title}» — обнови статус или закрой.`,
        payload: { taskId: t.id },
      });
    }
  }

  /**
   * Каждый понедельник в 09:30 — напоминание о незакрытых заявках
   * без активности более 7 дней.
   */
  @Cron(CronExpression.EVERY_WEEK)
  async stalePipeline() {
    this.logger.log('Cron: stalePipeline');
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const stale = await this.prisma.application.findMany({
      where: {
        status: { notIn: ['ENROLLED', 'COMPLETED'] },
        updatedAt: { lt: weekAgo },
        managerId: { not: null },
      },
      include: { manager: { select: { id: true, fullName: true } } },
    });

    for (const app of stale) {
      if (!app.managerId) continue;
      await this.notifications.notifyUser(app.managerId, {
        type: 'APPLICATION_STALE',
        title: '📥 Заявка без движения 7+ дней',
        message: `${app.fullName} — обнови статус или свяжись с клиентом.`,
        payload: { applicationId: app.id },
      });
    }
  }
}
