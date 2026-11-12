import { Prisma, PrismaClient } from '@prisma/client';
import { hasRole, UserWithRoles } from '../auth/role-utils';
import { canSeeData } from '../common/redact';
import { seesAllDeals } from './deal-access';

/**
 * Сделки клиента для блока «Сделки» карточки лида и карточки студента (макет
 * UI 11.11.2026). Доступ к самой карточке проверяет вызывающий; здесь —
 * только что показать: суммы — тем, кому видны деньги клиентов; «открыть» —
 * тем, кому откроется сама сделка (то же правило, что у GET /submissions/:id).
 */
export async function clientDeals(
  prisma: Pick<PrismaClient, 'saleSubmission'>,
  or: Prisma.SaleSubmissionWhereInput[],
  user: (UserWithRoles & { id?: string }) | null | undefined,
) {
  const rows = await prisma.saleSubmission.findMany({
    where: { OR: or },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true, status: true, totalAmount: true, currency: true, createdAt: true, managerId: true, createdById: true,
      program: { select: { name: true } },
      manager: { select: { fullName: true } },
      payments: { where: { status: 'APPROVED' }, select: { amount: true } },
    },
  });
  const money = canSeeData(user, 'visibility:client-money');
  const all = seesAllDeals(user, () => hasRole(user as UserWithRoles, 'ADMIN'));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    program: r.program?.name ?? null,
    manager: r.manager?.fullName ?? null,
    createdAt: r.createdAt,
    currency: r.currency,
    total: money ? r.totalAmount : null,
    paid: money ? Math.round(r.payments.reduce((s, p) => s + p.amount, 0) * 100) / 100 : null,
    canOpen: all || r.managerId === user?.id || r.createdById === user?.id,
  }));
}
