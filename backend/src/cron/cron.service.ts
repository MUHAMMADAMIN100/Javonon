import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PenaltiesService } from '../penalties/penalties.service';
import { SmsService } from '../sms/sms.service';
import { CommissionOutboxService } from '../partners/commission-outbox.service';
import { InstallmentsService } from '../installments/installments.service';
import { StudyGroupsService } from '../study-groups/study-groups.service';
import { tjStartOfDay, tjStartOfNextDay, tjYMD } from '../common/tj-time';
import { FINISHED_APPLICATION_STATUSES } from '../common/application-status';

const TASK_OVERDUE_PENALTY_USD = 10; // ТЗ §3.9: «Нарушение → штраф» за просроченную задачу

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private penalties: PenaltiesService,
    private sms: SmsService,
    private commissionOutbox: CommissionOutboxService,
    private installments: InstallmentsService,
    private studyGroups: StudyGroupsService,
  ) {}

  /**
   * Единственная точка, куда падают ошибки всех @Cron-проходов ниже.
   *
   * Почему это обязательно, а не «на всякий случай»: cron@3 дёргает колбэк
   * как `void callback.call(...)` (node_modules/cron/dist/job.js, fireOnTick),
   * а @nestjs/schedule сверху ничего не оборачивает. Значит реджект любого
   * из async-методов ниже — это unhandledRejection, а Node ≥15 по умолчанию
   * превращает его в uncaughtException и УБИВАЕТ ПРОЦЕСС. То есть одна
   * битая строка в одном проходе роняла не свой проход, а весь API вместе с
   * остальными одиннадцатью cron'ами; при restartPolicyMaxRetries: 3 в
   * railway.json детерминированная ошибка (например FK-violation в
   * notifyUser по параллельно удалённому пользователю) выжигала все три
   * рестарта подряд и оставляла бэкенд лежать.
   *
   * Ошибку ГЛОТАЕМ намеренно: каждый проход идемпотентен (см. док-комментарии
   * к методам — CAS-штампы sweepOverdueStages / reminderSentAt /
   * commissionedAt / deadlineReminderSent), поэтому следующий тик спокойно
   * доделает то, что не доехало сейчас, а падать целиком незачем.
   */
  private jobFailed(job: string, e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    this.logger.error(`Cron ${job} упал: ${err.message}`, err.stack);
  }

  /**
   * Каждый день в 07:00 по Душанбе — просрочка этапов рассрочки.
   *
   * PENDING-этапы, чей срок ПОЛНОСТЬЮ прошёл, переводятся в OVERDUE, заявке
   * поднимается уже существующий Application.paymentPending (второго
   * источника правды про долг в системе нет — его читают карточка «Студентов
   * с задолженностью» на дашборде и раздел «Задолженность студентов» в
   * финансах), а ответственный менеджер получает уведомление. СТУДЕНТУ НЕ
   * ШЛЁМ НИЧЕГО: просрочка — внутренний сигнал.
   *
   * timeZone обязателен: сервер на Railway живёт в UTC, и без него проход
   * стартовал бы в 12:00 по Душанбе, а «сегодня» внутри считалось бы по
   * UTC-суткам (см. common/tj-time.ts).
   *
   * Идемпотентность целиком внутри sweepOverdueStages: захват строк и отметка
   * делаются одним UPDATE ... RETURNING, поэтому второй прогон в тот же день
   * не найдёт ничего и не отправит ни одного повторного уведомления — см.
   * док-комментарий там же. Признак должника на этот захват НЕ завязан: он
   * выводится из состояния этапов тем же проходом и потому чинится сам —
   * даже если предыдущий прогон умер между двумя запросами.
   */
  @Cron('0 7 * * *', { timeZone: 'Asia/Dushanbe' })
  async overduePaymentStages() {
    try {
      const res = await this.installments.sweepOverdueStages();
      // Тишина в обычный день: логируем только когда реально что-то нашли.
      // debtorsSynced > 0 при flipped = 0 — это починка расхождения,
      // оставшегося от оборвавшегося прогона; такое молчать нельзя.
      if (res.flipped === 0 && res.debtorsSynced === 0) return;
      this.logger.log(
        `Cron: overduePaymentStages — этапов просрочено ${res.flipped}, ` +
          `уведомлений ${res.managersNotified}, ` +
          `признак должника пересчитан у ${res.debtorsSynced} заявок`,
      );
    } catch (e) {
      this.jobFailed('overduePaymentStages', e);
    }
  }

  /**
   * Каждые 30 минут — напоминание преподавателю о занятии, которое начнётся
   * в ближайшие два часа. Канал — тот же NotificationsService, которым этот
   * же cron шлёт напоминания по задачам и дедлайнам; второго пути уведомлений
   * в системе нет.
   *
   * Без timeZone намеренно: интервальный тик не привязан к границе суток,
   * окно считается от `now` (в отличие от суточных проходов выше).
   *
   * Двойной отправки не бывает: sweepSessionReminders штампует
   * ClassSession.reminderSentAt тем же запросом, которым отбирает строки.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async classSessionReminders() {
    try {
      const res = await this.studyGroups.sweepSessionReminders();
      if (res.reminded === 0) return;
      this.logger.log(`Cron: classSessionReminders — отправлено ${res.reminded}`);
    } catch (e) {
      this.jobFailed('classSessionReminders', e);
    }
  }

  /**
   * Каждые 5 минут — добираем партнёрские комиссии, которые не доехали.
   *
   * approvePayment коммитит одобрение платежа одной транзакцией, а начисляет
   * партнёру — отдельной, уже после COMMIT'а (иначе сбой партнёрской части
   * ронял бы работу бухгалтера). Смерть процесса между этими двумя
   * транзакциями раньше теряла комиссию НАВСЕГДА: по одноплатёжной сделке
   * второго одобрения, которое «догнало» бы начисление, не бывает. Теперь
   * одобрение пишет строку CommissionOutbox в своей же транзакции, а этот
   * cron доставляет всё, что быстрый путь не закрыл.
   *
   * В норме проход не находит ничего и молчит: строку создают с форой в
   * COMMISSION_OUTBOX_INLINE_GRACE_MS, и approvePayment успевает закрыть её
   * сам. Каждая claimed-строка здесь — это либо рестарт в момент одобрения,
   * либо устойчивый сбой БД.
   *
   * Идемпотентность обеспечивает creditCommissionForAttributionOnce (CAS-штамп
   * ReferralAttribution.commissionedAt), поэтому даже несколько реплик,
   * запустивших cron одновременно, не могут заплатить партнёру дважды.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async drainCommissionOutbox() {
    try {
      const res = await this.commissionOutbox.drain({ limit: 100 });
      // Тишина в 99.9% проходов: логируем только когда реально что-то делали.
      if (res.claimed === 0) return;
      this.logger.log(
        `Cron: drainCommissionOutbox — взято ${res.claimed}, начислено ${res.credited}, ` +
          `пропущено ${res.skipped}, отложено ${res.retried}, провалено ${res.failed.length}`,
      );
      if (res.failed.length === 0) return;

      // Доставка провалена окончательно — дальше только руками. Уведомляем
      // ТОЛЬКО руководство: сам факт, что клиент партнёрский, менеджерам по
      // продажам видеть нельзя (см. canSeePartnerAttribution). Ни имени
      // партнёра, ни суммы в сообщении нет — только номера сделок, чтобы разбор
      // шёл через карточку, где гейт уже стоит.
      const RECIPIENT_ROLES = ['FOUNDER', 'ADMIN', 'ACCOUNTANT'] as const;
      const recipients = await this.prisma.user.findMany({
        where: {
          OR: [
            { role: { in: RECIPIENT_ROLES as any } },
            { roles: { hasSome: RECIPIENT_ROLES as any } },
          ],
        },
        select: { id: true },
      });
      // ОДНО уведомление на проход, а не на строку: устойчивый сбой БД валит
      // сразу всю пачку, и порядная рассылка засыпала бы основателя сотней
      // одинаковых сообщений. Номера сделок целиком лежат в payload.
      const shortIds = res.failed.slice(0, 5).map((f) => `#${f.submissionId.slice(0, 8)}`);
      const tail = res.failed.length > shortIds.length ? ` и ещё ${res.failed.length - shortIds.length}` : '';
      for (const u of recipients) {
        await this.notifications.notifyUser(u.id, {
          type: 'COMMISSION_DELIVERY_FAILED',
          title: '⚠️ Партнёрская комиссия не начислена',
          message:
            `Не прошло начислений: ${res.failed.length} (сделки ${shortIds.join(', ')}${tail}). ` +
            `Попытки исчерпаны — проверьте вручную.`,
          payload: {
            outbox: res.failed.map((f) => ({
              outboxId: f.id,
              submissionId: f.submissionId,
              paymentId: f.paymentId,
              attempts: f.attempts,
            })),
          },
        });
      }
    } catch (e) {
      this.jobFailed('drainCommissionOutbox', e);
    }
  }

  /**
   * Каждый рабочий день в 22:00 — генерируем штрафы за опоздания
   * за этот день. По ТЗ §3.9: «Нарушение → штраф».
   */
  @Cron('0 22 * * 1-5', { timeZone: 'Asia/Dushanbe' })
  async autoLatePenalties() {
    try {
      this.logger.log('Cron: autoLatePenalties');
      const today = new Date();
      const result = await this.penalties.generateLatePenaltiesForDate(today);
      this.logger.log(`Created ${result.created} penalties from ${result.scanned} late entries`);
      // По ТЗ — штраф за позднее возвращение с обеда. Тот же cron, тот же
      // источник данных (TimeEntry), но другой признак (lateLunchMinutes).
      const lunchResult = await this.penalties.generateLunchLatePenaltiesForDate(today);
      this.logger.log(`Created ${lunchResult.created} lunch-late penalties from ${lunchResult.scanned} entries`);
    } catch (e) {
      this.jobFailed('autoLatePenalties', e);
    }
  }

  /**
   * Каждый рабочий день в 09:30 — проверяем кто опоздал > 15 минут
   * и кто вообще не пришёл. Шлём уведомление админам.
   */
  @Cron('30 9 * * 1-5', { timeZone: 'Asia/Dushanbe' })
  async checkLateArrivals() {
    try {
      this.logger.log('Cron: checkLateArrivals');
      // Границы дня — по Asia/Dushanbe. Cron @09:30 ТJT даёт 04:30 UTC,
      // setHours(0,0,0,0) на UTC даст 00:00 UTC = 05:00 ТJT — окно
      // сегодня запишет половину «сегодня» Душанбе.
      const today = tjStartOfDay();
      const tomorrow = tjStartOfNextDay();

      // Все, кто отмечается по графику: ADMIN/ACCOUNTANT/SALES_MANAGER/
      // CLIENT_MANAGER. FOUNDER не пингуем — он не в общем графике.
      // Мульти-роли (ТЗ §2) учитываются через OR на roles[].
      const FILTER_ROLES = ['ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER'] as const;
      const employees = await this.prisma.user.findMany({
        where: {
          OR: [
            { role: { in: FILTER_ROLES as any } },
            { roles: { hasSome: FILTER_ROLES as any } },
          ],
        },
        select: { id: true, fullName: true },
      });
      const todayEntries = await this.prisma.timeEntry.findMany({
        where: { clockIn: { gte: today, lt: tomorrow } },
      });
      const presentIds = new Set(todayEntries.map((e) => e.userId));

      for (const emp of employees) {
        const entry = todayEntries.find((e) => e.userId === emp.id);
        // ТЗ §3 «10-15 минут» — 10 включительно, такая же граница как
        // у penalty cron (penalties.service.ts LATE_THRESHOLD_MIN).
        if (entry && entry.lateMinutes >= 10) {
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
    } catch (e) {
      this.jobFailed('checkLateArrivals', e);
    }
  }

  /**
   * Каждый день в 18:00 — кто забыл нажать "Закончить день".
   */
  @Cron('0 18 * * 1-5', { timeZone: 'Asia/Dushanbe' })
  async remindClockOut() {
    try {
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
    } catch (e) {
      this.jobFailed('remindClockOut', e);
    }
  }

  /**
   * Каждый час — напоминание о приближающемся дедлайне (за 24ч)
   * + уведомление о просрочке. Идемпотентно через флаги в Task.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async deadlineReminders() {
    try {
      this.logger.log('Cron: deadlineReminders');
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // 1) Напомнить за 24 часа до дедлайна (один раз).
      // Уведомляем всех assignees[] (M2M) + controller. assignedToId — legacy,
      // используем как fallback если M2M пусто (старые данные до миграции).
      const upcoming = await this.prisma.task.findMany({
        where: {
          status: { in: ['TODO', 'IN_PROGRESS'] },
          deadline: { lte: in24h, gt: now },
          deadlineReminderSent: false,
        },
        include: {
          assignees: { select: { id: true } },
          controller: { select: { id: true } },
        },
      });
      for (const t of upcoming) {
        const recipientIds = new Set<string>();
        for (const a of t.assignees) recipientIds.add(a.id);
        if (t.assignedToId) recipientIds.add(t.assignedToId);
        if (t.controllerId) recipientIds.add(t.controllerId);
        for (const uid of recipientIds) {
          await this.notifications.notifyUser(uid, {
            type: 'TASK_DEADLINE_SOON',
            title: '⏳ Дедлайн через 24 часа',
            message: `«${t.title}» — закрой или попроси перенос.`,
            payload: { taskId: t.id, deadline: t.deadline },
          });
        }
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
        include: {
          assignees: { select: { id: true } },
          controller: { select: { id: true } },
        },
      });
      for (const t of overdue) {
        // Штраф — только реальным исполнителям (assignees[] + legacy fallback).
        // Контролёр не штрафуется, только уведомляется.
        const penaltyIds = new Set<string>();
        for (const a of t.assignees) penaltyIds.add(a.id);
        if (t.assignedToId) penaltyIds.add(t.assignedToId);

        const notifyIds = new Set<string>(penaltyIds);
        if (t.controllerId) notifyIds.add(t.controllerId);

        for (const uid of notifyIds) {
          await this.notifications.notifyUser(uid, {
            type: 'TASK_OVERDUE',
            title: '🔴 Задача просрочена',
            message: `«${t.title}» — дедлайн прошёл. Применён штраф $${TASK_OVERDUE_PENALTY_USD}.`,
            payload: { taskId: t.id, deadline: t.deadline },
          });
        }
        // Уведомляем и админов
        await this.notifications.notifyAdmins({
          type: 'TASK_OVERDUE_ADMIN',
          title: '🔴 Задача просрочена сотрудником',
          message: `«${t.title}»`,
          payload: { taskId: t.id, assignedToId: t.assignedToId },
        });
        // ТЗ §3.9: «Нарушение → штраф». Создаём Penalty каждому исполнителю.
        for (const uid of penaltyIds) {
          await this.penalties.createManual(uid, {
            reason: 'TASK_OVERDUE',
            amount: TASK_OVERDUE_PENALTY_USD,
            details: `Просроченная задача: «${t.title}»`,
          });
        }
        await this.prisma.task.update({
          where: { id: t.id },
          data: { overdueNotified: true },
        });
      }
    } catch (e) {
      this.jobFailed('deadlineReminders', e);
    }
  }

  /**
   * Каждое утро в 09:00 — напоминание о просроченных/висящих задачах.
   */
  @Cron('0 9 * * 1-5', { timeZone: 'Asia/Dushanbe' })
  async remindOpenTasks() {
    try {
      this.logger.log('Cron: remindOpenTasks');
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      const stale = await this.prisma.task.findMany({
        where: {
          status: { in: ['TODO', 'IN_PROGRESS'] },
          updatedAt: { lt: threeDaysAgo },
        },
        include: {
          assignees: { select: { id: true } },
          controller: { select: { id: true } },
        },
      });

      for (const t of stale) {
        const recipientIds = new Set<string>();
        for (const a of t.assignees) recipientIds.add(a.id);
        if (t.assignedToId) recipientIds.add(t.assignedToId);
        if (t.controllerId) recipientIds.add(t.controllerId);
        for (const uid of recipientIds) {
          await this.notifications.notifyUser(uid, {
            type: 'TASK_REMINDER',
            title: '📋 Задача висит уже 3+ дня',
            message: `«${t.title}» — обнови статус или закрой.`,
            payload: { taskId: t.id },
          });
        }
      }
    } catch (e) {
      this.jobFailed('remindOpenTasks', e);
    }
  }

  /**
   * Каждый понедельник в 09:30 — напоминание о незакрытых заявках
   * без активности более 7 дней.
   */
  @Cron(CronExpression.EVERY_WEEK)
  async stalePipeline() {
    try {
      this.logger.log('Cron: stalePipeline');
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const stale = await this.prisma.application.findMany({
        where: {
          // Завершённые заявки не дёргаем. Группа, а не одно значение: пока
          // не прогнали migrate-lead-statuses.ts (перенос опт-ин, см.
          // MIGRATE_LEAD_STATUSES), закрытая заявка может ещё носить
          // ENROLLED/COMPLETED — и менеджер получал бы напоминание «обнови
          // статус» по уже успешному лиду.
          status: { notIn: FINISHED_APPLICATION_STATUSES },
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
    } catch (e) {
      this.jobFailed('stalePipeline', e);
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
    try {
      this.logger.log('Cron: kpiMonthlyIncrease');
      const users = await this.prisma.user.findMany({
        where: {
          OR: [
            { role: { in: ['ADMIN', 'SALES_MANAGER', 'CLIENT_MANAGER'] } },
            { roles: { hasSome: ['ADMIN', 'SALES_MANAGER', 'CLIENT_MANAGER'] } },
          ],
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
    } catch (e) {
      this.jobFailed('kpiMonthlyIncrease', e);
    }
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
    try {
      this.logger.log('Cron: birthdayGreetings');
      // getMonth/getDate возвращают UTC-локальное на сервере. В 09:00 ТJT
      // = 04:00 UTC — день в UTC ещё «вчера», поздравляли бы клиентов с ДР
      // которое было ВЧЕРА в Душанбе. Считаем месяц/день в TJT.
      const { m: month, d: day } = tjYMD(new Date());

      // EXTRACT читает СЫРУЮ колонку (Prisma DateTime = timestamp без tz,
      // значение в UTC), поэтому сравнение с душанбинскими month/day корректно
      // ровно потому, что DOB хранится UTC-полуночью того же календарного дня —
      // см. parseCalendarDateUtc() в common/tj-time.ts, через который обязаны
      // идти оба писателя (applications.service.ts и students.service.ts).
      // Если кто-то снова начнёт писать душанбинскую полночь (19:00Z прошлых
      // суток), EXTRACT(DAY) вернёт вчерашнее число и поздравление уйдёт на
      // сутки раньше. Исторические строки чинит prisma/migrate-birthdays-utc.ts.
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
    } catch (e) {
      this.jobFailed('birthdayGreetings', e);
    }
  }

  /**
   * Cleanup retention: раз в неделю удаляем старые записи которые иначе
   * растут безлимитно. ActivityLog — основной источник раздувания БД
   * (записи каждый PATCH/DELETE студента), Notification — старые прочитанные
   * можно тоже почистить.
   */
  @Cron(CronExpression.EVERY_WEEK)
  async cleanupOldLogs() {
    try {
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

      // Отработанные строки outbox'а комиссий старше 6 месяцев. Удаляем ТОЛЬКО
      // DONE: PENDING — недоставленная комиссия, FAILED — незакрытый разбор с
      // партнёром, их чистка стёрла бы ровно тот след, ради которого outbox и
      // заведён.
      const outbox = await this.prisma.commissionOutbox.deleteMany({
        where: { status: 'DONE', processedAt: { lt: cutoff6 } },
      });

      this.logger.log(
        `Cleanup: ${activity.count} activity, ${notifications.count} notifications, ` +
          `${clicks.count} clicks, ${outbox.count} commission outbox`,
      );
    } catch (e) {
      this.jobFailed('cleanupOldLogs', e);
    }
  }
}
