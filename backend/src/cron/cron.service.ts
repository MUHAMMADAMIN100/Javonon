import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

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
