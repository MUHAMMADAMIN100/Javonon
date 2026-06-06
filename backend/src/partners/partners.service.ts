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
    const amount = Math.floor(body.amountCents || 0);
    if (amount <= 0) throw new BadRequestException('Сумма должна быть > 0');
    if (amount > 100_000_000) {
      throw new BadRequestException('Сумма слишком большая');
    }
    // method и details — partner-controlled. Попадают в админ-дашборд.
    // Раньше принимали любую строку → stored XSS в админ UI + DB bloat
    // через гигантский details.
    const VALID_METHODS = new Set(['bank_card', 'bank_transfer', 'crypto', 'cash', 'other']);
    let method: string | null = null;
    if (body.method) {
      const m = body.method.toLowerCase().trim();
      if (!VALID_METHODS.has(m)) {
        throw new BadRequestException(`method должен быть один из: ${[...VALID_METHODS].join(', ')}`);
      }
      method = m;
    }
    let details: string | null = null;
    if (body.details) {
      const d = body.details.trim();
      if (d.length > 500) throw new BadRequestException('details слишком длинные (макс. 500)');
      if (/[<>]/.test(d)) throw new BadRequestException('details не должны содержать HTML-теги');
      details = d || null;
    }

    // АТОМАРНО: проверка баланса + decrement + создание payout в одной
    // транзакции. Раньше check был ПЕРЕД tx → две параллельные requestPayout
    // могли пройти проверку до tx и обе списать → отрицательный баланс.
    // Теперь используем updateMany с where: balanceCents >= amount —
    // если другая параллельная транзакция успела первой, count=0 и мы
    // выбрасываем ошибку.
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.partner.updateMany({
        where: { id: partnerId, balanceCents: { gte: amount } },
        data: { balanceCents: { decrement: amount } },
      });
      if (claim.count === 0) {
        // Либо партнёр не найден, либо недостаточно средств
        const exists = await tx.partner.findUnique({ where: { id: partnerId } });
        if (!exists) throw new NotFoundException('Партнёр не найден');
        throw new BadRequestException('Недостаточно средств на балансе');
      }
      const payout = await tx.partnerPayout.create({
        data: {
          partnerId,
          amountCents: amount,
          method,
          details,
        },
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
