import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

    // Variant A flat-rate: партнёру начисляется ФИКСИРОВАННАЯ сумма
    // (в копейках) за каждый успешный платёж клиента. Если клиент платит
    // в 3 рассрочки — creditCommission вызовется 3 раза и партнёр получит
    // rate × 3. Валюта flat-rate всегда TJS независимо от валюты платежа
    // клиента (opts.currency не читается для начисления).
    const commissionCents = partner.commissionAmountCents;
    // 0 — валидное значение (партнёр временно ничего не получает, но
    // остаётся ACTIVE). Не создаём Commission-запись в этом случае —
    // amountCents=0 засоряет отчёты и не нужен для аудита.
    if (commissionCents <= 0) return null;

    // Authoritative дедуп: compound unique @@unique([partnerId, paymentId]) и
    // @@unique([partnerId, transactionId]) в schema.prisma закрывают гонку
    // (два одновременных webhook-ретрая с одним paymentId проходят
    // pre-check выше, но commission.create внутри tx кинет P2002 у
    // проигравшего — tx откатится, balanceCents НЕ инкрементируется
    // дважды). Для NULL-полей Postgres считает значения различными, так
    // что legacy-строки с paymentId=NULL или transactionId=NULL не
    // конфликтуют.
    try {
      return await this.prisma.$transaction(async (tx) => {
        const commission = await tx.commission.create({
          data: {
            partnerId: partner.id,
            paymentId: opts.paymentId,
            transactionId: opts.transactionId,
            amountCents: commissionCents,
            // baseAmountCents — сумма платежа клиента (для аудит-трейла:
            // видно с какого именно платежа снят flat-rate). Хранится в
            // ОРИГИНАЛЬНОЙ валюте платежа (USD/EUR/RUB/…) — конверсия в TJS
            // не делается, потому что flat-rate от неё не зависит.
            baseAmountCents: opts.amountCents,
            // Sentinel 0 = flat-rate начисление (не процент от базы).
            // Старые записи с percent > 0 остаются как есть (legacy %-based).
            percent: 0,
            // Flat-rate всегда в TJS — независимо от валюты платежа клиента.
            currency: 'TJS',
            // Валюта baseAmountCents = валюта платежа клиента. Без этого поля
            // фронт рендерил бы базу как «500 TJS» для платежа $500 —
            // вводит админа в заблуждение при сверке.
            baseCurrency: (opts.currency || 'TJS').toUpperCase(),
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
    } catch (e) {
      // P2002 — гонка проиграна: параллельный вызов уже создал Commission
      // для этой (partnerId, paymentId/transactionId) пары. tx откатился,
      // balanceCents не тронут. Возвращаем существующую запись как
      // idempotent результат.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        if (opts.paymentId) {
          const existing = await this.prisma.commission.findFirst({
            where: { paymentId: opts.paymentId, partnerId: opts.partnerId },
          });
          if (existing) return existing;
        }
        if (opts.transactionId) {
          const existing = await this.prisma.commission.findFirst({
            where: {
              transactionId: opts.transactionId,
              partnerId: opts.partnerId,
            },
          });
          if (existing) return existing;
        }
      }
      throw e;
    }
  }
}
