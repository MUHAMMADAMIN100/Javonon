import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FINISHED_APPLICATION_STATUSES } from '../common/application-status';
import { dateRangeFilter } from '../common/query-date';

@Injectable()
export class KpiService {
  constructor(private prisma: PrismaService) {}

  /**
   * Сводный KPI по сотрудникам:
   *  - applicationsAssigned — сколько заявок назначено
   *  - applicationsEnrolled — сколько дошло до SUCCESSFUL_LEAD (успешный лид;
   *    легаси ENROLLED/COMPLETED считаются тем же, см. common/application-status)
   *  - conversionRate — % конверсии
   *  - studentsCount — сколько из заведённых студентов сейчас ACTIVE
   *  - salesAmount — сумма продаж клиентов этого менеджера
   *  - tasksOpen / tasksDone
   *
   * ПЕРИОД — ОДНО ПРАВИЛО НА ВСЕ МЕТРИКИ: «СОЗДАНО В ПЕРИОДЕ».
   *
   * Границы накладываются на дату появления самой записи (createdAt; у
   * транзакции — её собственная `date`, см. ниже), и ни на какое поле
   * «когда последний раз тронули». Это то же правило, что у
   * /applications/stats, /students/stats и /finance/summary, то есть у
   * карточек 01–07 дашборда, и оно же описано в PeriodSwitcher.tsx:
   * «сколько ИЗ СОЗДАННЫХ в этом месяце заявок сейчас в таком-то
   * состоянии», а не «сколько заявок за месяц перешло в это состояние».
   *
   * Почему не updatedAt (так считались enrolled и tasksDone):
   *  1. Числитель и знаменатель конверсии брались из РАЗНЫХ популяций —
   *     enrolled по updatedAt, assigned по createdAt. Заявка, созданная в
   *     прошлом году и закрытая в этом месяце, попадала в числитель и не
   *     попадала в знаменатель: 3 созданных заявки против 8 закрытых
   *     старых давали «267% CONV» на главном экране руководителя.
   *  2. `updatedAt` двигает ЛЮБАЯ правка строки (смена менеджера, коммент,
   *     телефон), поэтому «зачислено за период» на самом деле означало
   *     «закрытую заявку в этот период кто-то потрогал».
   *  3. Карточка 05 «Зачислено» на дашборде считает те же статусы по
   *     createdAt — цифры на одном экране обязаны сходиться.
   *
   * Транзакции фильтруем по `Transaction.date`: у платежа это и есть его
   * собственная дата события (в схеме `@default(now())`), по ней же режет
   * период /finance/summary. Взять здесь createdAt значило бы разойтись с
   * финансовой карточкой того же дашборда на задним числом проведённых
   * платежах.
   *
   * Без границ (`{}` — /kpi/me, /kpi/:userId и режим «за всё время»)
   * dateRangeFilter отдаёт undefined, ни один фильтр не подмешивается и
   * запросы остаются ровно теми же, что были до появления периода.
   *
   * Сами границы разворачивает в моменты общий парсер (common/query-date →
   * common/tj-time): календарный день Asia/Dushanbe, `to` включительно до
   * 23:59:59.999 TJT. Арифметики над Date здесь нет и быть не должно.
   */
  async leaderboard(filters: { from?: Date; to?: Date }) {
    const dateFilter = dateRangeFilter(filters);

    // KPI leaderboard включает всех, кто работает с заявками: ADMIN
    // (исторически вёл свои), и оба типа менеджеров. Мульти-роли (ТЗ §2)
    // учитываются через OR на roles[].
    const KPI_ROLES = ['ADMIN', 'SALES_MANAGER', 'CLIENT_MANAGER'] as const;
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { role: { in: KPI_ROLES as any } },
          { roles: { hasSome: KPI_ROLES as any } },
        ],
      },
      select: { id: true, fullName: true, role: true, email: true, bonusPercent: true },
    });

    const result = await Promise.all(
      users.map(async (u) => {
        const [
          applicationsAssigned,
          applicationsEnrolled,
          studentsCount,
          salesAgg,
          tasksOpen,
          tasksDone,
        ] = await Promise.all([
          this.prisma.application.count({
            where: {
              OR: [{ managerId: u.id }, { chinaManagerId: u.id }],
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
          this.prisma.application.count({
            where: {
              OR: [{ managerId: u.id }, { chinaManagerId: u.id }],
              // Не одно значение, а группа: пока не прогнали
              // migrate-lead-statuses.ts (перенос опт-ин, см.
              // MIGRATE_LEAD_STATUSES), часть строк носит ENROLLED/COMPLETED,
              // и строгий матч по SUCCESSFUL_LEAD обнулил бы весь KPI.
              status: { in: FINISHED_APPLICATION_STATUSES },
              // Тот же createdAt, что и у знаменателя конверсии выше:
              // считаем «сколько из назначенных за период заявок уже
              // дошли до успеха». Подмножество — значит conversionRate
              // физически не может превысить 100%.
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
          this.prisma.student.count({
            where: {
              OR: [{ managerId: u.id }, { chinaManagerId: u.id }],
              status: 'ACTIVE',
              // Период здесь раньше игнорировался молча: на /kpi с
              // выбранными «30 днями» эта колонка одна показывала «за всё
              // время». Режем по дате заведения студента — ровно так
              // считает карточка 04 «Активные клиенты» (students/stats),
              // поэтому сумма колонки сходится с ней.
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
          this.prisma.transaction.aggregate({
            where: {
              managerId: u.id,
              type: 'INCOME',
              // Bug #25: исключаем INCOME-транзакции, помеченные как
              // reversed (CANCEL сделки или ручной refund), иначе KPI
              // показывает завышенный salesAmount по отменённым сделкам.
              reversedAt: null,
              ...(dateFilter && { date: dateFilter }),
            },
            _sum: { amount: true },
          }),
          this.prisma.task.count({
            where: {
              assignedToId: u.id,
              status: { not: 'DONE' },
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
          this.prisma.task.count({
            where: {
              assignedToId: u.id,
              status: 'DONE',
              // Обе задачные метрики — по createdAt, иначе колонка
              // «tasksDone / (tasksDone + tasksOpen)» на /kpi складывала бы
              // закрытые-в-периоде с открытыми-за-всё-время.
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
        ]);

        // Math.min(100, …) — не расчёт, а предохранитель. После перевода
        // enrolled на createdAt он строго подмножество assigned, и выйти
        // за 100% арифметически нельзя. Клампа стоит на случай, если базы
        // дат снова разведут: «конверсия 267%» — цифра, из-за которой
        // перестают верить всему экрану, лучше упереться в 100%.
        const conversionRate =
          applicationsAssigned > 0
            ? Math.min(100, Math.round((applicationsEnrolled / applicationsAssigned) * 100))
            : 0;

        return {
          ...u,
          applicationsAssigned,
          applicationsEnrolled,
          conversionRate,
          studentsCount,
          salesAmount: salesAgg._sum.amount || 0,
          tasksOpen,
          tasksDone,
        };
      }),
    );

    // Сортируем по продажам — топ-менеджеры наверху
    return result.sort((a, b) => b.salesAmount - a.salesAmount);
  }

  /** KPI одного сотрудника + история по месяцам. */
  async forUser(userId: string) {
    const board = await this.leaderboard({});
    return board.find((u) => u.id === userId) || null;
  }
}
