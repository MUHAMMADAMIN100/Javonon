import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService } from '../partners/referrals.service';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private notifications: NotificationsService,
    private referrals: ReferralsService,
  ) {}

  /** Студент создаёт payment-запрос. */
  async createByStudent(studentId: string, dto: { amount: number; currency?: string; method?: PaymentMethod; comment?: string }) {
    // QA-fix #16/#19/#20/#21: жёсткая type-проверка amount.
    // Раньше "abc"/NaN падали в 500, true→1, [100]→100 (JS coercion).
    if (typeof dto.amount !== 'number' || !isFinite(dto.amount) || isNaN(dto.amount)) {
      throw new BadRequestException('Сумма должна быть числом');
    }
    // QA-fix #18: 0.001 → Math.round(0.1)/100 = 0, проходило проверку >0.
    // Минимум 1 цент эквивалент (0.01).
    if (dto.amount < 0.01) {
      throw new BadRequestException('Сумма должна быть не меньше 0.01');
    }
    // QA-fix #17: ограничение сверху, чтобы 1e20 не пробил UI/финансы.
    if (dto.amount > 1_000_000) {
      throw new BadRequestException('Сумма не может превышать 1 000 000');
    }
    // QA-fix: валидируем method (был 500 при FOOBAR)
    const VALID_METHODS: PaymentMethod[] = ['CARD', 'BANK_TRANSFER', 'CASH', 'CRYPTO', 'OTHER'];
    if (dto.method && !VALID_METHODS.includes(dto.method)) {
      throw new BadRequestException('Неизвестный способ оплаты');
    }
    // QA-fix #14: проверяем валюту против белого списка реально поддерживаемых.
    const VALID_CURRENCIES = ['USD', 'EUR', 'RUB', 'CNY', 'TJS', 'KZT', 'UZS', 'GBP', 'JPY', 'KRW'];
    const cur = (dto.currency || 'USD').toUpperCase();
    if (!VALID_CURRENCIES.includes(cur)) {
      throw new BadRequestException(`Неподдерживаемая валюта. Доступно: ${VALID_CURRENCIES.join(', ')}`);
    }
    // QA-fix #22: ограничение длины комментария.
    const comment = dto.comment?.trim() || null;
    if (comment && comment.length > 1000) {
      throw new BadRequestException('Комментарий слишком длинный (макс. 1000 символов)');
    }
    const payment = await this.prisma.payment.create({
      data: {
        studentId,
        amount: Math.round(dto.amount * 100) / 100, // округляем до копеек
        currency: cur,
        method: dto.method || 'BANK_TRANSFER',
        comment,
      },
      include: { student: { select: { id: true, fullName: true, email: true } } },
    });
    // Уведомляем бухгалтеров и админа
    const accountants = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'ACCOUNTANT'] } },
      select: { id: true },
    });
    for (const u of accountants) {
      await this.notifications.notifyUser(u.id, {
        type: 'PAYMENT_PENDING',
        title: '💳 Новая заявка на оплату',
        message: `${payment.student?.fullName} — ${payment.amount} ${payment.currency}`,
        payload: { paymentId: payment.id },
      });
    }
    this.realtime.emitStaff('payment:pending', { payment });
    return payment;
  }

  /** Бухгалтер подтверждает payment → создаётся транзакция.
   *  QA-fix: атомарное update + create через $transaction.
   *  Раньше параллельные confirm создавали несколько транзакций на одну оплату.
   *  Теперь updateMany(...where: PENDING) гарантирует, что только один процесс
   *  «возьмёт» оплату, остальные получат BadRequestException.
   */
  async confirmByAccountant(id: string, accountantId: string, dto: { actualAmount?: number; method?: PaymentMethod }) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { student: { select: { id: true, fullName: true, managerId: true } } },
    });
    if (!payment) throw new NotFoundException('Payment не найден');
    if (payment.status !== 'PENDING') throw new BadRequestException('Уже обработан');

    // Валидация actualAmount: дефолт = заявленная сумма, иначе число > 0
    // и не больше 10x от оригинала (защита от опечатки $100 → $100000).
    let amount = payment.amount;
    if (dto.actualAmount !== undefined && dto.actualAmount !== null) {
      const a = Number(dto.actualAmount);
      if (!isFinite(a) || isNaN(a)) {
        throw new BadRequestException('actualAmount должен быть числом');
      }
      if (a < 0.01) {
        throw new BadRequestException('actualAmount должен быть > 0');
      }
      if (a > payment.amount * 10) {
        throw new BadRequestException(
          'actualAmount слишком сильно отличается от заявленной суммы',
        );
      }
      amount = Math.round(a * 100) / 100;
    }
    // Method validation
    if (dto.method) {
      const VALID: PaymentMethod[] = ['CARD', 'BANK_TRANSFER', 'CASH', 'CRYPTO', 'OTHER'];
      if (!VALID.includes(dto.method)) {
        throw new BadRequestException('Неизвестный способ оплаты');
      }
    }

    // Атомарно: пытаемся забрать payment из PENDING + создаём транзакцию.
    // Если другой процесс успел первым — updateMany.count = 0, бросаем ошибку.
    const result = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.payment.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'CONFIRMED',
          method: dto.method || payment.method,
          confirmedById: accountantId,
          confirmedAt: new Date(),
        },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Уже обработан другим бухгалтером');
      }
      const transaction = await tx.transaction.create({
        data: {
          type: 'INCOME',
          category: 'TUITION_PAYMENT',
          amount,
          currency: payment.currency,
          comment: `Подтверждённая оплата: ${payment.comment || 'без комментария'}`,
          date: new Date(),
          studentId: payment.studentId,
          managerId: payment.student?.managerId || null,
          recordedById: accountantId,
        },
      });
      const updated = await tx.payment.update({
        where: { id },
        data: { transactionId: transaction.id },
        include: { student: { select: { id: true, fullName: true } } },
      });
      return { updated, transaction };
    });

    this.realtime.emitStudent(payment.studentId, 'payment:confirmed', { payment: result.updated, transaction: result.transaction });
    this.realtime.emitStaff('payment:confirmed', { payment: result.updated });

    // Реферальная комиссия (fire-and-forget — не блокирует ответ).
    // Если студент пришёл от партнёра → создаём Commission и пополняем баланс.
    (async () => {
      try {
        const partner = await this.referrals.resolvePartner({
          studentId: payment.studentId,
        });
        if (partner) {
          await this.referrals.creditCommission({
            partnerId: partner.id,
            amountCents: Math.round(amount * 100),
            currency: payment.currency,
            paymentId: payment.id,
            transactionId: result.transaction.id,
            note: `Студент: ${payment.student?.fullName || ''}`,
          });
        }
      } catch (e) {
        // Не валим основной flow — комиссия может быть восстановлена админом.
        // eslint-disable-next-line no-console
        console.error('[partner] commission credit failed', e);
      }
    })();

    return result.updated;
  }

  async rejectByAccountant(id: string, accountantId: string, comment?: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException();
    if (payment.status !== 'PENDING') throw new BadRequestException('Уже обработан');
    const updated = await this.prisma.payment.update({
      where: { id },
      data: {
        status: 'REJECTED',
        confirmedById: accountantId,
        confirmedAt: new Date(),
        comment: comment ? `${payment.comment ? payment.comment + ' · ' : ''}Отклонено: ${comment}` : payment.comment,
      },
    });
    this.realtime.emitStudent(payment.studentId, 'payment:rejected', { payment: updated });
    return updated;
  }

  async cancelByStudent(id: string, studentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException();
    if (payment.studentId !== studentId) throw new BadRequestException('Не ваш платёж');
    if (payment.status !== 'PENDING') throw new BadRequestException('Нельзя отменить');
    return this.prisma.payment.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  async listForStudent(studentId: string) {
    return this.prisma.payment.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listAll(filters: { status?: PaymentStatus }) {
    return this.prisma.payment.findMany({
      where: { ...(filters.status && { status: filters.status }) },
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { id: true, fullName: true, email: true, phones: true, managerId: true } },
        confirmedBy: { select: { id: true, fullName: true } },
      },
    });
  }
}
