import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class KpiService {
  constructor(private prisma: PrismaService) {}

  /**
   * Сводный KPI по сотрудникам:
   *  - applicationsAssigned — сколько заявок назначено
   *  - applicationsEnrolled — сколько дошло до ENROLLED (зачислено)
   *  - conversionRate — % конверсии
   *  - studentsCount — текущих студентов в работе
   *  - salesAmount — сумма продаж клиентов этого менеджера
   *  - tasksOpen / tasksDone
   */
  async leaderboard(filters: { from?: Date; to?: Date }) {
    const dateFilter =
      filters.from || filters.to
        ? { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) }
        : undefined;

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
              status: 'ENROLLED',
              ...(dateFilter && { updatedAt: dateFilter }),
            },
          }),
          this.prisma.student.count({
            where: {
              OR: [{ managerId: u.id }, { chinaManagerId: u.id }],
              status: 'ACTIVE',
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
            where: { assignedToId: u.id, status: { not: 'DONE' } },
          }),
          this.prisma.task.count({
            where: {
              assignedToId: u.id,
              status: 'DONE',
              ...(dateFilter && { updatedAt: dateFilter }),
            },
          }),
        ]);

        const conversionRate =
          applicationsAssigned > 0
            ? Math.round((applicationsEnrolled / applicationsAssigned) * 100)
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
