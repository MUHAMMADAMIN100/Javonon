import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { hasRole, isFounder, UserWithRoles } from '../auth/role-utils';
import { SubmissionStatus, SubmissionPaymentStatus, SubmissionPaymentMethod, Prisma } from '@prisma/client';
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
    }

    const program = await this.prisma.program.findUnique({ where: { id: dto.programId } });
    if (!program) throw new NotFoundException('Программа не найдена');

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
    return s;
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
        // Application — всегда новая запись с status=ENROLLED.
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
            status: 'ENROLLED',
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

      // Создаём финансовую транзакцию (доход).
      // date = payment.paidAt намеренно: это финансовый «факт прихода денег»,
      // используется в дашборде доходов и для отчётности. Для бонусной базы
      // зарплаты эта дата НЕ используется (см. bug #22): SalaryService.preview
      // агрегирует бонус по SubmissionPayment.reviewedAt — иначе при задержке
      // одобрения FOUNDER'ом бонус мог попасть в уже закрытый зарплатный период
      // и потеряться (preview не пересчитывает PAID-записи).
      const finTx = await tx.transaction.create({
        data: {
          type: 'INCOME',
          category: 'TUITION_PAYMENT',
          amount: payment.amount,
          currency: submission.currency,
          date: payment.paidAt,
          comment: `Платёж по сделке #${submission.id.slice(0, 8)} (${program.name})`,
          studentId: studentId,
          managerId: submission.managerId,
          recordedById: reviewerId,
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
      return tx.submissionPayment.update({
        where: { id: paymentId },
        data: { financeTransactionId: finTx.id },
      });
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

    // managerId может быть null, если менеджер удалён — тогда персонального
    // уведомления некому слать, только staff-каналу.
    if (submission.managerId) {
      this.realtime.emitUser(submission.managerId, 'submission:approved', { paymentId, submissionId: submission.id });
    }
    this.realtime.emitStaff('submission:reviewed', { paymentId, status: 'APPROVED' });
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
   *      «одобрено» по отменённой сделке).
   * Bug #25 из audit:edge-cases: раньше CANCEL не откатывал ничего, и
   * деньги по отменённой сделке оставались в выручке и бонусной базе.
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
            await tx.transaction.create({
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

      return tx.saleSubmission.update({
        where: { id: submissionId },
        data: { status },
      });
    });

    // Уведомляем FOUNDER-канал: бухгалтерия должна видеть рефанд сразу.
    this.realtime.emitStaff('submission:cancelled', {
      submissionId,
      reversedPayments: approvedPayments.length,
    });

    return updated;
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
    },
  ) {
    if (!user || !isFounder(user)) {
      throw new ForbiddenException('Только основатель может редактировать сделку');
    }
    const submission = await this.prisma.saleSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, firstApprovedAt: true },
    });
    if (!submission) throw new NotFoundException('Сделка не найдена');

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
   * FOUNDER редактирует платёж. Если платёж APPROVED и есть привязанная
   * Transaction — обновляем её amount/date атомарно в одной $transaction.
   * REJECTED редактировать нельзя. PENDING — просто update без Transaction.
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
    if (!user || !isFounder(user)) {
      throw new ForbiddenException('Только основатель может редактировать платёж');
    }
    const payment = await this.prisma.submissionPayment.findUnique({
      where: { id: paymentId },
      include: {
        submission: { select: { id: true, currency: true } },
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
   * скорректировались. Затем удаляем сам SubmissionPayment.
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
      // Удаляем сам платёж.
      await tx.submissionPayment.delete({ where: { id: paymentId } });
    });

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
