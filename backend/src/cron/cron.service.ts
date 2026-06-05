import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PenaltiesService } from '../penalties/penalties.service';
import { SmsService } from '../sms/sms.service';

const TASK_OVERDUE_PENALTY_USD = 10; // ТЗ §3.9: «Нарушение → штраф» за просроченную задачу

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private penalties: PenaltiesService,
    private sms: SmsService,
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

    // Все, кто отмечается по графику: ADMIN/ACCOUNTANT/SALES_MANAGER/
    // CLIENT_MANAGER. FOUNDER не пингуем — он не в общем графике.
    const employees = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER'] } },
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

  /**
   * 1-го числа каждого месяца в 06:00 — авто-повышение KPI.
   * Для сотрудников с включённым шагом (kpiAutoStepPct > 0) поднимаем
   * план продаж на этот шаг, но не выше kpiMaxPct. По ТЗ: «со временем
   * повышать KPI — у нас уже большой поток лидов».
   */
  @Cron('0 6 1 * *', { timeZone: 'Asia/Dushanbe' })
  async kpiMonthlyIncrease() {
    this.logger.log('Cron: kpiMonthlyIncrease');
    const users = await this.prisma.user.findMany({
      where: {
        role: { in: ['ADMIN', 'SALES_MANAGER', 'CLIENT_MANAGER'] },
        kpiAutoStepPct: { gt: 0 },
      },
      select: {
        id: true,
        fullName: true,
        kpiTargetPct: true,
        kpiAutoStepPct: true,
        kpiMaxPct: true,
      },
    });

    let raised = 0;
    for (const u of users) {
      const current = u.kpiTargetPct ?? 1;
      const step = u.kpiAutoStepPct ?? 0;
      const cap = u.kpiMaxPct ?? current;
      // Округляем до 0.1 — KPI вида 1.0 / 1.1 / 1.2 %.
      const next = Math.round(Math.min(current + step, cap) * 10) / 10;
      if (next <= current) continue;

      await this.prisma.user.update({
        where: { id: u.id },
        data: { kpiTargetPct: next },
      });
      await this.notifications.notifyUser(u.id, {
        type: 'KPI_RAISED',
        title: '📈 План продаж повышен',
        message: `Твой KPI вырос с ${current}% до ${next}% от потока лидов.`,
        payload: { from: current, to: next },
      });
      raised++;
    }
    this.logger.log(`KPI raised for ${raised}/${users.length} employees`);
  }

  /**
   * Каждый день в 09:00 — авто-поздравление клиентов с днём рождения.
   * По ТЗ §10: автоматические уведомления и поздравления.
   * Сейчас: создаёт NOTIFICATION для всех staff (чтобы менеджер мог
   * позвонить лично). Если задана WhatsApp интеграция — можно расширить
   * и отправлять прямое сообщение клиенту (закомментировано в коде).
   */
  @Cron('0 9 * * *', { timeZone: 'Asia/Dushanbe' })
  async birthdayGreetings() {
    this.logger.log('Cron: birthdayGreetings');
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    // Postgres extract: where extract(month from birthday)=$1 AND day=$2
    const students = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, "fullName", phones FROM "Student"
       WHERE birthday IS NOT NULL
         AND EXTRACT(MONTH FROM birthday) = $1
         AND EXTRACT(DAY FROM birthday) = $2`,
      month, day,
    );

    if (!students.length) return;

    const smsConfigured = !!process.env.SMS_PROVIDER && process.env.SMS_PROVIDER !== 'none';
    let smsSent = 0;
    let smsFailed = 0;

    for (const s of students) {
      // 1) Уведомление сотрудникам — менеджер может позвонить лично.
      await this.notifications.notifyAllStaff({
        type: 'STUDENT_BIRTHDAY',
        title: '🎂 День рождения у студента',
        message: `Сегодня день рождения у ${s.fullName}. Позвоните поздравить!`,
        payload: { studentId: s.id, phone: s.phones?.[0] },
      });

      // 2) ПРЯМОЕ поздравление клиенту (по ТЗ §10 — «поздравления клиентов»).
      // Идёт через SMS если SMS_PROVIDER настроен в env. Иначе только п.1.
      // WhatsApp/Telegram-каналы — отдельные интеграции; для них cron
      // можно расширить когда credentials добавят.
      const phone = s.phones?.[0];
      if (smsConfigured && phone) {
        const firstName = (s.fullName || '').split(/\s+/)[0] || s.fullName;
        const message =
          `🎂 ${firstName}, с днём рождения от команды Javonon! ` +
          `Желаем успехов в учёбе и исполнения всех целей. С нами вы на верном пути!`;
        try {
          const ok = await this.sms.send(phone, message);
          if (ok) smsSent++;
          else smsFailed++;
        } catch (e: any) {
          this.logger.warn(`Birthday SMS to ${phone} failed: ${e?.message}`);
          smsFailed++;
        }
      }
    }
    this.logger.log(
      `Birthday: staff notified for ${students.length}; SMS sent=${smsSent} failed=${smsFailed} ` +
      `(SMS_PROVIDER=${process.env.SMS_PROVIDER || 'none'})`
    );
  }

  /**
   * Cleanup retention: раз в неделю удаляем старые записи которые иначе
   * растут безлимитно. ActivityLog — основной источник раздувания БД
   * (записи каждый PATCH/DELETE студента), Notification — старые прочитанные
   * можно тоже почистить.
   */
  @Cron(CronExpression.EVERY_WEEK)
  async cleanupOldLogs() {
    this.logger.log('Cron: cleanupOldLogs');
    const SIX_MONTHS_MS = 6 * 30 * 24 * 3600 * 1000;
    const THREE_MONTHS_MS = 3 * 30 * 24 * 3600 * 1000;
    const cutoff6 = new Date(Date.now() - SIX_MONTHS_MS);
    const cutoff3 = new Date(Date.now() - THREE_MONTHS_MS);

    // ActivityLog старше 6 месяцев → удалить (это аудит-лог, после полугода
    // обычно не нужен для оперативной работы; legal-обязательств у нас нет).
    const activity = await this.prisma.activityLog.deleteMany({
      where: { createdAt: { lt: cutoff6 } },
    });

    // Прочитанные Notification старше 3 месяцев → удалить.
    // Непрочитанные оставляем — это live-задачи пользователя.
    const notifications = await this.prisma.notification.deleteMany({
      where: { read: true, createdAt: { lt: cutoff3 } },
    });

    // ReferralClick старше 6 месяцев — для аналитики хватит.
    const clicks = await this.prisma.referralClick.deleteMany({
      where: { createdAt: { lt: cutoff6 } },
    });

    this.logger.log(
      `Cleanup: ${activity.count} activity, ${notifications.count} notifications, ${clicks.count} clicks`,
    );
  }
}
