import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { isFounder } from '../auth/role-utils';
import { SubmissionStatus, SubmissionPaymentStatus, SubmissionPaymentMethod } from '@prisma/client';

/**
 * SaleSubmission workflow.
 *
 * Менеджер создаёт SaleSubmission через POST /submissions:
 *   - Студент (существующий по studentId ИЛИ новый snapshot ниже)
 *   - Программа, контракт-файл, общая сумма
 *   - ПЕРВЫЙ Payment (всегда обязателен): сумма, метод, дата, чек
 *
 * FOUNDER одобряет/отклоняет каждый Payment отдельно через
 * POST /submissions/payments/:id/approve|reject.
 *
 * Бонус менеджеру = sum(APPROVED payments за месяц) × bonusPercent.
 * Источник для salary.service.
 */

interface CreateSubmissionDto {
  studentId?: string | null;
  // если studentId не задан — обязательно новый студент:
  newStudentName?: string;
  newStudentPhone?: string;
  newStudentEmail?: string;
  newStudentPassportUrl?: string;
  programId: string;
  contractUrl: string;
  totalAmount: number;
  currency?: string;
  notes?: string;
  // Первый платёж — обязателен.
  firstPayment: CreatePaymentDto;
}

interface CreatePaymentDto {
  amount: number;
  paymentMethod?: SubmissionPaymentMethod;
  paidAt: string | Date;
  receiptUrl?: string;
  depositProofUrl?: string;
  nextDueDate?: string | Date | null;
  nextDueAmount?: number | null;
  notes?: string;
}

@Injectable()
export class SubmissionsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
  ) {}

  /**
   * Менеджер создаёт новую сделку. Создаются SaleSubmission(ACTIVE) +
   * первый SubmissionPayment(PENDING). Student/Application НЕ создаются
   * пока FOUNDER не одобрит первый платёж.
   */
  async create(managerId: string, dto: CreateSubmissionDto) {
    if (!dto.programId) throw new BadRequestException('Программа обязательна');
    if (!dto.contractUrl) throw new BadRequestException('Контракт обязателен');
    if (typeof dto.totalAmount !== 'number' || !isFinite(dto.totalAmount) || dto.totalAmount <= 0) {
      throw new BadRequestException('Сумма контракта должна быть > 0');
    }
    if (!dto.firstPayment) throw new BadRequestException('Первый платёж обязателен');

    // Студент: либо ссылка на существующего, либо snapshot нового.
    if (!dto.studentId) {
      if (!dto.newStudentName || dto.newStudentName.trim().length < 2) {
        throw new BadRequestException('ФИО студента обязательно (мин. 2 символа)');
      }
    } else {
      const exists = await this.prisma.student.findUnique({ where: { id: dto.studentId } });
      if (!exists) throw new NotFoundException('Студент не найден');
    }

    const program = await this.prisma.program.findUnique({ where: { id: dto.programId } });
    if (!program) throw new NotFoundException('Программа не найдена');

    const p = dto.firstPayment;
    if (typeof p.amount !== 'number' || !isFinite(p.amount) || p.amount <= 0) {
      throw new BadRequestException('Сумма платежа должна быть > 0');
    }

    const submission = await this.prisma.saleSubmission.create({
      data: {
        managerId,
        studentId: dto.studentId || null,
        newStudentName: dto.studentId ? null : (dto.newStudentName?.trim() || null),
        newStudentPhone: dto.studentId ? null : (dto.newStudentPhone?.trim() || null),
        newStudentEmail: dto.studentId ? null : (dto.newStudentEmail?.trim()?.toLowerCase() || null),
        newStudentPassportUrl: dto.studentId ? null : (dto.newStudentPassportUrl || null),
        programId: dto.programId,
        contractUrl: dto.contractUrl,
        totalAmount: dto.totalAmount,
        currency: dto.currency || 'USD',
        notes: dto.notes?.trim() || null,
        status: SubmissionStatus.ACTIVE,
        payments: {
          create: {
            amount: p.amount,
            paymentMethod: p.paymentMethod || SubmissionPaymentMethod.TRANSFER,
            paidAt: new Date(p.paidAt),
            receiptUrl: p.receiptUrl || null,
            depositProofUrl: p.depositProofUrl || null,
            nextDueDate: p.nextDueDate ? new Date(p.nextDueDate) : null,
            nextDueAmount: p.nextDueAmount ?? null,
            notes: p.notes?.trim() || null,
            status: SubmissionPaymentStatus.PENDING,
          },
        },
      },
      include: { payments: true, program: true, student: true },
    });

    this.realtime.emitStaff('submission:new', { submissionId: submission.id, managerId });
    return submission;
  }

  /** Добавить новый платёж к существующей сделке (продолжение оплаты). */
  async addPayment(userId: string, submissionId: string, dto: CreatePaymentDto) {
    const submission = await this.prisma.saleSubmission.findUnique({
      where: { id: submissionId },
      include: { payments: true },
    });
    if (!submission) throw new NotFoundException('Сделка не найдена');
    if (submission.managerId !== userId) {
      throw new ForbiddenException('Это не ваша сделка');
    }
    if (submission.status !== SubmissionStatus.ACTIVE) {
      throw new BadRequestException('Сделка закрыта, новые платежи добавлять нельзя');
    }
    if (typeof dto.amount !== 'number' || !isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Сумма платежа должна быть > 0');
    }

    const payment = await this.prisma.submissionPayment.create({
      data: {
        submissionId,
        amount: dto.amount,
        paymentMethod: dto.paymentMethod || SubmissionPaymentMethod.TRANSFER,
        paidAt: new Date(dto.paidAt),
        receiptUrl: dto.receiptUrl || null,
        depositProofUrl: dto.depositProofUrl || null,
        nextDueDate: dto.nextDueDate ? new Date(dto.nextDueDate) : null,
        nextDueAmount: dto.nextDueAmount ?? null,
        notes: dto.notes?.trim() || null,
        status: SubmissionPaymentStatus.PENDING,
      },
    });
    this.realtime.emitStaff('submission:payment-new', { submissionId, paymentId: payment.id });
    return payment;
  }

  /** Список моих сделок (для менеджера). */
  async listMine(managerId: string, opts: { status?: SubmissionStatus } = {}) {
    return this.prisma.saleSubmission.findMany({
      where: {
        managerId,
        ...(opts.status && { status: opts.status }),
      },
      include: {
        program: { select: { id: true, name: true, university: true } },
        student: { select: { id: true, fullName: true } },
        payments: { orderBy: { paidAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** FOUNDER: список всех сделок с фильтрами. */
  async listAll(opts: {
    status?: SubmissionStatus;
    paymentStatus?: SubmissionPaymentStatus;
    managerId?: string;
    take?: number;
  } = {}) {
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.managerId) where.managerId = opts.managerId;
    if (opts.paymentStatus) {
      where.payments = { some: { status: opts.paymentStatus } };
    }
    return this.prisma.saleSubmission.findMany({
      where,
      include: {
        program: { select: { id: true, name: true, university: true } },
        student: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true, role: true } },
        payments: { orderBy: { paidAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take || 200, 500),
    });
  }

  /** FOUNDER: список платежей ожидающих одобрения. */
  async listPendingPayments() {
    return this.prisma.submissionPayment.findMany({
      where: { status: SubmissionPaymentStatus.PENDING },
      include: {
        submission: {
          include: {
            program: { select: { id: true, name: true, university: true } },
            student: { select: { id: true, fullName: true } },
            manager: { select: { id: true, fullName: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOne(id: string) {
    const s = await this.prisma.saleSubmission.findUnique({
      where: { id },
      include: {
        program: true,
        student: true,
        manager: { select: { id: true, fullName: true, role: true } },
        application: true,
        payments: {
          orderBy: { paidAt: 'desc' },
          include: { reviewedBy: { select: { id: true, fullName: true } } },
        },
      },
    });
    if (!s) throw new NotFoundException('Сделка не найдена');
    return s;
  }

  /**
   * FOUNDER одобряет платёж. Если это первый APPROVED payment в
   * subscription — атомарно создаём Student (если новый) + Application.
   * Всегда создаём FinanceTransaction (доход) с привязкой к Submission.
   */
  async approvePayment(paymentId: string, reviewerId: string) {
    const reviewer = await this.prisma.user.findUnique({
      where: { id: reviewerId },
      select: { id: true, role: true, roles: true },
    });
    if (!reviewer || !isFounder(reviewer as any)) {
      throw new ForbiddenException('Только основатель может одобрять');
    }

    const payment = await this.prisma.submissionPayment.findUnique({
      where: { id: paymentId },
      include: { submission: { include: { program: true, payments: true } } },
    });
    if (!payment) throw new NotFoundException('Платёж не найден');
    if (payment.status !== SubmissionPaymentStatus.PENDING) {
      throw new BadRequestException('Платёж уже разобран');
    }

    const submission = payment.submission;
    const isFirstApproval = !submission.firstApprovedAt;

    // На первый APPROVE создаём Student (если новый) + Application.
    let studentId = submission.studentId;
    let applicationId = submission.applicationId;

    if (isFirstApproval) {
      if (!studentId) {
        // Создаём студента из snapshot.
        const newStudent = await this.prisma.student.create({
          data: {
            fullName: submission.newStudentName || 'Без имени',
            phones: submission.newStudentPhone ? [submission.newStudentPhone] : [],
            email: submission.newStudentEmail || null,
            direction: submission.program.direction,
            cabinet: 1, // default; FOUNDER может изменить вручную
            managerId: submission.managerId,
            programId: submission.programId,
          },
        });
        studentId = newStudent.id;

        // Если был загружен паспорт — создаём Document.
        if (submission.newStudentPassportUrl) {
          await this.prisma.document.create({
            data: {
              studentId: newStudent.id,
              filename: submission.newStudentPassportUrl.split('/').pop() || 'passport',
              originalName: 'passport',
              mimeType: 'application/octet-stream',
              size: 0,
              url: submission.newStudentPassportUrl,
              type: 'PASSPORT',
            },
          });
        }
      }

      // Application — всегда новая запись с status=ENROLLED.
      const stu = await this.prisma.student.findUnique({
        where: { id: studentId! },
        select: { fullName: true, phones: true },
      });
      const phone = (stu?.phones && stu.phones[0]) || submission.newStudentPhone || '';
      const newApp = await this.prisma.application.create({
        data: {
          studentId: studentId!,
          fullName: stu?.fullName || 'Студент',
          phone,
          direction: submission.program.direction,
          programId: submission.programId,
          status: 'ENROLLED',
          managerId: submission.managerId,
        },
      });
      applicationId = newApp.id;

      // Контракт — добавляем как документ студента.
      await this.prisma.document.create({
        data: {
          studentId: studentId!,
          filename: submission.contractUrl.split('/').pop() || 'contract',
          originalName: 'contract',
          mimeType: 'application/octet-stream',
          size: 0,
          url: submission.contractUrl,
          type: 'CONTRACT',
        },
      });
    }

    // Создаём финансовую транзакцию (доход).
    const tx = await this.prisma.transaction.create({
      data: {
        type: 'INCOME',
        category: 'TUITION_PAYMENT',
        amount: payment.amount,
        currency: submission.currency,
        date: payment.paidAt,
        comment: `Платёж по сделке #${submission.id.slice(0, 8)} (${submission.program.name})`,
        studentId: studentId!,
        managerId: submission.managerId,
        recordedById: reviewerId,
      },
    });

    // Обновляем submission + payment.
    await this.prisma.saleSubmission.update({
      where: { id: submission.id },
      data: {
        studentId,
        applicationId,
        firstApprovedAt: submission.firstApprovedAt || new Date(),
      },
    });
    const upd = await this.prisma.submissionPayment.update({
      where: { id: paymentId },
      data: {
        status: SubmissionPaymentStatus.APPROVED,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        financeTransactionId: tx.id,
      },
    });

    this.realtime.emitUser(submission.managerId, 'submission:approved', { paymentId, submissionId: submission.id });
    this.realtime.emitStaff('submission:reviewed', { paymentId, status: 'APPROVED' });
    return upd;
  }

  /** FOUNDER отклоняет платёж с обязательной причиной. */
  async rejectPayment(paymentId: string, reviewerId: string, reason: string) {
    const reviewer = await this.prisma.user.findUnique({
      where: { id: reviewerId },
      select: { id: true, role: true, roles: true },
    });
    if (!reviewer || !isFounder(reviewer as any)) {
      throw new ForbiddenException('Только основатель может отклонять');
    }

    const r = (reason || '').trim();
    if (!r) throw new BadRequestException('Укажите причину отклонения');
    if (r.length > 500) throw new BadRequestException('Причина слишком длинная (макс. 500)');

    const payment = await this.prisma.submissionPayment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Платёж не найден');
    if (payment.status !== SubmissionPaymentStatus.PENDING) {
      throw new BadRequestException('Платёж уже разобран');
    }

    const upd = await this.prisma.submissionPayment.update({
      where: { id: paymentId },
      data: {
        status: SubmissionPaymentStatus.REJECTED,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        rejectReason: r,
      },
    });

    const submission = await this.prisma.saleSubmission.findUnique({
      where: { id: payment.submissionId },
      select: { managerId: true },
    });
    if (submission) {
      this.realtime.emitUser(submission.managerId, 'submission:rejected', { paymentId, reason: r });
    }
    this.realtime.emitStaff('submission:reviewed', { paymentId, status: 'REJECTED' });
    return upd;
  }

  /** Менеджер помечает сделку как COMPLETED/CANCELLED. */
  async changeStatus(userId: string, submissionId: string, status: SubmissionStatus) {
    const submission = await this.prisma.saleSubmission.findUnique({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Сделка не найдена');
    if (submission.managerId !== userId) {
      throw new ForbiddenException('Это не ваша сделка');
    }
    if (status !== SubmissionStatus.COMPLETED && status !== SubmissionStatus.CANCELLED) {
      throw new BadRequestException('Можно ставить только COMPLETED или CANCELLED');
    }
    return this.prisma.saleSubmission.update({
      where: { id: submissionId },
      data: { status },
    });
  }

  /**
   * Сумма APPROVED платежей менеджера за период — для salary.service.
   * Используется как источник бонусной базы вместо ручных Transaction'ов.
   */
  async approvedBonusableForUser(userId: string, from: Date, to: Date): Promise<number> {
    const sum = await this.prisma.submissionPayment.aggregate({
      where: {
        status: SubmissionPaymentStatus.APPROVED,
        reviewedAt: { gte: from, lte: to },
        submission: { managerId: userId },
      },
      _sum: { amount: true },
    });
    return sum._sum.amount || 0;
  }
}
