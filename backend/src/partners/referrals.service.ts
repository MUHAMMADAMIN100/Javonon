import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Реферальный трекинг и атрибуция.
 *  - registerClick: при заходе по /r/:code или с ?ref=
 *  - attribute: при значимом событии (регистрация студента, /start в боте,
 *    создание заявки) связываем клиента с партнёром.
 *  - resolvePartnerFor*: при оплате — найти кому начислить.
 *  - creditCommission: создать запись Commission + увеличить баланс партнёра.
 */
@Injectable()
export class ReferralsService {
  private readonly log = new Logger(ReferralsService.name);
  // TTL атрибуции — 90 дней.
  private readonly ATTRIBUTION_TTL_MS = 90 * 24 * 3600 * 1000;

  constructor(private prisma: PrismaService) {}

  private fingerprint(ip?: string, ua?: string) {
    return createHash('sha256')
      .update(`${ip || ''}|${ua || ''}`)
      .digest('hex')
      .slice(0, 32);
  }

  /** Находит партнёра по ref-коду. Возвращает null если не найден / не активен. */
  async findPartnerByCode(code: string) {
    if (!code) return null;
    const partner = await this.prisma.partner.findUnique({
      where: { referralCode: code.trim().toUpperCase() },
    });
    if (!partner || partner.status !== 'ACTIVE') return null;
    return partner;
  }

  /** Залогировать клик. Не падает, если код невалиден — просто silent skip. */
  async registerClick(opts: {
    code: string;
    source?: 'SITE' | 'BOT';
    ip?: string;
    userAgent?: string;
    referer?: string;
  }) {
    const partner = await this.findPartnerByCode(opts.code);
    if (!partner) return null;
    try {
      return await this.prisma.referralClick.create({
        data: {
          partnerId: partner.id,
          source: opts.source || 'SITE',
          ip: opts.ip,
          userAgent: opts.userAgent,
          referer: opts.referer,
          fingerprint: this.fingerprint(opts.ip, opts.userAgent),
        },
      });
    } catch (e) {
      this.log.warn(`registerClick failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Привязать клиента (студента / заявку / telegram-пользователя) к
   * партнёру по реферальному коду. Idempotent — если уже есть, ничего
   * не меняет.
   */
  async attribute(opts: {
    code: string;
    source?: 'SITE' | 'BOT';
    studentId?: string;
    applicationId?: string;
    telegramUserId?: string;
    emailHint?: string;
  }) {
    const partner = await this.findPartnerByCode(opts.code);
    if (!partner) return null;

    // Дедупликация: если уже есть атрибуция для этого клиента на этого
    // партнёра — не создаём повторно.
    const existing = await this.prisma.referralAttribution.findFirst({
      where: {
        partnerId: partner.id,
        ...(opts.studentId && { studentId: opts.studentId }),
        ...(opts.applicationId && { applicationId: opts.applicationId }),
        ...(opts.telegramUserId && { telegramUserId: opts.telegramUserId }),
      },
    });
    if (existing) return existing;

    return this.prisma.referralAttribution.create({
      data: {
        partnerId: partner.id,
        source: opts.source || 'SITE',
        studentId: opts.studentId,
        applicationId: opts.applicationId,
        telegramUserId: opts.telegramUserId,
        emailHint: opts.emailHint,
        expiresAt: new Date(Date.now() + this.ATTRIBUTION_TTL_MS),
      },
    });
  }

  /** Найти партнёра по любому из идентификаторов клиента. */
  async resolvePartner(opts: {
    studentId?: string;
    applicationId?: string;
    telegramUserId?: string;
  }) {
    const where: any = {};
    if (opts.studentId) where.studentId = opts.studentId;
    else if (opts.applicationId) where.applicationId = opts.applicationId;
    else if (opts.telegramUserId) where.telegramUserId = opts.telegramUserId;
    else return null;

    const attr = await this.prisma.referralAttribution.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      include: { partner: true },
    });
    if (!attr) return null;
    if (attr.expiresAt && attr.expiresAt < new Date()) return null;
    if (!attr.partner || attr.partner.status !== 'ACTIVE') return null;
    return attr.partner;
  }

  /**
   * Начисляет комиссию партнёру за платёж клиента. Idempotent через
   * (partnerId + paymentId) уникальную пару — если уже есть commission
   * для этого платежа, пропускает.
   */
  async creditCommission(opts: {
    partnerId: string;
    amountCents: number; // сумма платежа
    currency?: string;
    paymentId?: string;
    transactionId?: string;
    note?: string;
  }) {
    if (opts.amountCents <= 0) return null;

    // Дедупликация по source
    if (opts.paymentId) {
      const exists = await this.prisma.commission.findFirst({
        where: { paymentId: opts.paymentId, partnerId: opts.partnerId },
      });
      if (exists) return exists;
    }
    if (opts.transactionId) {
      const exists = await this.prisma.commission.findFirst({
        where: {
          transactionId: opts.transactionId,
          partnerId: opts.partnerId,
        },
      });
      if (exists) return exists;
    }

    const partner = await this.prisma.partner.findUnique({
      where: { id: opts.partnerId },
    });
    if (!partner) throw new NotFoundException('Партнёр не найден');

    const pct = partner.commissionPct;
    const commissionCents = Math.floor((opts.amountCents * pct) / 100);
    if (commissionCents <= 0) return null;

    return this.prisma.$transaction(async (tx) => {
      const commission = await tx.commission.create({
        data: {
          partnerId: partner.id,
          paymentId: opts.paymentId,
          transactionId: opts.transactionId,
          amountCents: commissionCents,
          baseAmountCents: opts.amountCents,
          percent: pct,
          currency: opts.currency || 'USD',
          note: opts.note,
          status: 'PENDING',
        },
      });
      await tx.partner.update({
        where: { id: partner.id },
        data: {
          balanceCents: { increment: commissionCents },
          totalEarnedCents: { increment: commissionCents },
        },
      });
      return commission;
    });
  }
}
