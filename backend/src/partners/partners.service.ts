import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PartnersService {
  constructor(private prisma: PrismaService) {}

  /** Дашборд партнёра: ссылка, статистика воронки, баланс. */
  async dashboard(partnerId: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
    });
    if (!partner) throw new NotFoundException('Партнёр не найден');

    const [clicks, attributions, commissions] = await Promise.all([
      this.prisma.referralClick.count({ where: { partnerId } }),
      this.prisma.referralAttribution.count({ where: { partnerId } }),
      this.prisma.commission.findMany({
        where: { partnerId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const paidCount = commissions.filter((c) => c.status === 'PAID').length;
    const pendingCount = commissions.filter((c) => c.status !== 'PAID').length;

    return {
      partner: {
        id: partner.id,
        fullName: partner.fullName,
        email: partner.email,
        referralCode: partner.referralCode,
        commissionPct: partner.commissionPct,
        balanceCents: partner.balanceCents,
        totalEarnedCents: partner.totalEarnedCents,
        totalPaidCents: partner.totalPaidCents,
      },
      stats: {
        clicks,
        leads: attributions,
        sales: paidCount + pendingCount,
        paidSales: paidCount,
      },
      recentCommissions: commissions,
    };
  }

  async listCommissions(partnerId: string, params?: { limit?: number }) {
    const limit = Math.min(params?.limit || 50, 200);
    return this.prisma.commission.findMany({
      where: { partnerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async requestPayout(partnerId: string, body: {
    amountCents: number;
    method?: string;
    details?: string;
  }) {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
    });
    if (!partner) throw new NotFoundException('Партнёр не найден');

    const amount = Math.floor(body.amountCents || 0);
    if (amount <= 0) throw new BadRequestException('Сумма должна быть > 0');
    if (amount > partner.balanceCents) {
      throw new BadRequestException('Недостаточно средств на балансе');
    }

    return this.prisma.$transaction(async (tx) => {
      const payout = await tx.partnerPayout.create({
        data: {
          partnerId,
          amountCents: amount,
          method: body.method,
          details: body.details,
        },
      });
      // Сразу резервируем — снимаем с balanceCents (если админ отклонит,
      // вернём обратно). Это безопаснее чем держать запрос без резерва.
      await tx.partner.update({
        where: { id: partnerId },
        data: { balanceCents: { decrement: amount } },
      });
      return payout;
    });
  }

  async listPayouts(partnerId: string) {
    return this.prisma.partnerPayout.findMany({
      where: { partnerId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  // ===== Admin operations =====

  async adminList() {
    return this.prisma.partner.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        referralCode: true,
        commissionPct: true,
        balanceCents: true,
        totalEarnedCents: true,
        totalPaidCents: true,
        status: true,
        telegramHandle: true,
        createdAt: true,
        _count: {
          select: { clicks: true, attributions: true, commissions: true },
        },
      },
    });
  }

  async adminUpdate(id: string, patch: {
    commissionPct?: number;
    status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
    fullName?: string;
  }) {
    return this.prisma.partner.update({
      where: { id },
      data: {
        ...(typeof patch.commissionPct === 'number' && {
          commissionPct: Math.max(0, Math.min(100, patch.commissionPct)),
        }),
        ...(patch.status && { status: patch.status }),
        ...(patch.fullName && { fullName: patch.fullName }),
      },
    });
  }

  async adminListCommissions(params?: {
    partnerId?: string;
    status?: 'PENDING' | 'APPROVED' | 'PAID' | 'REVERSED';
  }) {
    return this.prisma.commission.findMany({
      where: {
        ...(params?.partnerId && { partnerId: params.partnerId }),
        ...(params?.status && { status: params.status }),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        partner: { select: { id: true, fullName: true, email: true } },
      },
    });
  }

  async adminMarkCommissionPaid(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.commission.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Начисление не найдено');
      if (c.status === 'PAID') return c;
      const updated = await tx.commission.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date(), approvedAt: new Date() },
      });
      // Сдвигаем баланс: убираем из balanceCents (выплачено), записываем
      // в totalPaidCents.
      await tx.partner.update({
        where: { id: c.partnerId },
        data: {
          balanceCents: { decrement: c.amountCents },
          totalPaidCents: { increment: c.amountCents },
        },
      });
      return updated;
    });
  }

  async adminListPayouts() {
    return this.prisma.partnerPayout.findMany({
      orderBy: { requestedAt: 'desc' },
      take: 500,
      include: {
        partner: { select: { id: true, fullName: true, email: true } },
      },
    });
  }

  async adminMarkPayout(id: string, action: 'paid' | 'rejected') {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.partnerPayout.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Выплата не найдена');
      if (p.status !== 'REQUESTED') {
        throw new ForbiddenException('Этот payout уже обработан');
      }
      if (action === 'paid') {
        return tx.partnerPayout.update({
          where: { id },
          data: { status: 'PAID', paidAt: new Date() },
        });
      } else {
        // Возвращаем зарезервированную сумму на баланс
        await tx.partner.update({
          where: { id: p.partnerId },
          data: { balanceCents: { increment: p.amountCents } },
        });
        return tx.partnerPayout.update({
          where: { id },
          data: { status: 'REJECTED', rejectedAt: new Date() },
        });
      }
    });
  }
}
