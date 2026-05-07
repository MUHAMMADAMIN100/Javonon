import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private notifications: NotificationsService,
  ) {}

  /** Студент создаёт payment-запрос. */
  async createByStudent(studentId: string, dto: { amount: number; currency?: string; method?: PaymentMethod; comment?: string }) {
    if (!dto.amount || dto.amount <= 0) throw new BadRequestException('Сумма должна быть > 0');
    // QA-fix: валидируем method (был 500 при FOOBAR)
    const VALID_METHODS: PaymentMethod[] = ['CARD', 'BANK_TRANSFER', 'CASH', 'CRYPTO', 'OTHER'];
    if (dto.method && !VALID_METHODS.includes(dto.method)) {
      throw new BadRequestException('Неизвестный способ оплаты');
    }
    // QA-fix: валидируем валюту (3 латинские буквы)
    const cur = (dto.currency || 'USD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
      throw new BadRequestException('Валюта должна быть 3-буквенным кодом (USD, EUR, и т.д.)');
    }
    const payment = await this.prisma.payment.create({
      data: {
        studentId,
        amount: Math.round(dto.amount * 100) / 100, // округляем до копеек
        currency: cur,
        method: dto.method || 'BANK_TRANSFER',
        comment: dto.comment?.trim() || null,
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

  /** Бухгалтер подтверждает payment → создаётся транзакция. */
  async confirmByAccountant(id: string, accountantId: string, dto: { actualAmount?: number; method?: PaymentMethod }) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { student: { select: { id: true, fullName: true, managerId: true } } },
    });
    if (!payment) throw new NotFoundException('Payment не найден');
    if (payment.status !== 'PENDING') throw new BadRequestException('Уже обработан');

    const amount = dto.actualAmount || payment.amount;

    // Создаём транзакцию-доход
    const transaction = await this.prisma.transaction.create({
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

    const updated = await this.prisma.payment.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        method: dto.method || payment.method,
        confirmedById: accountantId,
        confirmedAt: new Date(),
        transactionId: transaction.id,
      },
      include: { student: { select: { id: true, fullName: true } } },
    });

    // Уведомляем студента
    this.realtime.emitStudent(payment.studentId, 'payment:confirmed', { payment: updated, transaction });
    this.realtime.emitStaff('payment:confirmed', { payment: updated });
    return updated;
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
