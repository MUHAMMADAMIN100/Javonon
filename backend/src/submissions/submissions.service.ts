import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, Optional } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ActivityService } from '../activity/activity.service';
import {
  ReferralsService,
  isNonPaymentReason,
  type CommissionReversal,
} from '../partners/referrals.service';
import { recordCommissionNonPayment } from '../partners/commission-audit';
import {
  COMMISSION_OUTBOX_INLINE_GRACE_MS,
  CommissionOutboxService,
} from '../partners/commission-outbox.service';
import { canSeePartnerAttribution, hasRole, isFounder, UserWithRoles } from '../auth/role-utils';
import {
  SubmissionStatus,
  SubmissionPaymentStatus,
  SubmissionPaymentMethod,
  Prisma,
  IncomeSource,
  ProductCategory,
  PaymentPhaseStatus,
} from '@prisma/client';
import { CABINET_BY_DIRECTION, DEFAULT_CABINET } from '../common/cabinets';

/**
 * Bug #31 (HIGH): студент, созданный из SaleSubmission через approvePayment,
 * раньше шёл в prisma.student.create без поля password — оно оставалось null,
 * и студент никогда не мог залогиниться в LMS / payments (JWT-стратегия
 * требует bcrypt.compare с непустым хэшем).
 *
 * На первый APPROVE генерим plain-пароль (8 символов, без визуально
 * неоднозначных I/l/O/0/1), хешируем bcrypt'ом (cost=10 — как
 * StudentsService.create) и сохраняем хэш. Сам plain возвращаем FOUNDER'у
 * в ответе approvePayment под `studentCredentials`, чтобы менеджер передал
 * клиенту вместе с email'ом. Алфавит и длина совпадают с
 * StudentsService.generatePassword, поэтому UX одинаковый.
 */
function generateStudentPassword(length = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Парсит дату платежа с учётом таймзоны Asia/Dushanbe (UTC+5).
 *
 * Фронт обычно шлёт `YYYY-MM-DD` (из <input type="date">). Если такую строку
 * передать в `new Date()`, JS интерпретирует её как UTC midnight, что в Душанбе
 * соответствует 05:00 утра того же дня — а при форматировании обратно в UTC
 * (например, `toISOString().slice(0, 10)` для клиентов в UTC-) дата сдвинется
 * на сутки назад. Кроме того, в salary.service фильтрация идёт по месяцу UTC,
 * поэтому платёж 1-го числа в полночь Душанбе попал бы в предыдущий месяц.
 *
 * Этот helper приводит `YYYY-MM-DD` к полуночи Душанбе (то есть 19:00 UTC
 * предыдущего дня), а полноценные ISO-строки/Date — пропускает как есть.
 */
function parseClientDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00+05:00`);
  }
  return new Date(value);
}

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
  /**
   * Заявка-ИСТОЧНИК: лид, из которого менеджер завёл сделку («Создать сделку»
   * в карточке заявки). Ложится в SaleSubmission.sourceApplicationId и НЕ
   * имеет отношения к SaleSubmission.applicationId — ту создаёт одобрение
   * первого платежа.
   *
   * Это единственный мост от партнёрской атрибуции к сделке, когда менеджер
   * пропустил конвертацию лида в студента и завёл сделку вкладкой «Новый»:
   * тогда studentId ещё null, а атрибуция с лендинга висит на этом лиде.
   * Подробнее — комментарий к колонке в schema.prisma.
   */
  applicationId?: string | null;
  // Если studentId ЗАДАН (existing student) и менеджер прислал этот email —
  // обновим Student.email атомарно после проверки уникальности. Для нового
  // студента идёт в newStudentEmail (snapshot до APPROVE).
  existingStudentEmail?: string | null;
  // если studentId не задан — обязательно новый студент:
  newStudentName?: string;
  newStudentPhone?: string;
  newStudentEmail?: string;
  newStudentPassportUrls?: string[];
  // Метаданные файлов паспорта (из ответа /submissions/upload). Нужны чтобы
  // при APPROVE создать Document с реальным mimeType/size/originalName,
  // а не плейсхолдером application/octet-stream/0/'passport'.
  newStudentPassportMimes?: string[];
  newStudentPassportSizes?: number[];
  newStudentPassportOriginalNames?: string[];
  programId: string;
  contractUrls?: string[];
  // Метаданные файлов контракта (см. выше про паспорт).
  contractMimes?: string[];
  contractSizes?: number[];
  contractOriginalNames?: string[];
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
  receiptUrls?: string[];
  depositProofUrls?: string[];
  nextDueDate?: string | Date | null;
  nextDueAmount?: number | null;
  notes?: string;
}

@Injectable()
export class SubmissionsService {
  private readonly logger = new Logger(SubmissionsService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    // ActivityService для audit-trail финансовых мутаций (approvePayment /
    // changeStatus refund). Раньше SubmissionsService создавал Transaction
    // напрямую в $transaction, но не писал ни строчки в ActivityLog — FOUNDER
    // не мог связать сырую строку Transaction в дашборде с решением об
    // одобрении/отмене. ActivityModule помечен @Global(), поэтому в
    // submissions.module.ts дополнительный import не нужен.
    private activity: ActivityService,
    // Партнёрская комиссия по сделке (см. approvePayment). @Optional() —
    // как в ApplicationsService: если модуль собран без PartnersModule,
    // сделки продолжают работать, просто без начислений (в approvePayment
    // стоит явная проверка на наличие сервиса + логирование).
    // PartnersModule ничего из submissions/ не импортирует, поэтому
    // forwardRef не нужен.
    @Optional() private referrals?: ReferralsService,
    // Outbox партнёрской комиссии: строка пишется внутри транзакции
    // одобрения, а этот сервис её закрывает (settle) или откладывает
    // (defer). @Optional() по той же причине, что и referrals — без
    // PartnersModule строка просто дождётся cron'а.
    @Optional() private commissionOutbox?: CommissionOutboxService,
  ) {}

  /**
   * Менеджер создаёт новую сделку. Создаются SaleSubmission(ACTIVE) +
   * первый SubmissionPayment(PENDING). Student/Application НЕ создаются
   * пока FOUNDER не одобрит первый платёж.
   */
  async create(managerId: string, dto: CreateSubmissionDto) {
    if (!dto.programId) throw new BadRequestException('Программа обязательна');
    if (!Array.isArray(dto.contractUrls) || dto.contractUrls.length === 0) {
      throw new BadRequestException('Загрузите минимум 1 файл контракта');
    }
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
      // Если менеджер прислал новый email для существующего студента —
      // обновляем Student.email с проверкой уникальности.
      if (dto.existingStudentEmail !== undefined) {
        const emailRaw = dto.existingStudentEmail
          ? String(dto.existingStudentEmail).trim().toLowerCase()
          : null;
        if (emailRaw && emailRaw !== exists.email) {
          const busy = await this.prisma.student.findFirst({
            where: { email: emailRaw, id: { not: dto.studentId } },
            select: { id: true },
          });
          if (busy) {
            throw new BadRequestException(
              'Email уже используется другим студентом',
            );
          }
          await this.prisma.student.update({
            where: { id: dto.studentId },
            data: { email: emailRaw },
          });
        }
      }
    }

    const program = await this.prisma.program.findUnique({ where: { id: dto.programId } });
    if (!program) throw new NotFoundException('Программа не найдена');

    // Заявка-источник (кнопка «Создать сделку» в карточке заявки). Проверяем
    // существование ЗДЕСЬ, а не полагаемся на FK: FK-ошибка вылезла бы из
    // saleSubmission.create как P2003 → bare 500, а менеджеру нужно понятное
    // «заявка не найдена». Пустую строку из query-параметра трактуем как
    // отсутствие ссылки, а не как «искать заявку с id ''».
    const sourceApplicationIdRaw =
      typeof dto.applicationId === 'string' ? dto.applicationId.trim() : '';
    let sourceApplicationId: string | null = null;
    if (sourceApplicationIdRaw) {
      const sourceApp = await this.prisma.application.findUnique({
        where: { id: sourceApplicationIdRaw },
        select: { id: true },
      });
      if (!sourceApp) throw new NotFoundException('Заявка-источник не найдена');
      sourceApplicationId = sourceApp.id;
    }

    const p = dto.firstPayment;
    if (typeof p.amount !== 'number' || !isFinite(p.amount) || p.amount <= 0) {
      throw new BadRequestException('Сумма платежа должна быть > 0');
    }

    const paidAt = parseClientDate(p.paidAt as any);
    if (isNaN(paidAt.getTime())) {
      throw new BadRequestException('Некорректная дата платежа (paidAt)');
    }
    let nextDueDate: Date | null = null;
    if (p.nextDueDate) {
      nextDueDate = parseClientDate(p.nextDueDate as any);
      if (isNaN(nextDueDate.getTime())) {
        throw new BadRequestException('Некорректная дата следующего платежа');
      }
    }

    // Snapshot метаданных паспорта — пишем только если есть хотя бы один файл
    // и менеджер передал нового студента (для existing-студента snapshot = []).
    const hasPassport = !dto.studentId
      && Array.isArray(dto.newStudentPassportUrls)
      && dto.newStudentPassportUrls.length > 0;
    const passportUrls: string[] = hasPassport ? (dto.newStudentPassportUrls as string[]) : [];
    const passportMimes: string[] = hasPassport && Array.isArray(dto.newStudentPassportMimes)
      ? dto.newStudentPassportMimes.map((m) => (typeof m === 'string' ? m.trim() : ''))
      : [];
    const passportSizes: number[] = hasPassport && Array.isArray(dto.newStudentPassportSizes)
      ? dto.newStudentPassportSizes.map((n) =>
          Number.isFinite(n as number) ? Math.max(0, Math.trunc(n as number)) : 0,
        )
      : [];
    const passportOriginalNames: string[] = hasPassport && Array.isArray(dto.newStudentPassportOriginalNames)
      ? dto.newStudentPassportOriginalNames.map((s) => (typeof s === 'string' ? s.trim() : ''))
      : [];

    const ctrUrls: string[] = dto.contractUrls;
    const ctrMimes: string[] = Array.isArray(dto.contractMimes)
      ? dto.contractMimes.map((m) => (typeof m === 'string' ? m.trim() : ''))
      : [];
    const ctrSizes: number[] = Array.isArray(dto.contractSizes)
      ? dto.contractSizes.map((n) =>
          Number.isFinite(n as number) ? Math.max(0, Math.trunc(n as number)) : 0,
        )
      : [];
    const ctrOriginalNames: string[] = Array.isArray(dto.contractOriginalNames)
      ? dto.contractOriginalNames.map((s) => (typeof s === 'string' ? s.trim() : ''))
      : [];

    // Валидация файлов первого платежа: TRANSFER требует минимум 1 чек,
    // CASH — минимум 1 скрин пополнения.
    const firstMethod = p.paymentMethod || SubmissionPaymentMethod.TRANSFER;
    const firstReceiptUrls: string[] = Array.isArray(p.receiptUrls) ? p.receiptUrls : [];
    const firstDepositProofUrls: string[] = Array.isArray(p.depositProofUrls) ? p.depositProofUrls : [];
    if (firstMethod === SubmissionPaymentMethod.TRANSFER && firstReceiptUrls.length === 0) {
      throw new BadRequestException('Загрузите минимум 1 чек перевода');
    }
    if (firstMethod === SubmissionPaymentMethod.CASH && firstDepositProofUrls.length === 0) {
      throw new BadRequestException('Загрузите минимум 1 скрин пополнения счёта');
    }

    // Идемпотентность: защита от двойного клика «Создать» и retry на
    // network timeout. Без этой проверки create() выполнится 2 раза и
    // создаст 2 SaleSubmission + 2 PENDING-платежа; после APPROVE обоих
    // получится 2 Application + 2 Transaction = удвоенный доход и бонус.
    // Если тот же менеджер за последние 60с уже создал submission с тем же
    // набором contractUrls + programId + totalAmount — возвращаем существующую запись.
    // contractUrls: { equals: ... } матчит по массиву (порядок важен, но клиент
    // строит массив детерминированно из ответов /upload).
    const DUPLICATE_WINDOW_MS = 60_000;
    const existing = await this.prisma.saleSubmission.findFirst({
      where: {
        managerId,
        contractUrls: { equals: ctrUrls },
        programId: dto.programId,
        totalAmount: dto.totalAmount,
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      include: { payments: true, program: true, student: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      // Идемпотентный ответ: возвращаем ту же сделку, новых записей не создаём.
      return existing;
    }

    const submission = await this.prisma.saleSubmission.create({
      data: {
        managerId,
        studentId: dto.studentId || null,
        newStudentName: dto.studentId ? null : (dto.newStudentName?.trim() || null),
        newStudentPhone: dto.studentId ? null : (dto.newStudentPhone?.trim() || null),
        newStudentEmail: dto.studentId ? null : (dto.newStudentEmail?.trim()?.toLowerCase() || null),
        newStudentPassportUrls: passportUrls,
        newStudentPassportMimes: passportMimes,
        newStudentPassportSizes: passportSizes,
        newStudentPassportOriginalNames: passportOriginalNames,
        programId: dto.programId,
        // Мост «лид с лендинга → сделка». Пишется ТОЛЬКО здесь, при создании:
        // после первого одобрения любая перезапись стёрла бы связь с
        // атрибуцией, ради которой колонка и заведена.
        sourceApplicationId,
        contractUrls: ctrUrls,
        contractMimes: ctrMimes,
        contractSizes: ctrSizes,
        contractOriginalNames: ctrOriginalNames,
        totalAmount: dto.totalAmount,
        currency: dto.currency || 'USD',
        notes: dto.notes?.trim() || null,
        status: SubmissionStatus.ACTIVE,
        payments: {
          create: {
            amount: p.amount,
            paymentMethod: firstMethod,
            paidAt,
            receiptUrls: firstReceiptUrls,
            depositProofUrls: firstDepositProofUrls,
            nextDueDate,
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
    // managerId может быть null, если исходный менеджер удалён (SetNull) —
    // такая сделка считается «осиротевшей» и редактировать её нельзя.
    if (submission.managerId === null || submission.managerId !== userId) {
      throw new ForbiddenException('Это не ваша сделка');
    }
    if (submission.status !== SubmissionStatus.ACTIVE) {
      throw new BadRequestException('Сделка закрыта, новые платежи добавлять нельзя');
    }
    if (typeof dto.amount !== 'number' || !isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Сумма платежа должна быть > 0');
    }

    const paidAt = parseClientDate(dto.paidAt as any);
    if (isNaN(paidAt.getTime())) {
      throw new BadRequestException('Некорректная дата платежа (paidAt)');
    }
    let nextDueDate: Date | null = null;
    if (dto.nextDueDate) {
      nextDueDate = parseClientDate(dto.nextDueDate as any);
      if (isNaN(nextDueDate.getTime())) {
        throw new BadRequestException('Некорректная дата следующего платежа');
      }
    }

    const method = dto.paymentMethod || SubmissionPaymentMethod.TRANSFER;
    const addReceiptUrls: string[] = Array.isArray(dto.receiptUrls) ? dto.receiptUrls : [];
    const addDepositProofUrls: string[] = Array.isArray(dto.depositProofUrls) ? dto.depositProofUrls : [];
    if (method === SubmissionPaymentMethod.TRANSFER && addReceiptUrls.length === 0) {
      throw new BadRequestException('Загрузите минимум 1 чек перевода');
    }
    if (method === SubmissionPaymentMethod.CASH && addDepositProofUrls.length === 0) {
      throw new BadRequestException('Загрузите минимум 1 скрин пополнения счёта');
    }

    const payment = await this.prisma.submissionPayment.create({
      data: {
        submissionId,
        amount: dto.amount,
        paymentMethod: method,
        paidAt,
        receiptUrls: addReceiptUrls,
        depositProofUrls: addDepositProofUrls,
        nextDueDate,
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
    firstApproved?: boolean;
  } = {}) {
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.managerId) where.managerId = opts.managerId;
    if (opts.paymentStatus) {
      where.payments = { some: { status: opts.paymentStatus } };
    }
    if (opts.firstApproved) {
      where.firstApprovedAt = { not: null };
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

  async getOne(user: (UserWithRoles & { id: string }) | null | undefined, id: string) {
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
    // Authz (audit:edge-cases bug #32): только FOUNDER/ADMIN либо
    // менеджер-владелец сделки могут видеть PII студента (паспорт, телефоны,
    // e-mail, контракт, чеки). ACCOUNTANT раньше попадал в isElevated() и
    // получал доступ к любой чужой сделке — это была утечка PII; сейчас он
    // не имеет права на чтение submission'ов вообще (контроллер блокирует),
    // но дополнительно фильтруем здесь как defense-in-depth на случай если
    // кто-то вызовет getOne() из другого сервиса.
    if (!user) throw new ForbiddenException('Недостаточно прав');
    const elevated = isFounder(user) || hasRole(user, 'ADMIN');
    if (!elevated && s.managerId !== user.id) {
      throw new ForbiddenException('Это не ваша сделка');
    }

    // Блок «Партнёр» — ТОЛЬКО руководству (канонический гейт
    // canSeePartnerAttribution из auth/role-utils: FOUNDER/ADMIN/ACCOUNTANT,
    // а носителю активной кастомной роли — лишь по явному partners:read,
    // т.к. его base role это «подложка», см. RolesGuard.skipBaseRole).
    // Менеджер по продажам не должен видеть ни имя партнёра, ни сумму, ни
    // сам факт, что клиент партнёрский, поэтому поле физически ОТСУТСТВУЕТ
    // в его ответе — не null и не скрытие в UI: сетевой ответ читается в
    // devtools. Локальный `elevated` выше — это ДРУГАЯ, более узкая проверка
    // (FOUNDER/ADMIN, без ACCOUNTANT) для доступа к PII сделки; смешивать их
    // нельзя.
    if (!canSeePartnerAttribution(user)) return s;
    const partnerAttribution = this.referrals
      ? await this.referrals.getPartnerAttributionView({
          studentId: s.studentId,
          applicationId: s.applicationId,
          // Заявка-источник обязана участвовать в поиске наравне с двумя
          // остальными идентификаторами. У сделки, заведённой вкладкой
          // «Новый» до одобрения, studentId и applicationId ОБА null —
          // findAttribution получал пустой OR и возвращал null, поэтому блок
          // «Партнёр» не показывался даже основателю, хотя атрибуция на лиде
          // была.
          applicationIds: [s.sourceApplicationId],
        })
      : null;
    return { ...s, partnerAttribution };
  }

  /**
   * FOUNDER одобряет платёж. Если это первый APPROVED payment в
   * subscription — атомарно создаём Student (если новый) + Application.
   * Всегда создаём FinanceTransaction (доход) с привязкой к Submission.
   *
   * Параллелизм-защиты (по слоям):
   *   - Bug #24 (HIGH): весь mutation-блок в Prisma `$transaction(async tx)`
   *     — частичный сбой (P2002 на email, FK на programId, потеря коннекта)
   *     откатывает всё целиком; иначе ретрай ловит P2002 / удваивает доход.
   *   - Bug #26 (CRITICAL): pessimistic lock `SELECT ... FOR UPDATE` на
   *     SaleSubmission в самом начале транзакции — сериализует параллельные
   *     approve по РАЗНЫМ платежам одной сделки до COMMIT/ROLLBACK.
   *   - Bug #6 (CRITICAL): CAS на payment.status=PENDING — defense-in-depth
   *     против двойного approve одного и того же payment'а.
   *   - Bug #27 (HIGH): CAS на SaleSubmission.firstApprovedAt IS NULL —
   *     defense-in-depth: даже если FOR UPDATE не сработает (например,
   *     legacy pg-bouncer в transaction-mode без поддержки advisory locks),
   *     optimistic CAS гарантирует, что Student/Application создаст ровно
   *     один winner из параллельных approve'ов.
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
    // Защита от одобрения платежей по отменённым/закрытым сделкам.
    // Сценарий атаки: менеджер ставит CANCELLED после создания PENDING-платежа,
    // FOUNDER не глядя на статус сделки жмёт Approve в /pending-payments →
    // создаётся Transaction (доход) + Student/Application для несостоявшейся
    // продажи. По COMPLETED новые платежи добавить нельзя, но старые PENDING
    // могут висеть — их тоже блокируем.
    if (submission.status === SubmissionStatus.CANCELLED) {
      throw new BadRequestException('Сделка отменена, платежи нельзя одобрять');
    }
    if (submission.status === SubmissionStatus.COMPLETED) {
      throw new BadRequestException('Сделка завершена, новые платежи одобрять нельзя');
    }
    if (submission.status !== SubmissionStatus.ACTIVE) {
      throw new BadRequestException('Нельзя одобрить платёж по неактивной сделке');
    }
    // Конфликт интересов: FOUNDER, который является менеджером сделки,
    // не может сам себе одобрять платежи (иначе self-approve + бонус себе).
    if (submission.managerId && submission.managerId === reviewerId) {
      throw new ForbiddenException('Нельзя одобрять платежи по своей сделке');
    }
    // Program может быть null если её удалили из каталога (onDelete: SetNull).
    // Approve без программы невозможен: нужно направление для Student/Application.
    if (!submission.program || !submission.programId) {
      throw new BadRequestException(
        'Программа удалена из каталога — нельзя одобрить платёж. Восстановите программу или отмените сделку.',
      );
    }
    const program = submission.program;
    const programId = submission.programId;

    // Defensive guard (bug #7): inconsistent state — первый approve уже
    // произошёл (firstApprovedAt записан), но studentId не сохранён.
    // Возможно в редких race-conditions, если предыдущий approve упал
    // между application.create и saleSubmission.update. Дальше идти
    // нельзя: Transaction.studentId окажется null (TypeScript ! — это
    // ложь компилятору, в runtime передастся null) → FK-ошибка Prisma
    // или «бесхозная» транзакция в дашборде доходов. Требуется ручная
    // починка submission через FOUNDER.
    if (submission.firstApprovedAt && !submission.studentId) {
      throw new InternalServerErrorException(
        'Inconsistent submission: firstApprovedAt set but studentId is null. Submission ' +
          submission.id +
          ' нужна ручная починка.',
      );
    }

    const isFirstApproval = !submission.firstApprovedAt;

    // CRITICAL FIX #4 (Internal Server Error at approve): pre-check уникальности
    // email студента ДО входа в $transaction. Student.email имеет @unique в
    // schema.prisma; если снапшот newStudentEmail совпадает с уже существующим
    // студентом (тот был создан из другой сделки, из StudentsService.create,
    // из partner-auth, или из этой же сделки в прошлой попытке одобрения,
    // упавшей на середине), tx.student.create внутри $transaction кидает
    // PrismaClientKnownRequestError code=P2002 target=['email']. Без глобального
    // exception-фильтра NestJS превращает необработанное исключение в bare
    // HTTP 500 без тела/stack — ровно то, что видел пользователь.
    //
    // Ловим кейс заранее и отвечаем 400 с понятным сообщением, чтобы FOUNDER
    // мог принять решение: привязать сделку к существующему студенту через
    // studentId или очистить email в snapshot. Проверка вне транзакции ОК —
    // остаточную race (кто-то создал студента с этим email между этой проверкой
    // и tx.student.create) ловит try/catch на P2002 ниже.
    if (isFirstApproval && !submission.studentId && submission.newStudentEmail) {
      const dup = await this.prisma.student.findUnique({
        where: { email: submission.newStudentEmail },
        select: { id: true, fullName: true },
      });
      if (dup) {
        throw new BadRequestException(
          `Студент с email ${submission.newStudentEmail} уже существует (${dup.fullName}). ` +
            `Привяжите сделку к существующему студенту (studentId) или очистите email в snapshot сделки.`,
        );
      }
    }

    // Bug #31 (HIGH): plain-пароль нового студента, который вернём FOUNDER'у
    // вместе с email'ом — чтобы менеджер передал клиенту для входа в LMS/
    // payments. null означает «креды отдавать не надо» (студент уже
    // существовал заранее — учётка заведена в StudentsService.create — ИЛИ
    // это не первый approve, и Student создан в прошлый раз).
    let studentCredentials: { email: string | null; password: string } | null = null;

    // Google Sheet-parity поля для будущей Transaction (INCOME).
    //
    // productCategoryEnum: у submission-платежей это ВСЕГДА CONTRACT — сделка
    //   всегда представляет основной контракт по программе (обучение за
    //   рубежом); мастер-классы/академия оформляются другими сервисами и
    //   пишут свои значения productCategoryEnum напрямую.
    //
    // incomeSource: NEW_CLIENT если сделка создана из snapshot (нет
    //   pre-существующего Student, submission.studentId=null) — значит клиент
    //   впервые попал в систему через эту сделку. UP_SALE если submission.studentId
    //   был задан заранее И у этого студента уже есть другие SaleSubmission
    //   или Application (не считая привязанной к текущей сделке) — значит это
    //   апселл существующему клиенту. Если существующий Student ни разу
    //   раньше не покупал/подавал заявку — считаем NEW_CLIENT (фактически
    //   первое обращение через воронку продаж).
    //
    // paymentPhase: FULL если КУМУЛЯТИВНАЯ сумма APPROVED-платежей по сделке
    //   (включая текущий, только что переведённый в APPROVED через CAS в tx
    //   ниже) достигла totalAmount — контракт закрыт этим траншем; иначе
    //   PREPAID (сделка ещё не покрыта). Вычисление ПЕРЕНЕСЕНО ВНУТРЬ
    //   транзакции (см. `paymentPhase` рядом с tx.transaction.create ниже) —
    //   раньше сравнение шло по одному текущему платежу и любая рассрочка
    //   навсегда оставалась PREPAID, недосчитывая закрытые контракты в
    //   аналитике. Epsilon 0.01 закрывает возможные float-огрехи (schema —
    //   Float для amount/totalAmount).
    const productCategoryEnum: ProductCategory = ProductCategory.CONTRACT;

    let incomeSource: IncomeSource;
    if (!submission.studentId) {
      // Snapshot-student: клиент попал в систему через эту сделку впервые.
      incomeSource = IncomeSource.NEW_CLIENT;
    } else {
      // Existing student: проверяем историю. Считаем ДРУГИЕ SaleSubmission
      // (исключая текущую) и Application'ы, не привязанные к текущей сделке
      // (submission null или другой). Prisma NOT + relation-filter корректно
      // включает записи с null-relation.
      //
      // Audit (HIGH): не считаем CANCELLED submissions и submissions, где
      // ни один платёж не был одобрен (firstApprovedAt = null). Иначе
      // отменённая ранее сделка (реверс Transaction, дохода не было) флипнет
      // incomeSource в UP_SALE, хотя фактически это первая успешная покупка
      // клиента. Аналогично, «черновая» ACTIVE-сделка без одобренных платежей
      // не должна считаться историей продаж.
      //
      // priorApplications: исключаем заявки, чей SaleSubmission = CANCELLED
      // или ещё не одобрен. Заявки БЕЗ submission (leads из LANDING_FORM
      // и т.п.) сохраняем — они действительно означают прошлый контакт с
      // компанией и оправдывают UP_SALE-классификацию.
      const [otherSubmissions, priorApplications] = await Promise.all([
        this.prisma.saleSubmission.count({
          where: {
            studentId: submission.studentId,
            id: { not: submission.id },
            status: { not: SubmissionStatus.CANCELLED },
            firstApprovedAt: { not: null },
          },
        }),
        this.prisma.application.count({
          where: {
            studentId: submission.studentId,
            // Каждый NOT — независимая негация; массивная форма NOT в Prisma
            // семантически неоднозначна между версиями, поэтому оборачиваем в
            // явный AND-of-NOTs. Relation-filter (submission: { ... }) не
            // матчит записи с null-submission → NOT такого фильтра включает
            // Application без сделки (законные leads из LANDING_FORM).
            AND: [
              { NOT: { submission: { id: submission.id } } },
              { NOT: { submission: { status: SubmissionStatus.CANCELLED } } },
              { NOT: { submission: { firstApprovedAt: null } } },
            ],
          },
        }),
      ]);
      incomeSource =
        otherSubmissions > 0 || priorApplications > 0
          ? IncomeSource.UP_SALE
          : IncomeSource.NEW_CLIENT;
    }

    // Bug #24 (HIGH): все мутации одобрения — в одной транзакции, чтобы
    // при сбое в середине (P2003/P2002 на email Student, FK на programId,
    // и т.п.) не остаться с частично созданным Student без Application/
    // Submission-связи. Без обёртки повторный approve пытался бы создать
    // второго Student с тем же email и падал бы навсегда на @unique email.
    // bcrypt.hash и генерация пароля — pure compute, вынесены наружу.
    const plainPassword = isFirstApproval && !submission.studentId
      ? generateStudentPassword(8)
      : null;
    const passwordHash = plainPassword ? await bcrypt.hash(plainPassword, 10) : null;

    // Bug #6 (CRITICAL): атомарный CAS (compare-and-set) на статус платежа —
    // первая операция в транзакции, до любых create. updateMany с фильтром
    // status=PENDING вернёт count=1 только одной конкурентной транзакции;
    // остальные получат count=0 и упадут с BadRequestException ещё до
    // создания Student/Application/Transaction. Без CAS два параллельных
    // запроса (FOUNDER двойной клик / два сеанса) проходили проверку
    // payment.status===PENDING и создавали по 2 Student + 2 Application +
    // 2 Transaction (двойной доход в отчёте, осиротевшие записи).
    // financeTransactionId апдейтим отдельным шагом в конце.
    //
    // Bug #27 (HIGH, audit:edge-cases): второй CAS — на firstApprovedAt
    // сделки. Bug #6 защищает только от двойного approve ОДНОГО платежа;
    // если FOUNDER параллельно одобряет ДВА разных PENDING-платежа одной
    // сделки (или два FOUNDER'а одновременно), оба пройдут payment-CAS,
    // и оба прочитают isFirstApproval=true из снапшота → оба зайдут в
    // ветку создания Student/Application/PASSPORT/CONTRACT. Получим
    // дубль студентов с одинаковым snapshot, 2 заявки, 4 документа; один
    // «победит» в saleSubmission.update (last-write-wins по studentId/
    // applicationId), второй останется сиротой. Фикс: атомарно
    // «захватываем» право на первое одобрение через conditional updateMany
    // ... WHERE firstApprovedAt IS NULL — только тот, у кого count===1,
    // идёт в ветку создания.
    const reviewedAt = new Date();
    // CRITICAL FIX #4: маппим P2002 (unique constraint), проскочивший pre-check
    // выше в результате race (студент создан параллельно между findUnique и
    // student.create внутри tx), в 400 BadRequestException. Без этого клиент
    // получает bare HTTP 500 из-за отсутствия глобального Prisma exception filter.
    // Также маппим P2003 (FK) — если programId вдруг удалили между read и tx.
    // Остальные ошибки пробрасываем без изменений — NestJS сам покажет 500.
    let upd: Awaited<ReturnType<typeof this.prisma.submissionPayment.update>>;
    // Хостинг в outer scope — нужно после COMMIT'а написать audit-запись в
    // ActivityLog и эмитнуть `transaction:new` в staff-канал; сами
    // переменные создаются внутри $transaction (finTx.id — после
    // tx.transaction.create; studentId — после гонок за первое одобрение
    // и/или подхватывания снапшота проигравшим). Пишем в переменные под
    // самый конец callback'а, так что при роллбэке они останутся null и
    // пост-коммитная секция ниже НЕ триггернет ложное уведомление.
    let finTxIdForAudit: string | null = null;
    let studentIdForAudit: string | null = null;
    let finTxAmountForAudit: number | null = null;
    // Полный finTx для пост-коммитного emit'а `transaction:new` в staff.
    // Раньше approvePayment писал в БД финансовую строку категории
    // TUITION_PAYMENT, но НЕ уведомлял /finance подписчиков — соседняя
    // вкладка FOUNDER'а видела новый доход только на ручной refetch.
    // Пишем ПОСЛЕ tx.transaction.create внутри callback'а; читаем СНАРУЖИ
    // только если transaction COMMIT'ился (в противном случае переменная
    // останется null и emit пропустится — никаких «фантомных» строк в UI).
    let finTxForEmit: Awaited<ReturnType<typeof this.prisma.transaction.create>> | null = null;
    // Строка outbox'а партнёрской комиссии, созданная ВНУТРИ транзакции
    // одобрения. Заполняется только при успешном COMMIT'е — при роллбэке
    // остаётся null (как и сама строка в БД, её уносит тот же роллбэк).
    let commissionOutboxId: string | null = null;
    try {
      upd = await this.prisma.$transaction(async (tx) => {
      // Bug #26 (CRITICAL): pessimistic lock на SaleSubmission — первая
      // операция в транзакции. Сериализует параллельные approve'ы по
      // РАЗНЫМ платежам одной сделки: пока эта транзакция держит lock,
      // соседний approvePayment по другому payment'у той же сделки повиснет
      // на SELECT FOR UPDATE, и пройдёт только после нашего COMMIT/ROLLBACK
      // — на тот момент он уже увидит актуальный submission.firstApprovedAt
      // и пойдёт по ветке "не первый approve" (или CAS-claim ниже его
      // отсечёт). Без этого лока snapshot isolation Postgres'а позволял бы
      // обоим прочитать firstApprovedAt=null и обоим создать
      // Student/Application — дубли + P2002 на unique-email.
      // Раw SQL — Prisma не умеет SELECT ... FOR UPDATE через model API.
      // Имя таблицы в кавычках — Postgres case-sensitive identifier.
      await tx.$queryRaw`SELECT id FROM "SaleSubmission" WHERE id = ${submission.id} FOR UPDATE`;

      const claim = await tx.submissionPayment.updateMany({
        where: { id: paymentId, status: SubmissionPaymentStatus.PENDING },
        data: {
          status: SubmissionPaymentStatus.APPROVED,
          reviewedById: reviewerId,
          reviewedAt,
        },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Платёж уже разобран');
      }

      // Bug #27: захват «первого одобрения» по сделке. Ставим
      // firstApprovedAt только если он всё ещё null. count===1 ⇒ мы
      // выиграли гонку и обязаны создать Student/Application/Document'ы;
      // count===0 ⇒ параллельный approve по другому платежу той же сделки
      // уже всё создал (или сделка уже была одобрена ранее). Снапшотный
      // isFirstApproval оставляем только как hint для passwordHash (выше);
      // реальное решение — по результату этого захвата.
      const claimedFirst = await tx.saleSubmission.updateMany({
        where: { id: submission.id, firstApprovedAt: null },
        data: { firstApprovedAt: reviewedAt },
      });
      const wonFirstApproval = claimedFirst.count === 1;

      // На первый APPROVE создаём Student (если новый) + Application.
      let studentId = submission.studentId;
      let applicationId = submission.applicationId;

      if (wonFirstApproval) {
        if (!studentId) {
          // Bug #31 (HIGH): раньше Student создавался без password — поле
          // оставалось null, и студент никогда не мог залогиниться в LMS/
          // payments (JWT-стратегия требует bcrypt.compare с непустым хэшем).
          // Генерим plain (8 символов, безопасный алфавит без I/l/O/0/1),
          // сохраняем bcrypt-хэш (cost=10 — тот же, что в StudentsService.create),
          // plain отдаём FOUNDER'у в studentCredentials.

          // Создаём студента из snapshot.
          const newStudent = await tx.student.create({
            data: {
              fullName: submission.newStudentName || 'Без имени',
              phones: submission.newStudentPhone ? [submission.newStudentPhone] : [],
              email: submission.newStudentEmail || null,
              password: passwordHash,
              direction: program.direction,
              // Кабинет по направлению программы; FOUNDER может изменить вручную.
              cabinet: CABINET_BY_DIRECTION[program.direction] ?? DEFAULT_CABINET,
              managerId: submission.managerId,
              programId,
            },
          });
          studentId = newStudent.id;
          studentCredentials = { email: newStudent.email, password: plainPassword! };

          // Если были загружены паспорта — создаём по Document на каждый файл.
          // Метаданные (originalName/mimeType/size) берём из snapshot,
          // сохранённого на create() из ответа /submissions/upload. Если по
          // какой-то причине их нет (legacy/недозаполненные массивы) —
          // fallback на безопасные дефолты, чтобы не падать.
          const passportUrls = submission.newStudentPassportUrls || [];
          const passportOriginalNames = submission.newStudentPassportOriginalNames || [];
          const passportMimes = submission.newStudentPassportMimes || [];
          const passportSizes = submission.newStudentPassportSizes || [];
          for (let i = 0; i < passportUrls.length; i++) {
            const url = passportUrls[i];
            const fallbackFilename = url.split('/').pop() || 'passport';
            await tx.document.create({
              data: {
                studentId: newStudent.id,
                filename: fallbackFilename,
                originalName: passportOriginalNames[i] || fallbackFilename,
                mimeType: passportMimes[i] || 'application/octet-stream',
                size: passportSizes[i] ?? 0,
                url,
                type: 'PASSPORT',
              },
            });
          }
        }
      }

      // Bug #27: проиграли гонку (wonFirstApproval=false), а snapshot
      // studentId/applicationId ещё пустой — значит «победитель» гонки
      // их только что записал в БД. Перечитываем внутри той же транзакции,
      // чтобы FinanceTransaction.studentId ссылался на корректную запись,
      // а не упал на NOT NULL/FK.
      if (!wonFirstApproval && (!studentId || !applicationId)) {
        const fresh = await tx.saleSubmission.findUnique({
          where: { id: submission.id },
          select: { studentId: true, applicationId: true },
        });
        studentId = fresh?.studentId ?? studentId;
        applicationId = fresh?.applicationId ?? applicationId;
      }

      // Runtime invariant (bug #7): после блока isFirstApproval studentId
      // обязан быть задан (либо взят из submission.studentId, либо только что
      // создан). Любой `studentId!` ниже — ложь компилятору; делаем explicit
      // guard, чтобы поймать регрессии и не записать null в Transaction.studentId
      // (что приведёт к FK-ошибке Prisma или «бесхозной» транзакции в дашборде).
      if (!studentId) {
        throw new InternalServerErrorException(
          'studentId must be set after isFirstApproval branch (submission ' + submission.id + ')',
        );
      }

      if (wonFirstApproval) {
        // Application — всегда новая запись с status=SUCCESSFUL_LEAD
        // (бывший ENROLLED): оплата подтверждена, лид доведён до результата.
        const stu = await tx.student.findUnique({
          where: { id: studentId },
          select: { fullName: true, phones: true },
        });
        const phone = (stu?.phones && stu.phones[0]) || submission.newStudentPhone || '';
        const newApp = await tx.application.create({
          data: {
            studentId: studentId,
            fullName: stu?.fullName || 'Студент',
            phone,
            direction: program.direction,
            programId,
            status: 'SUCCESSFUL_LEAD',
            managerId: submission.managerId,
          },
        });
        applicationId = newApp.id;

        // Контракты — добавляем по Document на каждый файл. Метаданные берём
        // из snapshot, сохранённого при create() (см. комментарий про паспорт).
        const contractUrls = submission.contractUrls || [];
        const contractOriginalNames = submission.contractOriginalNames || [];
        const contractMimes = submission.contractMimes || [];
        const contractSizes = submission.contractSizes || [];
        for (let i = 0; i < contractUrls.length; i++) {
          const url = contractUrls[i];
          const contractFallbackFilename = url.split('/').pop() || 'contract';
          await tx.document.create({
            data: {
              studentId: studentId,
              filename: contractFallbackFilename,
              originalName: contractOriginalNames[i] || contractFallbackFilename,
              mimeType: contractMimes[i] || 'application/octet-stream',
              size: contractSizes[i] ?? 0,
              url,
              type: 'CONTRACT',
            },
          });
        }
      }

      // Bug (HIGH, audit): paymentPhase считаем ПО КУМУЛЯТИВНОЙ сумме
      // APPROVED-платежей сделки, а не по одному текущему транзу.
      //   - Aggregate идёт через `tx.` — читаем ТУ ЖЕ транзакцию, куда
      //     CAS выше уже перевёл текущий payment в APPROVED, поэтому его
      //     amount уже включён в _sum.
      //   - Pessimistic lock FOR UPDATE на SaleSubmission (в начале tx)
      //     сериализует параллельные approve по разным платежам одной
      //     сделки, поэтому «догоняющая» approve увидит консистентный сум.
      //   - Раньше `payment.amount === submission.totalAmount` возвращал
      //     FULL только на single-shot оплате всей суммы; любая рассрочка
      //     (3000 + 2000 при totalAmount=5000) навсегда оставалась PREPAID
      //     и аналитика недосчитывала закрытые контракты.
      //   - Epsilon 0.01 закрывает возможные float-огрехи: schema хранит
      //     amount/totalAmount как Float; если суммы уйдут в центы,
      //     3000.00 + 1999.999999 == 4999.999999 не должно давать PREPAID
      //     на закрытии контракта 5000.
      const approvedAgg = await tx.submissionPayment.aggregate({
        where: {
          submissionId: submission.id,
          status: SubmissionPaymentStatus.APPROVED,
        },
        _sum: { amount: true },
      });
      const approvedSoFar = approvedAgg._sum.amount ?? 0;
      const PAYMENT_PHASE_EPSILON = 0.01;
      const paymentPhase: PaymentPhaseStatus =
        approvedSoFar >= submission.totalAmount - PAYMENT_PHASE_EPSILON
          ? PaymentPhaseStatus.FULL
          : PaymentPhaseStatus.PREPAID;

      // Создаём финансовую транзакцию (доход).
      // date = payment.paidAt намеренно: это финансовый «факт прихода денег»,
      // используется в дашборде доходов и для отчётности. Для бонусной базы
      // зарплаты эта дата НЕ используется (см. bug #22): SalaryService.preview
      // агрегирует бонус по SubmissionPayment.reviewedAt — иначе при задержке
      // одобрения FOUNDER'ом бонус мог попасть в уже закрытый зарплатный период
      // и потеряться (preview не пересчитывает PAID-записи).
      //
      // Bug (CRITICAL, audit — currency-mixing follow-up): раньше писали
      // `currency: submission.currency`, а SaleSubmission.currency @default("USD")
      // (schema.prisma:1635). После fix'а currency-mixing в FinanceService все
      // агрегаты (summary/breakdown/distribution/topManagers/incomeSources/
      // incomeByProduct/byCategory/timeseries) фильтруются по
      // REPORTING_CURRENCY = 'TJS'. Итог: одобренные контрактные приходы (по
      // умолчанию USD) силентно ВЫПАДАЛИ из всех дашбордов бухгалтера —
      // netProfit, пироги источников/менеджеров/продуктов, revenue chart,
      // распределение 70/20/10 показывали ~0 несмотря на реальные продажи.
      // Пока нет FX-конвертации на write-time, единственный вариант, при
      // котором reporting stack видит платёж — писать
      // Transaction.currency = 'TJS', а исходную валюту сделки сохранять
      // текстом в comment для последующего аудита/ручной пересборки. Long-term
      // fix — подставить сюда rate × amount (FX на дату одобрения); тогда
      // строчка ниже станет `currency: 'TJS', amount: payment.amount * rate`.
      const REPORTING_CURRENCY = 'TJS';
      const originalCurrency = (submission.currency || REPORTING_CURRENCY).toUpperCase();
      const commentBase = `Платёж по сделке #${submission.id.slice(0, 8)} (${program.name})`;
      const finTxComment =
        originalCurrency === REPORTING_CURRENCY
          ? commentBase
          : `${commentBase} — исходная валюта сделки: ${originalCurrency} ${payment.amount} (FX не применён)`;
      const finTx = await tx.transaction.create({
        data: {
          type: 'INCOME',
          category: 'TUITION_PAYMENT',
          amount: payment.amount,
          currency: REPORTING_CURRENCY,
          date: payment.paidAt,
          comment: finTxComment,
          studentId: studentId,
          managerId: submission.managerId,
          recordedById: reviewerId,
          // Google Sheet-parity: подробнее см. блок вычислений выше.
          productCategoryEnum,
          incomeSource,
          paymentPhase,
        },
      });

      // Bug #27: studentId/applicationId на сделке прописываем ТОЛЬКО
      // в ветке «выиграли гонку». Иначе перетрём значения, выставленные
      // параллельным «победителем» — классический last-write-wins, сирота
      // в БД. firstApprovedAt уже выставлен в claim-шаге выше; повторно
      // его не трогаем (сместили бы момент первого одобрения).
      if (wonFirstApproval) {
        await tx.saleSubmission.update({
          where: { id: submission.id },
          data: { studentId, applicationId },
        });
      }
      // financeTransactionId апдейтим отдельным шагом в конце — status/
      // reviewedById/reviewedAt уже выставлены CAS-апдейтом в начале
      // транзакции (см. Bug #6 выше); финальный апдейт добивает только
      // FK на FinanceTransaction.
      const updated = await tx.submissionPayment.update({
        where: { id: paymentId },
        data: { financeTransactionId: finTx.id },
      });

      // OUTBOX партнёрской комиссии. Единственное, что в этой транзакции
      // делается ради партнёра, — и делается намеренно: строка обязана
      // коммититься АТОМАРНО с одобрением. Само начисление идёт после
      // COMMIT'а (см. блок «Партнёрская комиссия» ниже), и раньше смерть
      // процесса между COMMIT'ом и начислением теряла комиссию НАВСЕГДА:
      // платёж одобрен, доход в отчётах, commissionedAt пуст, а второго
      // одобрения по одноплатёжной сделке уже не будет. Теперь «намерение
      // начислить» переживает рестарт вместе с самим одобрением, а доставку
      // добивает CronService.drainCommissionOutbox.
      //
      // Требование «партнёрская часть не имеет права ронять одобрение»
      // соблюдено: это один INSERT в таблицу без внешних ключей и без
      // обращения к ReferralsService — уронить его может только та же
      // авария, которая уронит и сам платёж.
      //
      // upsert, а не create: единственный ключ строки — paymentId, и хотя
      // повторный approve того же платежа сегодня невозможен (CAS на
      // status выше), P2002 отсюда откатил бы уже сделанное одобрение —
      // ровно то, чего этот блок не должен уметь.
      const outboxRow = await tx.commissionOutbox.upsert({
        where: { paymentId },
        // Ветка update переписывает ВСЕ поля, а не только счётчики: если
        // платёж когда-нибудь снова окажется одобряемым, это новое одобрение
        // с новой Transaction — доставлять по нему старую замороженную базу
        // было бы хуже, чем не доставлять вовсе.
        update: {
          status: 'PENDING',
          attempts: 0,
          resultReason: null,
          lastError: null,
          processedAt: null,
          submissionId: submission.id,
          financeTransactionId: finTx.id,
          studentId,
          applicationId: submission.applicationId,
          sourceApplicationId: submission.sourceApplicationId,
          baseAmountCents: Math.round(payment.amount * 100),
          baseCurrency: originalCurrency,
          sourceLabel: `Сделка #${submission.id.slice(0, 8)} (${program.name})`,
          nextAttemptAt: new Date(Date.now() + COMMISSION_OUTBOX_INLINE_GRACE_MS),
        },
        create: {
          submissionId: submission.id,
          paymentId,
          financeTransactionId: finTx.id,
          studentId,
          applicationId: submission.applicationId,
          sourceApplicationId: submission.sourceApplicationId,
          baseAmountCents: Math.round(payment.amount * 100),
          baseCurrency: originalCurrency,
          sourceLabel: `Сделка #${submission.id.slice(0, 8)} (${program.name})`,
          // Фора быстрому пути: cron не полезет за эту строку, пока
          // approvePayment сам её отрабатывает.
          nextAttemptAt: new Date(Date.now() + COMMISSION_OUTBOX_INLINE_GRACE_MS),
        },
        select: { id: true },
      });

      // Захватываем id-шники для пост-коммитного audit-лога (см. блок
      // после try/catch). Если транзакция откатится — эти переменные так и
      // останутся null, ложного лога не будет.
      finTxIdForAudit = finTx.id;
      studentIdForAudit = studentId;
      finTxAmountForAudit = payment.amount;
      finTxForEmit = finTx;
      commissionOutboxId = outboxRow.id;
      return updated;
    });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // P2002 — unique constraint violation. В нашем случае — Student.email
        // (единственный @unique @unique в тех моделях, что тут создаём).
        // Если pre-check выше не поймал (race с параллельным созданием
        // студента) — превращаем в 400, чтобы клиент увидел причину, а не 500.
        if (err.code === 'P2002') {
          const target = Array.isArray(err.meta?.target)
            ? (err.meta!.target as string[]).join(', ')
            : String(err.meta?.target ?? 'уникальное поле');
          throw new BadRequestException(
            `Конфликт уникальности при создании студента (${target}). ` +
              `Вероятно, студент с этим email уже создан параллельно. ` +
              `Обновите страницу и привяжите сделку к существующему студенту.`,
          );
        }
        // P2003 — FK constraint (например, programId удалили между read и tx).
        if (err.code === 'P2003') {
          throw new BadRequestException(
            'Связанная запись (программа/менеджер) была удалена во время одобрения. Попробуйте ещё раз.',
          );
        }
      }
      // Остальные ошибки — включая BadRequestException из CAS «Платёж уже
      // разобран» и InternalServerErrorException из invariant-guard — пробрасываем как есть.
      throw err;
    }

    // Audit-trail для FOUNDER: только сейчас (после COMMIT'а) фиксируем, что
    // approvePayment создал строку INCOME в Transaction. Без этой записи
    // /activity показывал только submission:approved-notification, а сырую
    // строку Transaction — только в дашборде доходов, никак с ней не связывая.
    // catch(() => undefined) — best-effort: провал ActivityLog.create не
    // должен отменять уже закоммиченное одобрение платежа (транзакция БД
    // уже прошла, откатить её отсюда нельзя).
    const originalCurrencyForAudit = (submission.currency || 'TJS').toUpperCase();
    if (finTxIdForAudit && finTxAmountForAudit !== null) {
      this.activity
        .log({
          actorId: reviewerId,
          actorRole: 'FOUNDER',
          action: 'PAYMENT_APPROVED',
          studentId: studentIdForAudit,
          details:
            `Одобрен платёж #${paymentId.slice(0, 8)}: +${finTxAmountForAudit} ` +
            `${originalCurrencyForAudit} (${program.name})`,
          payload: {
            transactionId: finTxIdForAudit,
            submissionId: submission.id,
            paymentId,
            managerId: submission.managerId,
            amount: finTxAmountForAudit,
            currency: originalCurrencyForAudit,
          },
        })
        .catch(() => undefined);
      // Realtime-эмит `transaction:new` идёт ниже (см. блок с finTxForEmit).
      // Держим их в одной точке, чтобы Finance UI не получил два одинаковых
      // события подряд и не сделал двойной refetch.
    }

    // managerId может быть null, если менеджер удалён — тогда персонального
    // уведомления некому слать, только staff-каналу.
    if (submission.managerId) {
      this.realtime.emitUser(submission.managerId, 'submission:approved', { paymentId, submissionId: submission.id });
    }
    this.realtime.emitStaff('submission:reviewed', { paymentId, status: 'APPROVED' });
    // Дополнительно вбрасываем `transaction:new` в finance-staff-канал:
    // TUITION_PAYMENT строка ТОЛЬКО ЧТО появилась в Transaction-таблице
    // (INCOME по студенту), и Finance UI у другого пользователя должен
    // показать её сразу — без polling и hard-refresh. `submission:*`
    // события намеренно оставляем как есть: они адресованы страницам
    // сделок, а Finance UI на них не подписан (см. отдельный fix в
    // FinanceService.create/update/remove).
    // finTxForEmit=null означает, что transaction откатился (см. try/catch
    // выше) — тогда emit не идёт, чтобы UI не показал фантомную строку.
    //
    // SEC (HIGH): emitFinanceStaff вместо emitStaff — payload содержит
    // полный transaction (amount, studentId, managerId, comment).
    // SALES_MANAGER/CLIENT_MANAGER не имеют доступа к GET /finance/*, поэтому
    // и WS-эмит с ledger-содержимым им отправлять нельзя — иначе через
    // `socket.on('transaction:new', ...)` менеджер бы стримил все
    // подтверждённые оплаты по чужим студентам (см. finance.service.ts
    // такой же fix для прямых POST/PATCH/DELETE финансовых операций).
    if (finTxForEmit) {
      this.realtime.emitFinanceStaff('transaction:new', { transaction: finTxForEmit });
    }

    // ── Партнёрская комиссия ──────────────────────────────────────────────
    //
    // ПОЧЕМУ ПОСЛЕ КОММИТА, А НЕ ВНУТРИ ТРАНЗАКЦИИ ОДОБРЕНИЯ.
    // Два требования тянут в разные стороны:
    //   1) одобрение платежа НЕ должно падать из-за партнёрской части —
    //      сломанное начисление не имеет права блокировать бухгалтера;
    //   2) молча проглоченная ошибка стоит партнёру денег.
    // Внутри транзакции требование (1) нарушается: любой сбой начисления
    // откатил бы уже сделанное одобрение, финансовую проводку и созданного
    // студента. Поэтому начисление идёт ОТДЕЛЬНОЙ транзакцией после COMMIT'а
    // основной, а провал — громкий logger.error (никаких пустых catch).
    // Атомарность при этом не теряется: штамп commissionedAt и создание
    // Commission лежат внутри ОДНОЙ транзакции в
    // ReferralsService.creditCommissionForAttributionOnce.
    //
    // ЧТО ЗАКРЫВАЕТ РАЗРЫВ МЕЖДУ ДВУМЯ ТРАНЗАКЦИЯМИ. Сам по себе «отдельной
    // транзакцией после COMMIT'а» означал: процесс умер между ними (деплой,
    // рестарт контейнера, eviction пода, обрыв соединения с БД) — платёж
    // одобрен, доход в отчётах, партнёр не получил ничего и уже не получит,
    // потому что второго одобрения по одноплатёжной сделке не будет.
    // Поэтому в транзакции выше пишется строка CommissionOutbox: намерение
    // начислить коммитится атомарно с одобрением. Код ниже — быстрый путь,
    // он же закрывает строку (settle) или откладывает её (defer); всё, что
    // он не закрыл, добирает CronService.drainCommissionOutbox. Повтор
    // безопасен — creditCommissionForAttributionOnce идемпотентен.
    //
    // await, а не fire-and-forget: ответ бухгалтеру задерживается на одну
    // короткую транзакцию, зато ошибка гарантированно попадает в лог и не
    // теряется при рестарте контейнера как unhandled rejection.
    //
    // Условие finTxIdForAudit && studentIdForAudit — тот же приём, что в
    // audit-блоке выше: при роллбэке обе переменные остаются null, и
    // начисление не запускается по несостоявшемуся одобрению.
    //
    // Начисляем ОДИН раз за клиента (решение основателя «один раз за
    // клиента»): рассрочка из 4 платежей платит партнёру только на первом
    // одобренном. Дедуп — по ReferralAttribution.commissionedAt.
    if (finTxIdForAudit && studentIdForAudit) {
      if (!this.referrals) {
        this.logger.error(
          `Партнёрская комиссия не начислена немедленно: ReferralsService не подключён ` +
            `(submission=${submission.id}, payment=${paymentId}). Проверьте PartnersModule в submissions.module.ts. ` +
            `Строка outbox'а осталась PENDING — начисление доедет через cron, когда модуль подключат.`,
        );
      } else {
        try {
          const result = await this.referrals.creditCommissionForAttributionOnce({
            studentId: studentIdForAudit,
            // SaleSubmission.applicationId — новая заявка SUCCESSFUL_LEAD,
            // созданная этим же одобрением, а НЕ лид с лендинга, на котором
            // висит атрибуция. Передаём его как есть, а по лендинговой
            // заявке ReferralsService доберёт сам (ищет по всем заявкам
            // студента) — второго поиска здесь намеренно нет.
            applicationId: submission.applicationId,
            // …кроме одного случая, который добором «по всем заявкам студента»
            // не закрывается: сделка заведена вкладкой «Новый» в обход
            // конвертации лида. Тогда Student создан ЭТИМ ЖЕ одобрением, и
            // единственная его заявка — свежая SUCCESSFUL_LEAD; лендинговый
            // лид, на котором висит атрибуция, к нему не привязан ничем, и
            // начисление молча уходило в no-attribution. sourceApplicationId
            // берём из снапшота сделки — он проставлен при СОЗДАНИИ и потому
            // не устаревает, в отличие от applicationId выше.
            applicationIds: [submission.sourceApplicationId],
            baseAmountCents: Math.round((finTxAmountForAudit ?? 0) * 100),
            baseCurrency: originalCurrencyForAudit,
            transactionId: finTxIdForAudit,
            sourceLabel: `Сделка #${submission.id.slice(0, 8)} (${program.name})`,
          });
          if (result.credited) {
            this.logger.log(
              `Партнёрская комиссия начислена: partner=${result.partnerId}, ` +
                `commission=${result.commissionId}, ${result.amountCents} копеек TJS ` +
                `(submission=${submission.id})`,
            );
          } else if (isNonPaymentReason(result.reason)) {
            // ОТКАЗ В ДЕНЬГАХ живому партнёру: клиент оплатил, партнёр
            // существует и реально его привёл, а комиссии не будет.
            // Раньше эта ветка молчала вместе со штатными исходами — партнёр
            // приходил с вопросом «почему мне не заплатили», и ни лога, ни
            // строки аудита, ни флага на сделке не существовало. Начисление
            // при этом НЕ откладывается и НЕ восстанавливается само.
            await recordCommissionNonPayment(
              { logger: this.logger, activity: this.activity },
              {
                reason: result.reason,
                partnerId: result.partnerId,
                partnerName: result.partnerName,
                studentId: studentIdForAudit,
                actorId: reviewerId,
                actorRole: 'FOUNDER',
                context: `Сделка #${submission.id.slice(0, 8)}, платёж #${paymentId.slice(0, 8)} (${program.name})`,
                payload: {
                  submissionId: submission.id,
                  paymentId,
                  transactionId: finTxIdForAudit,
                  managerId: submission.managerId,
                },
              },
            );
          }
          // Остальные исходы (no-attribution / already-credited / race-lost /
          // zero-rate) — штатные и молчаливые: большинство клиентов приходят
          // сами, повтор по уже оплаченному клиенту — ожидаемое поведение
          // guard'а, а zero-rate штамп не ставит и клиента для партнёра не
          // сжигает (следующий платёж начислит по восстановленной ставке).

          // Быстрый путь отработал — закрываем строку outbox'а с фактическим
          // исходом. ЛЮБОЙ исход (включая no-attribution) — терминальный:
          // повторять нечего, решение принято по тем же данным, что увидел бы
          // cron. Если процесс умрёт ровно здесь, строка останется PENDING и
          // cron повторит доставку, получив already-credited, — двойного
          // начисления это не даёт (CAS-штамп commissionedAt).
          if (commissionOutboxId && this.commissionOutbox) {
            await this.commissionOutbox.settle(commissionOutboxId, result);
          }
        } catch (err) {
          // Громко, но не бросаем: платёж уже одобрен и закоммичен, откатить
          // его отсюда нельзя, а падение ответа заставило бы бухгалтера жать
          // «Одобрить» ещё раз по уже одобренному платежу.
          this.logger.error(
            `Не удалось начислить партнёрскую комиссию по сделке ${submission.id} ` +
              `(payment=${paymentId}, student=${studentIdForAudit}): ${(err as Error).message}`,
            (err as Error).stack,
          );
          // …и — главное — не теряем начисление. Строка outbox'а остаётся
          // PENDING с отодвинутым nextAttemptAt: cron повторит доставку, и
          // сбой, который раньше стоил партнёру денег, теперь стоит задержки.
          if (commissionOutboxId && this.commissionOutbox) {
            const deferred = await this.commissionOutbox.defer(commissionOutboxId, err);
            if (deferred.exhausted) {
              this.logger.error(
                `Партнёрская комиссия по сделке ${submission.id} исчерпала лимит попыток ` +
                  `доставки (${deferred.attempts}) — строка outbox'а переведена в FAILED, ` +
                  `нужна ручная проверка.`,
              );
            }
          }
        }
      }
    }

    // Bug #31 (HIGH): на первый APPROVE возвращаем plain-пароль нового
    // студента, чтобы FOUNDER (UI /pending-payments) показал его менеджеру,
    // а тот передал клиенту. На последующие approve'ы (studentCredentials =
    // null) поле просто отсутствует в payload — UI не показывает блок.
    if (studentCredentials) {
      return { ...upd, studentCredentials };
    }
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

    const payment = await this.prisma.submissionPayment.findUnique({
      where: { id: paymentId },
      include: { submission: { select: { status: true, managerId: true } } },
    });
    if (!payment) throw new NotFoundException('Платёж не найден');
    if (payment.status !== SubmissionPaymentStatus.PENDING) {
      throw new BadRequestException('Платёж уже разобран');
    }
    if (payment.submission.status !== SubmissionStatus.ACTIVE) {
      throw new BadRequestException('Нельзя отклонить платёж по неактивной сделке');
    }
    // Конфликт интересов: FOUNDER-менеджер своей же сделки не должен
    // самостоятельно разбирать (одобрять/отклонять) свои платежи.
    if (payment.submission.managerId && payment.submission.managerId === reviewerId) {
      throw new ForbiddenException('Нельзя разбирать платежи по своей сделке');
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
    if (submission && submission.managerId) {
      this.realtime.emitUser(submission.managerId, 'submission:rejected', { paymentId, reason: r });
    }
    this.realtime.emitStaff('submission:reviewed', { paymentId, status: 'REJECTED' });
    return upd;
  }

  /** Менеджер помечает сделку как COMPLETED/CANCELLED.
   *
   * При переходе в CANCELLED для каждого APPROVED-платежа атомарно:
   *   1) помечаем оригинальную INCOME-транзакцию reversedAt=now()
   *      (salary/kpi-агрегации её исключат, но запись остаётся для аудита);
   *   2) создаём обратную EXPENSE-транзакцию (OTHER_EXPENSE) с тем же
   *      managerId/studentId/amount/currency — finance dashboard
   *      (доход − расход) показывает корректный нетто;
   *   3) меняем сам платёж на REJECTED + проставляем rejectReason
   *      (защита от повторного approvePayment и от UI, который рисует
   *      «одобрено» по отменённой сделке);
   *   4) откатываем партнёрскую комиссию, начисленную с этих же транзакций
   *      (Commission→REVERSED, минус с balanceCents/totalEarnedCents,
   *      расштамповка ReferralAttribution) — см.
   *      ReferralsService.reverseCommissionsForTransactionsTx.
   * Bug #25 из audit:edge-cases: раньше CANCEL не откатывал ничего, и
   * деньги по отменённой сделке оставались в выручке и бонусной базе.
   * Пункт (4) — тот же баг на партнёрской стороне: компания возвращала
   * клиенту деньги, а комиссия за возвращённую продажу оставалась у партнёра
   * и была выводима.
   */
  async changeStatus(user: { id: string; role?: any; roles?: any }, submissionId: string, status: SubmissionStatus) {
    const submission = await this.prisma.saleSubmission.findUnique({
      where: { id: submissionId },
      include: {
        payments: {
          where: { status: SubmissionPaymentStatus.APPROVED },
          select: {
            id: true,
            amount: true,
            financeTransactionId: true,
            paidAt: true,
          },
        },
      },
    });
    if (!submission) throw new NotFoundException('Сделка не найдена');
    // FOUNDER может закрывать любые сделки (включая orphan-сделки
    // уволенных менеджеров где managerId стал null). Остальным —
    // только свои собственные.
    const isFounderUser = isFounder(user as UserWithRoles);
    if (!isFounderUser) {
      if (submission.managerId === null || submission.managerId !== user.id) {
        throw new ForbiddenException('Это не ваша сделка');
      }
    }
    if (status !== SubmissionStatus.COMPLETED && status !== SubmissionStatus.CANCELLED) {
      throw new BadRequestException('Можно ставить только COMPLETED или CANCELLED');
    }
    if (submission.status === status) {
      // Идемпотентность: повторный CANCEL не плодит refund-транзакции.
      return submission;
    }

    // COMPLETED — простой апдейт статуса, ничего реверсить не нужно.
    if (status === SubmissionStatus.COMPLETED) {
      return this.prisma.saleSubmission.update({
        where: { id: submissionId },
        data: { status },
      });
    }

    // CANCELLED — откатываем все APPROVED-платежи атомарно.
    const approvedPayments = submission.payments;
    const reversedAt = new Date();
    const shortId = submission.id.slice(0, 8);

    // Собираем метаданные каждого рефанда прямо внутри $transaction, чтобы
    // после COMMIT'а прогнать по ним ActivityService.log и `transaction:reversed`
    // эмиты. Раньше эти EXPENSE-строки появлялись в БД без единой записи
    // в ActivityLog — FOUNDER не мог связать «почему возник EXPENSE
    // OTHER_EXPENSE с recordedById=X на дату Y» с конкретной отменой сделки.
    const refundAuditPayloads: Array<{
      paymentId: string;
      originalTxId: string;
      refundTxId: string;
      amount: number;
      currency: string;
      studentId: string | null;
      managerId: string | null;
    }> = [];

    // Реверсы партнёрских комиссий — тоже собираем внутри $transaction, но
    // ОТДЕЛЬНО от refundAuditPayloads: эти строки содержат partnerId и суммы
    // начислений, поэтому уходят только в серверный лог и в finance-staff
    // канал. В ActivityLog они не пишутся: GET /activity открыт любому
    // сотруднику под JwtAuthGuard, а факт «клиент партнёрский» и тем более
    // сумма комиссии менеджеру по продажам не видны нигде (см.
    // canSeePartnerAttribution). В HTTP-ответ changeStatus они тоже не идут.
    const commissionReversals: CommissionReversal[] = [];

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const p of approvedPayments) {
        // (1) оригинальный INCOME → reversedAt (исключение из бонусной базы).
        //     Линка может быть пустой у legacy-платежей (до того, как
        //     approvePayment начал писать financeTransactionId) — тогда
        //     ничего не реверсим, и за такие нужно делать ручной refund
        //     через Finance. По текущему коду все новые APPROVED имеют tx.
        if (p.financeTransactionId) {
          const original = await tx.transaction.findUnique({
            where: { id: p.financeTransactionId },
            select: {
              amount: true,
              currency: true,
              studentId: true,
              managerId: true,
              reversedAt: true,
            },
          });
          if (original && !original.reversedAt) {
            await tx.transaction.update({
              where: { id: p.financeTransactionId },
              data: { reversedAt },
            });
            // (2) обратная EXPENSE для finance dashboard.
            const refundTx = await tx.transaction.create({
              data: {
                type: 'EXPENSE',
                category: 'OTHER_EXPENSE',
                amount: original.amount,
                currency: original.currency,
                // Дата возврата = сегодня, чтобы возврат попал в текущий
                // финансовый период, а не задним числом в уже закрытый
                // месяц (иначе ретро-сдвиг netProfit предыдущих отчётов).
                date: reversedAt,
                studentId: original.studentId,
                managerId: original.managerId,
                recordedById: user.id,
                comment: `Возврат по сделке #${shortId} (отмена менеджером)`,
                // Reversal-EXPENSE — корректирующая запись; маркируем
                // reversedAt, чтобы при возможном UN-CANCEL её не «отменить
                // повторно» и чтобы отчёты могли её отличить как pair-entry.
                reversedAt,
              },
            });
            // Захватываем данные для пост-коммитного audit-лога — сам лог
            // и realtime-эмит идут ПОСЛЕ выхода из $transaction, чтобы при
            // роллбэке не оставить фантомную запись в ActivityLog о рефанде,
            // которого фактически не было.
            refundAuditPayloads.push({
              paymentId: p.id,
              originalTxId: p.financeTransactionId,
              refundTxId: refundTx.id,
              amount: original.amount,
              currency: original.currency,
              studentId: original.studentId,
              managerId: original.managerId,
            });
          }
        }
        // (3) платёж → REJECTED, чтобы UI не показывал «одобрено» по
        //     отменённой сделке и approvePayment не сработал повторно.
        await tx.submissionPayment.update({
          where: { id: p.id },
          data: {
            status: SubmissionPaymentStatus.REJECTED,
            rejectReason: `Сделка отменена менеджером (${reversedAt.toISOString().slice(0, 10)})`,
          },
        });
      }

      // (4) партнёрская комиссия по этим же транзакциям — в ТОЙ ЖЕ
      //     транзакции, что и реверс дохода. Не best-effort и не после
      //     COMMIT'а (в отличие от НАЧИСЛЕНИЯ в approvePayment): если реверс
      //     комиссии упадёт, отмена сделки обязана откатиться целиком —
      //     «сделка отменена, а комиссия по ней живая и выводимая» это ровно
      //     тот рассинхрон, ради которого пункт (4) и появился.
      //
      //     Список transactionId собираем по ВСЕМ APPROVED-платежам, а не
      //     только по тем, чей INCOME мы реверснули выше: комиссия может
      //     висеть на транзакции, которую уже пометили reversedAt другим
      //     путём. Сам реверс идемпотентен (CAS по Commission.reversedAt),
      //     поэтому лишние id безопасны.
      if (this.referrals) {
        const reversals = await this.referrals.reverseCommissionsForTransactionsTx(
          tx,
          approvedPayments.map((p) => p.financeTransactionId),
          {
            reversedAt,
            reason: `Реверс: сделка #${shortId} отменена ${reversedAt.toISOString().slice(0, 10)}`,
          },
        );
        commissionReversals.push(...reversals);
      }

      return tx.saleSubmission.update({
        where: { id: submissionId },
        data: { status },
      });
    });

    // ReferralsService не подключён — комиссия НЕ откачена. Отмену уже
    // закоммитили (ронять её нечестно: финансовая часть отработала верно),
    // но молчать нельзя: у партнёра остались деньги за возвращённую продажу.
    if (!this.referrals && approvedPayments.length > 0) {
      this.logger.error(
        `Партнёрская комиссия НЕ откачена при отмене сделки ${submissionId}: ` +
          `ReferralsService не подключён. Проверьте PartnersModule в submissions.module.ts ` +
          `и откатите начисления вручную.`,
      );
    }

    // Audit-trail и realtime-эмит по каждому реверсированному платежу —
    // только после COMMIT'а. catch(() => undefined) на .log() — best-effort:
    // сбой в ActivityService не должен отменять уже закоммиченный CANCEL.
    // Один `activity:new` на рефанд + один `transaction:reversed` на пару
    // (original INCOME + refund EXPENSE) — Finance-страница слушает и
    // рефетчит листинг/агрегаты сразу же.
    const actorRoleForAudit = isFounderUser ? 'FOUNDER' : 'MANAGER';
    for (const r of refundAuditPayloads) {
      this.activity
        .log({
          actorId: user.id,
          actorRole: actorRoleForAudit,
          action: 'PAYMENT_REFUND',
          studentId: r.studentId,
          details:
            `Возврат по сделке #${shortId}: -${r.amount} ${r.currency} ` +
            `(платёж #${r.paymentId.slice(0, 8)})`,
          payload: {
            submissionId,
            paymentId: r.paymentId,
            originalTransactionId: r.originalTxId,
            refundTransactionId: r.refundTxId,
            amount: r.amount,
            currency: r.currency,
            managerId: r.managerId,
          },
        })
        .catch(() => undefined);
      // SEC (HIGH): emitFinanceStaff вместо emitStaff. Payload сам по себе
      // содержит только IDs (без сумм/комментариев), но событие подписывает
      // Finance UI (см. frontend-crm/src/pages/Finance.tsx) и триггерит
      // invalidate финансовых query-keys — SALES_MANAGER/CLIENT_MANAGER
      // не должны даже знать о факте рефанда чужой сделки, поэтому канал
      // тоже сужен до FINANCE_ROLES (см. realtime.gateway.ts).
      this.realtime.emitFinanceStaff('transaction:reversed', {
        originalTransactionId: r.originalTxId,
        refundTransactionId: r.refundTxId,
        submissionId,
        paymentId: r.paymentId,
      });
    }

    this.logCommissionReversals(
      commissionReversals,
      `отмена сделки ${submissionId}`,
    );

    // Уведомляем FOUNDER-канал: бухгалтерия должна видеть рефанд сразу.
    // Про откаченные комиссии здесь НЕТ НИЧЕГО — даже счётчика: событие идёт
    // в общий staff-канал, а «у этого клиента была партнёрская комиссия» —
    // это уже партнёрские данные, закрытые для менеджеров (см.
    // canSeePartnerAttribution). Детали уходят отдельным эмитом
    // `commission:reversed` в finance-staff — см. logCommissionReversals.
    this.realtime.emitStaff('submission:cancelled', {
      submissionId,
      reversedPayments: approvedPayments.length,
    });

    return updated;
  }

  /**
   * Пост-коммитный след по откаченным комиссиям: серверный лог + эмит в
   * finance-staff (FOUNDER/ADMIN/ACCOUNTANT — те же роли, что видят
   * «Партнёров»).
   *
   * ПОЧЕМУ НЕ ActivityLog. GET /activity висит под одним JwtAuthGuard, то есть
   * читается любым сотрудником, включая менеджеров по продажам. Партнёрские
   * данные (кто привёл клиента, сколько ему начислено) им закрыты на всех
   * остальных поверхностях — строка аудита стала бы обходным каналом. Аудит-
   * запись реверса — это сама строка Commission: status=REVERSED, reversedAt
   * и причина, дописанная в note; она видна в «Партнёры → Комиссии», где
   * роли уже проверены.
   */
  private logCommissionReversals(reversals: CommissionReversal[], context: string) {
    for (const r of reversals) {
      // warn, а не log: отрицательный баланс — это долг партнёра компании,
      // его должен увидеть человек. Сообщение намеренно содержит всё, что
      // нужно для ручного разбора, без похода в БД.
      const debt = r.balanceAfterCents < 0;
      const line =
        `Партнёрская комиссия откачена (${context}): partner=${r.partnerId}, ` +
        `commission=${r.commissionId}, был статус ${r.previousStatus}, ` +
        `-${r.amountCents} копеек ${r.currency}, баланс после: ${r.balanceAfterCents}` +
        (debt
          ? ' — ОТРИЦАТЕЛЬНЫЙ: партнёр уже вывел эти деньги, долг гасится ' +
            'следующими начислениями, выплаты заблокированы до нуля'
          : '');
      if (debt) this.logger.warn(line);
      else this.logger.log(line);

      this.realtime.emitFinanceStaff('commission:reversed', {
        commissionId: r.commissionId,
        partnerId: r.partnerId,
        amountCents: r.amountCents,
        currency: r.currency,
        balanceAfterCents: r.balanceAfterCents,
      });
    }
  }

  /**
   * Hard delete сделки — только для FOUNDER. Удаляет SaleSubmission +
   * каскадом её SubmissionPayment (onDelete: Cascade в schema).
   * APPROVED Transaction'ы и Application НЕ удаляются — связи SetNull,
   * они остаются в финансовой истории как есть.
   * Нужен для удаления тестовых/ошибочных сделок.
   */
  async remove(submissionId: string) {
    const submission = await this.prisma.saleSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true },
    });
    if (!submission) throw new NotFoundException('Сделка не найдена');
    await this.prisma.saleSubmission.delete({ where: { id: submissionId } });
    this.realtime.emitStaff('submission:deleted', { submissionId });
    return { ok: true };
  }

  /**
   * FOUNDER редактирует сделку. Всегда можно менять контракт-файлы,
   * totalAmount, currency, notes. Поля, привязанные к уже созданному
   * Student/Application (studentId, newStudent*, programId), становятся
   * "замороженными" после firstApprovedAt — если фронт всё же прислал
   * их, silently ignore (не бросаем 400, чтобы не ломать UI).
   * Обёртка в $transaction не нужна: одиночный update.
   */
  async updateSubmission(
    user: (UserWithRoles & { id: string }) | null | undefined,
    submissionId: string,
    dto: {
      contractUrls?: string[];
      contractMimes?: string[];
      contractSizes?: number[];
      contractOriginalNames?: string[];
      totalAmount?: number;
      currency?: string;
      notes?: string | null;
      studentId?: string | null;
      newStudentName?: string | null;
      newStudentPhone?: string | null;
      newStudentEmail?: string | null;
      newStudentPassportUrls?: string[];
      newStudentPassportMimes?: string[];
      newStudentPassportSizes?: number[];
      newStudentPassportOriginalNames?: string[];
      programId?: string;
      // Обновить email существующего студента (когда studentId уже связан).
      // Только для не-frozen сделки. Проверка уникальности email в БД.
      existingStudentEmail?: string | null;
    },
  ) {
    if (!user) throw new ForbiddenException('Не авторизован');
    const submission = await this.prisma.saleSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, firstApprovedAt: true, managerId: true, studentId: true },
    });
    if (!submission) throw new NotFoundException('Сделка не найдена');

    // Ownership: FOUNDER может любую, менеджер — только свою.
    const founderUser = isFounder(user);
    if (!founderUser && submission.managerId !== user.id) {
      throw new ForbiddenException('Это не ваша сделка');
    }

    // Money и program-link для не-FOUNDER — silent-ignore, не 403.
    // SALES_MANAGER (владелец сделки) не должен уметь менять totalAmount /
    // currency (защита от накрутки бонусной базы через Transaction.amount)
    // и programId (защита от подмены на программу с более выгодным %
    // бонуса). Раньше кидали ForbiddenException — но фронтовая
    // EditSubmissionModal безусловно шлёт programId для незамороженной
    // сделки, поэтому даже «notes-only» правка от менеджера ловила 403.
    // Ownership и так проверена выше; просто вычищаем эти поля из dto,
    // чтобы блоки присвоения в data ниже их не подхватили.
    if (!founderUser) {
      delete dto.totalAmount;
      delete dto.currency;
      delete dto.programId;
    }

    const data: any = {};

    // Всегда редактируемые поля.
    if (dto.contractUrls !== undefined) {
      if (!Array.isArray(dto.contractUrls) || dto.contractUrls.length === 0) {
        throw new BadRequestException('Загрузите минимум 1 файл контракта');
      }
      data.contractUrls = dto.contractUrls;
    }
    if (dto.contractMimes !== undefined) {
      data.contractMimes = Array.isArray(dto.contractMimes)
        ? dto.contractMimes.map((m) => (typeof m === 'string' ? m.trim() : ''))
        : [];
    }
    if (dto.contractSizes !== undefined) {
      data.contractSizes = Array.isArray(dto.contractSizes)
        ? dto.contractSizes.map((n) =>
            Number.isFinite(n as number) ? Math.max(0, Math.trunc(n as number)) : 0,
          )
        : [];
    }
    if (dto.contractOriginalNames !== undefined) {
      data.contractOriginalNames = Array.isArray(dto.contractOriginalNames)
        ? dto.contractOriginalNames.map((s) => (typeof s === 'string' ? s.trim() : ''))
        : [];
    }
    if (dto.totalAmount !== undefined) {
      if (
        typeof dto.totalAmount !== 'number' ||
        !isFinite(dto.totalAmount) ||
        dto.totalAmount <= 0
      ) {
        throw new BadRequestException('Сумма контракта должна быть > 0');
      }
      data.totalAmount = dto.totalAmount;
    }
    if (dto.currency !== undefined) {
      data.currency = dto.currency || 'USD';
    }
    if (dto.notes !== undefined) {
      data.notes = dto.notes ? String(dto.notes).trim() || null : null;
    }

    // Поля, замораживаемые после первого одобрения: если Student/Application
    // уже созданы, менять studentId/snapshot/programId нельзя — иначе
    // разъедутся FK на Transaction/Application. Silently ignore, чтобы
    // фронт мог слать один и тот же payload для draft и после-approve.
    const frozen = !!submission.firstApprovedAt;
    if (!frozen) {
      if (dto.studentId !== undefined) data.studentId = dto.studentId || null;
      if (dto.newStudentName !== undefined) {
        data.newStudentName = dto.newStudentName
          ? String(dto.newStudentName).trim() || null
          : null;
      }
      if (dto.newStudentPhone !== undefined) {
        data.newStudentPhone = dto.newStudentPhone
          ? String(dto.newStudentPhone).trim() || null
          : null;
      }
      if (dto.newStudentEmail !== undefined) {
        data.newStudentEmail = dto.newStudentEmail
          ? String(dto.newStudentEmail).trim().toLowerCase() || null
          : null;
      }
      if (dto.newStudentPassportUrls !== undefined) {
        data.newStudentPassportUrls = Array.isArray(dto.newStudentPassportUrls)
          ? dto.newStudentPassportUrls
          : [];
      }
      if (dto.newStudentPassportMimes !== undefined) {
        data.newStudentPassportMimes = Array.isArray(dto.newStudentPassportMimes)
          ? dto.newStudentPassportMimes.map((m) => (typeof m === 'string' ? m.trim() : ''))
          : [];
      }
      if (dto.newStudentPassportSizes !== undefined) {
        data.newStudentPassportSizes = Array.isArray(dto.newStudentPassportSizes)
          ? dto.newStudentPassportSizes.map((n) =>
              Number.isFinite(n as number) ? Math.max(0, Math.trunc(n as number)) : 0,
            )
          : [];
      }
      if (dto.newStudentPassportOriginalNames !== undefined) {
        data.newStudentPassportOriginalNames = Array.isArray(dto.newStudentPassportOriginalNames)
          ? dto.newStudentPassportOriginalNames.map((s) => (typeof s === 'string' ? s.trim() : ''))
          : [];
      }
      if (dto.programId !== undefined && dto.programId) {
        const program = await this.prisma.program.findUnique({
          where: { id: dto.programId },
        });
        if (!program) throw new NotFoundException('Программа не найдена');
        data.programId = dto.programId;
      }
    }

    // Обновление email существующего студента (если сделка привязана к
    // Student и менеджер прислал новый email). Работает и до, и после
    // APPROVE — email студента не блокирующее поле. Проверка уникальности
    // email в БД перед update — иначе Prisma бросит 500 при конфликте.
    if (
      dto.existingStudentEmail !== undefined &&
      submission.studentId // только если связан с существующим студентом
    ) {
      const emailRaw = dto.existingStudentEmail
        ? String(dto.existingStudentEmail).trim().toLowerCase()
        : null;
      if (emailRaw) {
        // Проверка уникальности: если этот email уже у другого Student — 409.
        const busy = await this.prisma.student.findFirst({
          where: { email: emailRaw, id: { not: submission.studentId } },
          select: { id: true },
        });
        if (busy) {
          throw new BadRequestException(
            'Email уже используется другим студентом',
          );
        }
      }
      await this.prisma.student.update({
        where: { id: submission.studentId },
        data: { email: emailRaw },
      });
    }

    const updated = await this.prisma.saleSubmission.update({
      where: { id: submissionId },
      data,
      include: {
        program: { select: { id: true, name: true, university: true } },
        student: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true, role: true } },
        payments: { orderBy: { paidAt: 'desc' } },
      },
    });
    this.realtime.emitStaff('submission:updated', { submissionId });
    return updated;
  }

  /**
   * Редактирование платежа.
   * - FOUNDER — любой платёж (PENDING/APPROVED, REJECTED нельзя).
   *   APPROVED: связанная Transaction обновляется атомарно в $transaction.
   *
   * Task 2: SALES_MANAGER больше НЕ может редактировать платежи, даже свои
   * PENDING. Раньше owner-manager мог менять amount/paidAt на PENDING —
   * это позволяло раздуть сумму после того, как FOUNDER согласовал сделку
   * устно, а затем «поправить» цифру перед APPROVE. Платежи — это деньги,
   * и любые правки должны идти через FOUNDER'а (аудит + подпись). Если
   * менеджер ошибся при создании PENDING-платежа, FOUNDER либо REJECT'ит
   * его (менеджер создаст новый), либо правит сам.
   */
  async updatePayment(
    user: (UserWithRoles & { id: string }) | null | undefined,
    paymentId: string,
    dto: {
      amount?: number;
      paymentMethod?: SubmissionPaymentMethod;
      paidAt?: string | Date;
      receiptUrls?: string[];
      depositProofUrls?: string[];
      nextDueDate?: string | Date | null;
      nextDueAmount?: number | null;
      notes?: string | null;
    },
  ) {
    if (!user) throw new ForbiddenException('Не авторизован');
    // Task 2: FOUNDER-only. Owner-PENDING ветка удалена — менеджеры больше
    // не могут править суммы/даты/файлы платежей ни при каком статусе.
    if (!isFounder(user)) {
      throw new ForbiddenException(
        'Платежи может редактировать только основатель',
      );
    }
    const payment = await this.prisma.submissionPayment.findUnique({
      where: { id: paymentId },
      include: {
        submission: { select: { id: true, currency: true, managerId: true } },
      },
    });
    if (!payment) throw new NotFoundException('Платёж не найден');
    if (payment.status === SubmissionPaymentStatus.REJECTED) {
      throw new BadRequestException('Отклонённый платёж нельзя редактировать');
    }

    const data: any = {};

    if (dto.amount !== undefined) {
      if (typeof dto.amount !== 'number' || !isFinite(dto.amount) || dto.amount <= 0) {
        throw new BadRequestException('Сумма платежа должна быть > 0');
      }
      data.amount = dto.amount;
    }

    let newPaidAt: Date | undefined;
    if (dto.paidAt !== undefined) {
      newPaidAt = parseClientDate(dto.paidAt as any);
      if (isNaN(newPaidAt.getTime())) {
        throw new BadRequestException('Некорректная дата платежа (paidAt)');
      }
      data.paidAt = newPaidAt;
    }

    // Валидация метода/файлов — как в create/addPayment: если меняем метод
    // или файлы, эффективный набор (новый метод + новые/старые файлы) должен
    // содержать соответствующие URL'ы.
    const effectiveMethod = dto.paymentMethod || payment.paymentMethod;
    const effectiveReceiptUrls = dto.receiptUrls !== undefined
      ? (Array.isArray(dto.receiptUrls) ? dto.receiptUrls : [])
      : payment.receiptUrls;
    const effectiveDepositProofUrls = dto.depositProofUrls !== undefined
      ? (Array.isArray(dto.depositProofUrls) ? dto.depositProofUrls : [])
      : payment.depositProofUrls;
    if (
      effectiveMethod === SubmissionPaymentMethod.TRANSFER &&
      effectiveReceiptUrls.length === 0
    ) {
      throw new BadRequestException('Загрузите минимум 1 чек перевода');
    }
    if (
      effectiveMethod === SubmissionPaymentMethod.CASH &&
      effectiveDepositProofUrls.length === 0
    ) {
      throw new BadRequestException('Загрузите минимум 1 скрин пополнения счёта');
    }
    if (dto.paymentMethod !== undefined) data.paymentMethod = effectiveMethod;
    if (dto.receiptUrls !== undefined) data.receiptUrls = effectiveReceiptUrls;
    if (dto.depositProofUrls !== undefined) data.depositProofUrls = effectiveDepositProofUrls;

    if (dto.nextDueDate !== undefined) {
      if (dto.nextDueDate === null) {
        data.nextDueDate = null;
      } else {
        const nd = parseClientDate(dto.nextDueDate as any);
        if (isNaN(nd.getTime())) {
          throw new BadRequestException('Некорректная дата следующего платежа');
        }
        data.nextDueDate = nd;
      }
    }
    if (dto.nextDueAmount !== undefined) data.nextDueAmount = dto.nextDueAmount ?? null;
    if (dto.notes !== undefined) {
      data.notes = dto.notes ? String(dto.notes).trim() || null : null;
    }

    // APPROVED + есть Transaction → синхронизируем финансовую запись, чтобы
    // дашборд доходов и бонусная база остались согласованы с payment.
    const needSyncFinance =
      payment.status === SubmissionPaymentStatus.APPROVED &&
      !!payment.financeTransactionId &&
      (data.amount !== undefined || data.paidAt !== undefined);

    if (needSyncFinance) {
      const updated = await this.prisma.$transaction(async (tx) => {
        const financeUpdate: any = {};
        if (data.amount !== undefined) financeUpdate.amount = data.amount;
        if (data.paidAt !== undefined) financeUpdate.date = data.paidAt;
        await tx.transaction.update({
          where: { id: payment.financeTransactionId! },
          data: financeUpdate,
        });
        return tx.submissionPayment.update({
          where: { id: paymentId },
          data,
        });
      });
      this.realtime.emitStaff('submission:payment-updated', {
        submissionId: payment.submissionId,
        paymentId,
      });
      return updated;
    }

    const updated = await this.prisma.submissionPayment.update({
      where: { id: paymentId },
      data,
    });
    this.realtime.emitStaff('submission:payment-updated', {
      submissionId: payment.submissionId,
      paymentId,
    });
    return updated;
  }

  /**
   * FOUNDER удаляет платёж. Если это ЕДИНСТВЕННЫЙ платёж — throw (нельзя
   * оставлять сделку без платежей; для полного удаления есть DELETE /:id).
   * Если платёж был APPROVED и есть linked Transaction — реверсим по
   * паттерну changeStatus: original.reversedAt=now + create обратной
   * EXPENSE-транзакции, чтобы finance dashboard и бонусная база
   * скорректировались, ПЛЮС откат партнёрской комиссии с этой транзакции.
   * Затем удаляем сам SubmissionPayment.
   *
   * Комиссия здесь обязательна ровно по той же причине, что и в CANCEL:
   * начисление партнёру привязано к финансовой Transaction, и удаление
   * породившего её платежа без отката оставляло бы живую выводимую комиссию
   * за платёж, которого больше нет. Обычно комиссия висит на ПЕРВОМ
   * одобренном платеже сделки («один раз за клиента»), поэтому удаление
   * второго/третьего платежа не найдёт ничего и пройдёт без изменений.
   */
  async deletePayment(
    user: (UserWithRoles & { id: string }) | null | undefined,
    paymentId: string,
  ) {
    if (!user || !isFounder(user)) {
      throw new ForbiddenException('Только основатель может удалять платёж');
    }
    const payment = await this.prisma.submissionPayment.findUnique({
      where: { id: paymentId },
      include: {
        submission: {
          select: {
            id: true,
            _count: { select: { payments: true } },
          },
        },
      },
    });
    if (!payment) throw new NotFoundException('Платёж не найден');
    if (payment.submission._count.payments <= 1) {
      throw new BadRequestException(
        'Это единственный платёж сделки — удаляйте всю сделку через DELETE /submissions/:id',
      );
    }

    const wasApproved = payment.status === SubmissionPaymentStatus.APPROVED;
    const submissionId = payment.submissionId;
    const shortId = submissionId.slice(0, 8);
    const reversedAt = new Date();
    const commissionReversals: CommissionReversal[] = [];

    await this.prisma.$transaction(async (tx) => {
      // Реверс финансовой записи по паттерну changeStatus (CANCEL-ветка).
      if (wasApproved && payment.financeTransactionId) {
        const original = await tx.transaction.findUnique({
          where: { id: payment.financeTransactionId },
          select: {
            amount: true,
            currency: true,
            studentId: true,
            managerId: true,
            reversedAt: true,
          },
        });
        if (original && !original.reversedAt) {
          await tx.transaction.update({
            where: { id: payment.financeTransactionId },
            data: { reversedAt },
          });
          await tx.transaction.create({
            data: {
              type: 'EXPENSE',
              category: 'OTHER_EXPENSE',
              amount: original.amount,
              currency: original.currency,
              // Дата возврата = сегодня, чтобы возврат попал в текущий
              // финансовый период (см. комментарий в changeStatus).
              date: reversedAt,
              studentId: original.studentId,
              managerId: original.managerId,
              recordedById: user.id,
              comment: `Возврат по сделке #${shortId} (удаление платежа основателем)`,
              reversedAt,
            },
          });
        }
      }
      // Партнёрская комиссия с этой же транзакции — в той же транзакции, что
      // и реверс дохода (см. changeStatus, пункт 4). Ошибка откатит удаление
      // платежа целиком: остаться без платежа, но с живой комиссией по нему
      // нельзя.
      if (wasApproved && this.referrals) {
        const reversals = await this.referrals.reverseCommissionsForTransactionsTx(
          tx,
          [payment.financeTransactionId],
          {
            reversedAt,
            reason:
              `Реверс: платёж по сделке #${shortId} удалён основателем ` +
              `${reversedAt.toISOString().slice(0, 10)}`,
          },
        );
        commissionReversals.push(...reversals);
      }
      // Удаляем сам платёж.
      await tx.submissionPayment.delete({ where: { id: paymentId } });
    });

    if (wasApproved && !this.referrals) {
      this.logger.error(
        `Партнёрская комиссия НЕ откачена при удалении платежа ${paymentId} ` +
          `(сделка ${submissionId}): ReferralsService не подключён.`,
      );
    }
    this.logCommissionReversals(
      commissionReversals,
      `удаление платежа ${paymentId}`,
    );

    // Счётчик откаченных комиссий сюда НЕ кладём: staff-канал слушают и
    // менеджеры, а сам факт партнёрской комиссии по клиенту им закрыт.
    // Детали — эмитом `commission:reversed` в finance-staff выше.
    this.realtime.emitStaff('submission:payment-deleted', {
      submissionId,
      paymentId,
      reversed: wasApproved,
    });
    return { ok: true, reversed: wasApproved };
  }

  // ПРИМЕЧАНИЕ ПО БОНУСНОЙ БАЗЕ (актуально после фикса bug #22):
  // SalaryService.preview() считает бонусную базу из ДВУХ источников:
  //   1) prisma.submissionPayment.aggregate({ status: APPROVED,
  //        reviewedAt ∈ period, submission.managerId = user }) — платежи
  //        по сделкам начисляются по моменту одобрения FOUNDER'ом, а не по
  //        paidAt; это спасает менеджера, если FOUNDER одобрил задним числом
  //        в уже закрытом зарплатном периоде (см. bug #22).
  //   2) prisma.transaction.aggregate({ type: INCOME,
  //        category != 'TUITION_PAYMENT', managerId, date ∈ period }) —
  //        ручные/исторические/импортированные INCOME-транзакции, не
  //        привязанные к сделке. Фильтр по category != 'TUITION_PAYMENT'
  //        гарантирует, что платежи по сделкам не считаются дважды
  //        (approvePayment всегда пишет category='TUITION_PAYMENT').
  //
  // Метод-заглушка approvedBonusableForUser(userId, from, to) больше не нужен:
  // источник №1 выше делает ровно то, что предполагалось от заглушки.
}
