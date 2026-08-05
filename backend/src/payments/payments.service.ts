import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService, isNonPaymentReason } from '../partners/referrals.service';
import { recordCommissionNonPayment } from '../partners/commission-audit';
import { ActivityService } from '../activity/activity.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private notifications: NotificationsService,
    private referrals: ReferralsService,
    // Audit-trail для отказов в партнёрской комиссии (см.
    // recordCommissionNonPayment). ActivityModule помечен @Global(),
    // поэтому дополнительный import в payments.module.ts не нужен.
    private activity: ActivityService,
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
    const VALID_CURRENCIES = ['USD', 'EUR', 'RUB', 'CNY', 'TJS', 'KZT', 'UZS', 'GBP', 'JPY', 'KRW', 'CAD', 'MYR'];
    const cur = (dto.currency || 'TJS').toUpperCase();
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
    // Уведомляем бухгалтеров и админа. Поддержка мульти-ролей (ТЗ §2):
    // юзер с ACCOUNTANT в roles[] но другой primary тоже попадает.
    const accountants = await this.prisma.user.findMany({
      where: {
        OR: [
          { role: { in: ['ADMIN', 'ACCOUNTANT'] } },
          { roles: { hasSome: ['ADMIN', 'ACCOUNTANT'] } },
        ],
      },
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

    // ── Партнёрская комиссия ──────────────────────────────────────────────
    //
    // ОДНА ТОЧКА ВХОДА С МОДУЛЕМ «СДЕЛКИ». Раньше здесь вызывался
    // referrals.creditCommission() — своё правило «за КАЖДЫЙ подтверждённый
    // платёж» с дедупом по (partnerId, paymentId)/(partnerId, transactionId),
    // которое НЕ ставило ReferralAttribution.commissionedAt. Одобрение
    // SubmissionPayment ходило в creditCommissionForAttributionOnce, где
    // дедуп — ровно этот штамп. Клиент, прошедший оба модуля, оплачивался
    // партнёру ДВАЖДЫ в любом порядке: старый путь создавал Commission и
    // оставлял commissionedAt = NULL, новый видел NULL и создавал вторую
    // (@@unique([partnerId, transactionId]) не срабатывал — финансовые
    // Transaction здесь и в «Сделках» разные строки). Правило основателя
    // «один раз за клиента» теперь одно на оба пути.
    //
    // applicationId не ищем: findAttribution внутри сам добирает ВСЕ заявки
    // студента (includeStudentApplications) — это шире прежнего «первая
    // заявка по createdAt» и покрывает лендинговую атрибуцию, заведённую на
    // заявку до появления Student.
    //
    // await, а не fire-and-forget: ответ бухгалтеру задерживается на одну
    // короткую транзакцию, зато ошибка гарантированно попадает в лог, а не
    // теряется при рестарте контейнера. Бросить наружу нельзя — оплата уже
    // закоммичена, и 500 заставил бы бухгалтера подтверждать её повторно.
    try {
      const credit = await this.referrals.creditCommissionForAttributionOnce({
        studentId: payment.studentId,
        baseAmountCents: Math.round(amount * 100),
        baseCurrency: payment.currency,
        paymentId: payment.id,
        transactionId: result.transaction.id,
        sourceLabel: `Оплата студента: ${payment.student?.fullName || ''}`,
      });
      if (credit.credited) {
        this.logger.log(
          `Партнёрская комиссия начислена: partner=${credit.partnerId}, ` +
            `commission=${credit.commissionId}, ${credit.amountCents} копеек TJS ` +
            `(payment=${payment.id})`,
        );
      } else if (isNonPaymentReason(credit.reason)) {
        // ОТКАЗ В ДЕНЬГАХ живому партнёру: студент оплатил, партнёр
        // существует и реально его привёл, а комиссии не будет. Этот исход
        // молчал вместе со штатными — партнёр приходил с вопросом «почему мне
        // не заплатили», и ни лога, ни строки аудита не существовало.
        await recordCommissionNonPayment(
          { logger: this.logger, activity: this.activity },
          {
            reason: credit.reason,
            partnerId: credit.partnerId,
            partnerName: credit.partnerName,
            studentId: payment.studentId,
            actorId: accountantId,
            actorRole: 'ACCOUNTANT',
            context: `Оплата #${payment.id.slice(0, 8)} (${amount} ${payment.currency})`,
            payload: {
              paymentId: payment.id,
              transactionId: result.transaction.id,
              amount,
              currency: payment.currency,
            },
          },
        );
      }
      // Остальные исходы (no-attribution / already-credited / race-lost /
      // zero-rate) штатные и молчаливые: большинство студентов приходят сами,
      // повтор по уже оплаченному клиенту — ожидаемая работа guard'а, а
      // zero-rate штамп не ставит и клиента для партнёра не сжигает.
    } catch (e) {
      this.logger.error(
        `Не удалось начислить партнёрскую комиссию по оплате ${payment.id} ` +
          `(student=${payment.studentId}): ${(e as Error).message}`,
        (e as Error).stack,
      );
    }

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
