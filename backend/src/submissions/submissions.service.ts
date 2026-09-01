import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, Optional } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ActivityService } from '../activity/activity.service';
import {
  ReferralsService,
  isNonPaymentReason,
  type CommissionReversal,
  type ReferralClientRef,
} from '../partners/referrals.service';
import { recordCommissionNonPayment } from '../partners/commission-audit';
import {
  COMMISSION_OUTBOX_INLINE_GRACE_MS,
  CommissionOutboxService,
} from '../partners/commission-outbox.service';
import {
  canPreviewDealFormPartner,
  canSeePartnerAttribution,
  hasRole,
  isFounder,
  UserWithRoles,
} from '../auth/role-utils';
import {
  maskPhoneForLog,
  parsePhoneIdentity,
  phoneMatchPrefilterTail,
  phonesMatch,
} from '../common/phone';
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
import { InstallmentsService } from '../installments/installments.service';

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
/**
 * Сколько заявок-кандидатов вычитывает поиск по телефону за раз.
 *
 * Пред-фильтр в SQL сравнивает последние 9 цифр и потому может вернуть больше
 * одной строки (соседние коды стран схлопываются именно так); настоящее
 * совпадение считает phonesMatch уже здесь, в коде. Кандидатов на один хвост
 * реально один-два, поэтому число — предохранитель от аномальных данных, а не
 * рабочий режим. Отбор идёт «старейшая атрибуция первой», так что обрезание
 * хвоста списка не может подменить победителя.
 */
const PHONE_MATCH_CANDIDATE_LIMIT = 20;

/**
 * Кто смотрит превью партнёра. UserWithRoles отвечает на вопрос «что за роль»,
 * но скоуп «свой ли это клиент» спрашивает про КОНКРЕТНОГО человека, поэтому
 * нужен ещё и id (JwtStrategy кладёт его в req.user.id).
 *
 * id опционален и проверяется на месте: без него скоуп отвечает «не своё»
 * (fail-closed), а не пропускает запрос.
 */
type PreviewViewer = UserWithRoles & { id?: string | null };

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
 * Валюта сделки: закрытый список + нормализация.
 *
 * ЗАЧЕМ (audit Q7, HIGH). `SaleSubmission.currency` — не подпись под суммой,
 * а ключ, по которому SalaryService.preview решает, попадает ли ОДОБРЕННЫЙ
 * платёж в бонусную базу: SubmissionPayment своей валюты не имеет, фильтр
 * идёт через relation `submission.currency === SALARY_REPORTING_CURRENCY`
 * ('TJS'). Раньше сюда прилетала любая строка (`dto.currency || 'USD'`,
 * @Body() без DTO-валидации), поэтому:
 *   - 'tjs' / ' TJS ' !== 'TJS' — настоящая TJS-сделка молча выпадала из
 *     salesAmount и уезжала в nonTjsSales; полоса менеджера тихо падала,
 *     и ошибки при этом не было ни одной;
 *   - любая мусорная строка ('доллар', 'US$') давала тот же эффект.
 * Отсюда trim().toUpperCase() и whitelist, совпадающий с финансовым
 * (finance.service.ts / settings.service.ts: TJS|USD|EUR|CNY|RUB) — валюта
 * сделки в отчётах стоит рядом с Transaction.currency, разные списки
 * разошлись бы на первой же сверке.
 */
const SUBMISSION_CURRENCIES = ['TJS', 'USD', 'EUR', 'CNY', 'RUB'] as const;
const DEFAULT_SUBMISSION_CURRENCY = 'USD';

/**
 * Приводит присланную валюту к канону или бросает 400.
 * Пустое/отсутствующее значение — это «не указали», а не ошибка: остаётся
 * дефолт схемы (USD), как и было до фикса.
 */
function normalizeSubmissionCurrency(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_SUBMISSION_CURRENCY;
  const c = String(raw).trim().toUpperCase();
  if (!c) return DEFAULT_SUBMISSION_CURRENCY;
  if (!(SUBMISSION_CURRENCIES as readonly string[]).includes(c)) {
    throw new BadRequestException(
      `Валюта сделки должна быть одной из: ${SUBMISSION_CURRENCIES.join(', ')}`,
    );
  }
  return c;
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
   *
   * НЕ ОТМЕНЯЕТ серверный поиск заявки-источника сам по себе: заявка без
   * атрибуции мостом не работает, и вместо неё выигрывает найденная заявка С
   * атрибуцией (см. create). Присланный id при этом не пропадает — он
   * остаётся, если поиск ничего не нашёл.
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
    // Рассрочка: create() материализует шаблон программы в этапы сделки,
    // approvePayment() гасит этапы внутри своей транзакции. НЕ @Optional():
    // в отличие от партнёрской части, план платежей — это условия самого
    // контракта, и молча создавать сделку без него нельзя.
    private installments: InstallmentsService,
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
    // Телефоны выбранного студента запоминаем здесь: они понадобятся ниже, в
    // поиске партнёрской заявки по номеру. Отдельным запросом их не тянем —
    // строка студента и так уже прочитана.
    let existingStudentPhones: string[] = [];
    if (!dto.studentId) {
      if (!dto.newStudentName || dto.newStudentName.trim().length < 2) {
        throw new BadRequestException('ФИО студента обязательно (мин. 2 символа)');
      }
    } else {
      const exists = await this.prisma.student.findUnique({ where: { id: dto.studentId } });
      if (!exists) throw new NotFoundException('Студент не найден');
      existingStudentPhones = Array.isArray(exists.phones) ? exists.phones : [];
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
    // Несёт ли присланная заявка партнёрскую атрибуцию. Колонка
    // sourceApplicationId заведена ровно ради неё, поэтому ниже этот флаг
    // решает, можно ли пропустить серверный поиск заявки-источника.
    let sourceApplicationHasAttribution = false;
    if (sourceApplicationIdRaw) {
      const sourceApp = await this.prisma.application.findUnique({
        where: { id: sourceApplicationIdRaw },
        select: { id: true },
      });
      if (!sourceApp) throw new NotFoundException('Заявка-источник не найдена');
      sourceApplicationId = sourceApp.id;
      sourceApplicationHasAttribution = await this.applicationCarriesAttribution(
        sourceApp.id,
      );
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

    // МОСТ К ПАРТНЁРУ, КОГДА МЕНЕДЖЕР ВОШЁЛ НЕ ЧЕРЕЗ КАРТОЧКУ ЗАЯВКИ.
    //
    // sourceApplicationId — единственная связь сделки с партнёрской
    // атрибуцией до первого одобрения (см. комментарий к колонке в
    // schema.prisma). Он приходит только от кнопки «Создать сделку» внутри
    // карточки заявки. Менеджер, нажавший «+ Новая сделка» в списке сделок,
    // отдавал сделку без всяких мостов: studentId ещё null (студент
    // создаётся на первом одобрении), applicationId ещё null (её создаёт то
    // же одобрение), sourceApplicationId — null. Партнёр после этого
    // недостижим НАВСЕГДА и денег не увидит.
    //
    // Поэтому ищем заявку клиента на сервере, а не в форме: потерять связь
    // «не тем входом» или «забыл поставить галочку» менеджер не должен уметь.
    //
    // ПОЧЕМУ ИМЕННО ЗДЕСЬ, ДО ПРОВЕРКИ ИДЕМПОТЕНТНОСТИ, А НЕ ПЕРЕД create().
    // Проверка ниже — это findFirst по окну времени, а НЕ constraint в БД
    // (уникального индекса под неё нет). Она держится исключительно на том,
    // что между чтением и вставкой ничего не происходит: каждый лишний
    // round-trip в этом промежутке — это окно, в котором второй клик успевает
    // прочитать «дубликатов нет» до того, как первый вставил строку, и сделка
    // задваивается. Резолвер делает до двух неиндексированных запросов, то
    // есть растянул бы промежуток втрое. При этом он ТОЛЬКО ЧИТАЕТ, а на
    // ветке `return existing` его результат всё равно выбрасывается — так что
    // цена переноса это лишний SELECT на дубликате, а цена обратного
    // переноса — удвоенный доход и удвоенный бонус. НЕ ОПУСКАЙТЕ ЕГО НИЖЕ.
    //
    // «ЯВНЫЙ ВЫБОР СИЛЬНЕЕ» ЗНАЧИТ «СИЛЬНЕЕ СРЕДИ ЗАЯВОК С АТРИБУЦИЕЙ».
    // dto.applicationId означает лишь «менеджер нажал кнопку в вот этой
    // карточке». Атрибуции на ней может не быть вовсе — клиент позвонил сам,
    // лид завели руками. Мостом к партнёру такая заявка не работает, а
    // замороженная в sourceApplicationId она ещё и отменяла поиск ниже. Для
    // НОВОГО студента это стоило партнёру денег: на одобрении множество
    // идентичности — это {новый studentId} ∪ {новая SUCCESSFUL_LEAD} ∪
    // {замороженная бесполезная заявка}, лендингового лида с атрибуцией в нём
    // нет ни под каким видом, и начисление молча уходило в no-attribution.
    // Перезаписать колонку потом нельзя (см. комментарий у create ниже), то
    // есть партнёр становился недостижим НАВСЕГДА — ровно тот исход, ради
    // предотвращения которого колонка и заведена.
    //
    // Поэтому неатрибуированная ссылка поиск не отменяет. Потерять её при
    // этом невозможно: резолвер отдал пусто — в колонке остаётся ровно то,
    // что прислал вызывающий, и сделка по-прежнему помнит свою карточку.
    if (!sourceApplicationId || !sourceApplicationHasAttribution) {
      const resolvedSourceApplicationId = await this.resolveSourceApplicationId({
        studentId: dto.studentId || null,
        // У существующего студента newStudentPhone обнуляется (см. ниже в
        // data), поэтому сравниваем по его основному номеру.
        phone: dto.studentId ? existingStudentPhones[0] : dto.newStudentPhone,
        // Путь на запись: совпадение по телефону обязано остаться в журнале —
        // именно оно потом оплачивается партнёру.
        audit: true,
      });
      if (resolvedSourceApplicationId) {
        sourceApplicationId = resolvedSourceApplicationId;
      }
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
      include: {
        payments: true,
        program: true,
        student: true,
        // Тот же include, что у ветки реального создания ниже: идемпотентный
        // ответ обязан быть неотличим от первого, иначе форма после двойного
        // клика решит, что рассрочки у сделки нет.
        paymentStages: { orderBy: { order: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      // Идемпотентный ответ: возвращаем ту же сделку, новых записей не создаём.
      return existing;
    }

    // РАССРОЧКА: материализуем шаблон программы в этапы сделки.
    //
    // Считаем ДО create и вкладываем результат в тот же вызов, а не пишем
    // этапы отдельным запросом после: вложенный create коммитится одной
    // транзакцией со сделкой, поэтому состояния «сделка есть, а плана нет»
    // (упали между двумя запросами) не существует в принципе.
    //
    // Старт плана — момент заключения сделки. `firstApprovedAt` на этот
    // момент ещё null (студент и заявка создаются только на первом
    // одобрении), так что отсчитывать сроки больше не от чего; отличие
    // dealStart от фактического `createdAt` — миллисекунды, а нужна лишь
    // календарная дата в Душанбе.
    //
    // Шаблона у программы нет → массив пустой → этапов не создаём. Угадывать
    // план («один этап на всю сумму») нельзя: это молча объявило бы клиента
    // должником на весь контракт в день подписания.
    const dealStart = new Date();
    const stageRows = await this.installments.buildStagesForNewSubmission({
      programId: dto.programId,
      totalAmount: dto.totalAmount,
      dealStart,
    });

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
        // Whitelist + trim/uppercase (audit Q7): по этому полю фильтруется
        // бонусная база в SalaryService (см. normalizeSubmissionCurrency).
        currency: normalizeSubmissionCurrency(dto.currency),
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
        // Пустой массив — это «шаблона нет», а не «забыли»: Prisma на
        // `create: []` не пишет ни одной строки.
        paymentStages: stageRows.length ? { create: stageRows } : undefined,
      },
      include: {
        payments: true,
        program: true,
        student: true,
        paymentStages: { orderBy: { order: 'asc' } },
      },
    });

    this.realtime.emitStaff('submission:new', { submissionId: submission.id, managerId });
    return submission;
  }

  /**
   * Висит ли на ЭТОЙ заявке партнёрская атрибуция.
   *
   * Нужно ровно в одном месте — на входе «Создать сделку из карточки заявки»,
   * чтобы отличить лид с лендинга (мост к партнёру) от заявки, заведённой
   * руками (мостом не работает). Дальше по этому ответу create() решает,
   * пропускать ли поиск заявки-источника.
   *
   * Отдельным запросом, а не include в findUnique выше: ReferralAttribution
   * связана с заявкой только полем applicationId, relation'а в схеме нет.
   * Запрос уходит лишь на этом входе и бьёт по @@index([applicationId]).
   *
   * НИКОГДА НЕ БРОСАЕТ — по той же причине, что и resolveSourceApplicationId
   * ниже: сорванный партнёрский запрос не должен стоить менеджеру сделки.
   * Ответ на сбое — false, то есть «поиск заявки-источника всё-таки сделай»:
   * резолвер сам не бросает, а если и он ничего не найдёт, в колонке
   * останется присланный вызывающим id. Потерять при сбое нечего.
   */
  private async applicationCarriesAttribution(applicationId: string): Promise<boolean> {
    try {
      const attr = await this.prisma.referralAttribution.findFirst({
        where: { applicationId },
        select: { id: true },
      });
      return !!attr;
    } catch (e: any) {
      this.logger.warn(
        `Атрибуция заявки-источника не проверена (applicationId=${applicationId}): ${e?.message || e}`,
      );
      return false;
    }
  }

  /**
   * Ищет заявку клиента, на которой висит партнёрская атрибуция — чтобы
   * положить её в SaleSubmission.sourceApplicationId и не потерять партнёра.
   *
   * ПОРЯДОК ПОИСКА (важен: первый сработавший шаг выигрывает).
   *  1. Выбран существующий студент → берём его заявки и среди них ту, у
   *     которой ЕСТЬ атрибуция.
   *  2. Иначе (или если у студента ничего не нашлось) — сопоставление по
   *     ТЕЛЕФОНУ (phonesMatch: национальная часть целиком + код страны, см.
   *     common/phone.ts). Написание имени не участвует вообще: «Иванов И.»,
   *     «Iванов Ислом» и «Ivanov» — это один и тот же клиент, а номер он
   *     диктует один.
   *
   * ШАГ 2 НЕ РЕШАЕТ ПО ХВОСТУ НОМЕРА. Пред-фильтр в SQL по последним 9 цифрам
   * остался (индекса под разбор кода страны в БД нет), но он только СУЖАЕТ
   * кандидатов; решение принимает phonesMatch уже на прочитанных строках.
   * Разница не косметическая: по хвосту «+998 90 123 45 67» и
   * «+992 90 123 45 67» — один ключ, то есть узбекский лид партнёра и
   * таджикский клиент с тем же национальным номером были одним человеком, а
   * запись «+992 1234567» (7 цифр, лендинг такое пропускает) выглядела как
   * чужой +992 92 123 45 67. Разбор с кодом страны обе развязывает, а
   * неоднозначные записи (10–11 цифр без подходящего кода) не сопоставляет
   * ни с чем.
   *
   * ШАГ 2 НИКОГДА НЕ ПЕРЕСЕКАЕТ ГРАНИЦУ ЧУЖОГО КЛИЕНТА. Номер бывает
   * семейным, поэтому по телефону подбираются только заявки БЕЗ студента
   * (неконвертированные лиды) и заявки САМОГО выбранного студента. Заявка,
   * уже принадлежащая другому студенту, не подбирается никогда — иначе
   * автоматическая догадка сервера сожгла бы его партнёрскую комиссию (см.
   * развёрнутый разбор у запроса ниже).
   *
   * Среди нескольких кандидатов выигрывает СТАРЕЙШАЯ атрибуция — партнёр,
   * приведший клиента первым. Тот же приоритет, что в
   * findAttributionByIdentity и getPartnerAttributionViewsBatch; расхождение
   * означало бы, что карточка показывает одного партнёра, а деньги уходят
   * другому.
   *
   * Заявки БЕЗ атрибуции сюда не попадают ни на одном шаге: партнёра они не
   * добавляют, а проставленный из такой заявки sourceApplicationId только
   * заморозил бы бесполезную ссылку (перезаписывать её потом нельзя).
   *
   * НИКОГДА НЕ БРОСАЕТ. Сорванный поиск партнёра — это «партнёра не нашли»,
   * а не «сделку не создали»: потерять сделку менеджера из-за проблемы в
   * партнёрском поиске несоизмеримо хуже. Все сбои уходят в logger.
   */
  private async resolveSourceApplicationId(opts: {
    studentId?: string | null;
    phone?: string | null;
    /**
     * true — вызов на ЗАПИСЬ (create). Совпадение по телефону уходит в лог
     * уровня info: это единственный след того, какую именно чужую заявку
     * сервер угадал по номеру, а на ней потом висит реальная выплата
     * партнёру. Превью формы дёргается на каждый ввод символа, поэтому там
     * false и debug — иначе журнал заливается служебным шумом.
     */
    audit?: boolean;
  }): Promise<string | null> {
    try {
      // Шаг 1 — заявки выбранного студента.
      if (opts.studentId) {
        const apps = await this.prisma.application.findMany({
          where: { studentId: opts.studentId },
          select: { id: true },
        });
        if (apps.length > 0) {
          const attr = await this.prisma.referralAttribution.findFirst({
            where: { applicationId: { in: apps.map((a) => a.id) } },
            // Старейшая привязка выигрывает (см. док-комментарий выше).
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { applicationId: true },
          });
          if (attr?.applicationId) return attr.applicationId;
        }
      }

      // Шаг 2 — сопоставление по телефону.
      // Номер могли не передать (превью формы знает только studentId) —
      // добираем основной телефон студента, чтобы превью и создание сделки
      // искали ОДНО И ТО ЖЕ. create() номер передаёт сам (студент там уже
      // прочитан), поэтому лишнего запроса на записи не возникает.
      let phone = opts.phone ?? null;
      if (!parsePhoneIdentity(phone) && opts.studentId) {
        const st = await this.prisma.student.findUnique({
          where: { id: opts.studentId },
          select: { phones: true },
        });
        phone = st?.phones?.[0] ?? null;
      }
      // Номер, который нельзя разобрать однозначно (обрывок, «+992 1234567»,
      // любые 10–11 цифр без подходящего кода страны), ключа не получает — и
      // запрос по нему не уходит вовсе.
      const tail = phoneMatchPrefilterTail(phone);
      if (!tail) return null;

      // ЧЕСТНО ПРО СТОИМОСТЬ: Application.phone хранится СЫРЫМ (в сервисе
      // только .trim(), см. applications.service), индекса на нём нет, и
      // индекса по «последним 9 цифрам» тоже нет — под tail-сравнение нужен
      // functional index, а он потребовал бы миграции.
      //
      // Поэтому сравнение считается на лету. Чтобы это не превратилось в
      // проход по ВСЕЙ таблице заявок, идём от ReferralAttribution, а не от
      // Application: заявки без атрибуции нас всё равно не интересуют, а
      // строк атрибуции на порядок меньше — это только партнёрский трафик.
      // JOIN по первичному ключу заявки, regexp считается лишь по отобранным
      // строкам, ORDER BY/LIMIT выполняет правило «старейшая атрибуция».
      // Один запрос, одна лишняя миллисекунда на создание сделки.
      //
      // ГРАНИЦА ПРИМЕНИМОСТИ: это решение для нынешнего масштаба (заявок
      // сотни, атрибуций — десятки). Когда партнёрских привязок станут
      // десятки тысяч, дешёвого способа два: functional index
      // `((right(regexp_replace(phone,'[^0-9]','','g'),9)))` на Application
      // либо отдельная нормализованная колонка. Делать вид, что текущий
      // вариант масштабируется, не нужно — он рассчитан на seq scan по
      // маленькой таблице.

      // ГРАНИЦА ЧУЖОГО КЛИЕНТА — ЧАСТЬ УСЛОВИЯ, А НЕ ОПТИМИЗАЦИЯ.
      //
      // Совпадение хвоста номера НЕ доказывает, что это тот же человек.
      // Семейный номер здесь — первоклассная сущность схемы
      // (Application.secondaryContactLabel и Student.phoneLabels хранят
      // «Отец»/«Мать»), так что номер родителя, записанный в лендинговой
      // заявке брата Б и введённый как основной телефон сестры А, — рядовая
      // форма данных, а не экзотика.
      //
      // Без этого предиката сделка А получала sourceApplicationId заявки Б, и
      // ошибка уходила прямо в деньги: approvePayment передаёт его в
      // creditCommissionForAttributionOnce → строка атрибуции Б попадает в
      // набор идентичности клиента → (1) backfillAttributionStudent
      // переписывает ей studentId на А, (2) CAS-штамп ставит ей commissionedAt.
      // Когда позже платит сам Б, guard отвечает already-credited, и партнёр,
      // реально приведший Б, не получает НИЧЕГО — молча и навсегда. Ровно та
      // потеря, ради предотвращения которой мост и существует.
      //
      // Поэтому берём только заявки, про которые НЕ доказано, что они чужие:
      //   • студент выбран        → его собственные заявки + ничейные лиды;
      //   • студента ещё нет      → только ничейные лиды.
      // Заявка с ЧУЖИМ studentId не проходит ни в одном из случаев. Целевой
      // сценарий — неконвертированный лид с лендинга (studentId IS NULL) —
      // работает как работал.
      //
      // Ветка через Prisma.sql, а не параметр-NULL в общем выражении: для
      // нового студента условие обязано быть строго `IS NULL`, а не
      // сравнением с NULL, которое зависит от типизации плейсхолдера.
      const studentScope = opts.studentId
        ? Prisma.sql`AND (a."studentId" IS NULL OR a."studentId" = ${opts.studentId})`
        : Prisma.sql`AND a."studentId" IS NULL`;

      // ХВОСТ В SQL — ПРЕД-ФИЛЬТР, А НЕ РЕШЕНИЕ.
      //
      // right(digits, 9) не умеет отличить код страны от номера, поэтому
      // «+998 90 123 45 67» и «+992 90 123 45 67» он отдаёт как одну строку.
      // Раз решать по нему нельзя, а сузить кандидатов можно (условие
      // необходимое — доказательство у phoneMatchPrefilterTail), запрос
      // читает phone и отдаёт НЕСКОЛЬКО строк, а окончательное «это тот же
      // человек» считает phonesMatch здесь, с разбором кода страны.
      //
      // LIMIT — страховка от аномалии, а не рабочий режим: строк с одним
      // хвостом реально одна-две. Порядок «старейшая атрибуция первой»
      // сохраняется, поэтому обрезание сверху не может подменить победителя —
      // отбрасываются только те, что заведомо моложе выбранной.
      const rows = await this.prisma.$queryRaw<Array<{ id: string; phone: string | null }>>`
        SELECT a."id", a."phone"
        FROM "ReferralAttribution" ra
        JOIN "Application" a ON a."id" = ra."applicationId"
        WHERE right(regexp_replace(a."phone", '[^0-9]', '', 'g'), 9) = ${tail}
        ${studentScope}
        ORDER BY ra."createdAt" ASC, ra."id" ASC
        LIMIT ${Prisma.raw(String(PHONE_MATCH_CANDIDATE_LIMIT))}
      `;

      let rejected = 0;
      for (const row of rows) {
        if (!phonesMatch(row.phone, phone)) {
          rejected += 1;
          continue;
        }
        // СЛЕД ДЛЯ РАЗБОРА ВЫПЛАТЫ. Дальше этот id уезжает в
        // SaleSubmission.sourceApplicationId, а с него — в
        // creditCommissionForAttributionOnce, и перезаписать колонку потом
        // нельзя. Если сервер угадал не того клиента, единственный способ
        // это доказать постфактум — строка лога: какую заявку выбрали, по
        // какому номеру и сколько кандидатов отсеяли.
        const line =
          `Заявка-источник найдена по телефону: application=${row.id}, ` +
          `номер=${maskPhoneForLog(phone)}, студент=${opts.studentId ?? '-'}, ` +
          `кандидатов=${rows.length}, отсеяно кодом страны=${rejected}`;
        if (opts.audit) this.logger.log(line);
        else this.logger.debug(line);
        return row.id;
      }

      if (rejected > 0 && opts.audit) {
        // Пред-фильтр нашёл номер, разбор его отклонил. Ровно тот случай, ради
        // которого правило и переписано: раньше здесь молча возвращался чужой
        // applicationId и партнёру уходили деньги.
        this.logger.log(
          `Заявка-источник по телефону не найдена: ${rejected} кандидат(ов) с тем же ` +
            `хвостом отклонены по коду страны (номер=${maskPhoneForLog(phone)}, ` +
            `студент=${opts.studentId ?? '-'})`,
        );
      }
      return null;
    } catch (e: any) {
      // Осознанно warn, а не error: сделка создалась, деньги на месте,
      // руками восстановимо (FOUNDER видит партнёра в карточке заявки).
      this.logger.warn(
        `Партнёрская заявка-источник не определена (studentId=${opts.studentId ?? '-'}): ${e?.message || e}`,
      );
      return null;
    }
  }

  /**
   * СВОЙ ЛИ ЭТО КЛИЕНТ — скоуп-гейт превью партнёра (см.
   * previewPartnerForClient). Спрашивается по КАЖДОМУ переданному ключу
   * отдельно; вызывающий обязан требовать «свой» от всех сразу.
   *
   * Правило то же, что уже действует в students.service.findAll и
   * applications.service.findAll: менеджер работает с записями, где назначен
   * он сам — TJ (managerId) или CN (chinaManagerId). Здесь оно перенесено на
   * ВХОД превью, чтобы «кто привёл клиента» нельзя было спросить про
   * человека, которого вызывающий и так не видит ни в одном своём списке.
   *
   * НЕНАЗНАЧЕННЫЕ ЗАПИСИ (managerId и chinaManagerId оба null) «своими» НЕ
   * считаются — сознательно, хотя applications.ensureCanEdit их пропускает
   * («не назначен — любой может взять в работу»). Скоуп чтения обязан
   * совпадать с ВИДИМОСТЬЮ, а не с правом правки: findAll ничьи заявки
   * менеджеру не показывает, значит и превью по ним отвечать не должно.
   * Штатный путь не задет: лид с лендинга почти всегда назначен сразу —
   * applications.service.create раздаёт их round-robin
   * (sales.pickManagerForLead).
   */
  private async callerOwnsStudent(viewerId: string, studentId: string): Promise<boolean> {
    const own = await this.prisma.student.findFirst({
      where: {
        id: studentId,
        OR: [{ managerId: viewerId }, { chinaManagerId: viewerId }],
      },
      select: { id: true },
    });
    if (own) return true;
    // Студент может быть закреплён за другим менеджером, а конкретная заявка
    // этого же человека — за вызывающим (типовой случай: лид ведёт продажник,
    // сопровождение — китайский менеджер). Своя заявка клиента — такое же
    // законное основание видеть превью по нему.
    const ownApp = await this.prisma.application.findFirst({
      where: {
        studentId,
        OR: [{ managerId: viewerId }, { chinaManagerId: viewerId }],
      },
      select: { id: true },
    });
    return !!ownApp;
  }

  private async callerOwnsApplication(
    viewerId: string,
    applicationId: string,
  ): Promise<boolean> {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { managerId: true, chinaManagerId: true, studentId: true },
    });
    // Несуществующая заявка — не «своя». Отказ и промах для вызывающего
    // неотличимы (оба дают null), так что оракула «такой id есть» нет.
    if (!app) return false;
    if (app.managerId === viewerId || app.chinaManagerId === viewerId) return true;
    if (app.studentId) return this.callerOwnsStudent(viewerId, app.studentId);
    return false;
  }

  private async callerOwnsPhone(viewerId: string, phone: string): Promise<boolean> {
    const tail = phoneMatchPrefilterTail(phone);
    // Неразбираемый номер ключа не получает — и запрос по нему не уходит
    // (то же правило, что в resolveSourceApplicationId).
    if (!tail) return false;

    // ХВОСТ В SQL — ПРЕД-ФИЛЬТР, РЕШАЕТ phonesMatch. Предикат по менеджеру
    // стоит первым не для красоты: под него есть индексы (Application и
    // Student — @@index([managerId]) и @@index([chinaManagerId])), поэтому
    // regexp считается по записям самого вызывающего, а не по всей таблице.
    //
    // РЕШАТЬ ПО ХВОСТУ ЗДЕСЬ НЕЛЬЗЯ, хотя соблазн есть: это «всего лишь»
    // проверка принадлежности. Но хвост склеивает соседние коды стран, и
    // склейка работает в обе стороны. Менеджеру достаточно вести ОДНОГО
    // узбекского клиента +998 90 123 45 67, чтобы пройти скоуп по чужому
    // таджикскому +992 90 123 45 67 — а дальше резолвер честно разберёт код
    // страны и покажет партнёра именно того, чужого клиента. То есть гейт
    // пропускал бы ровно тот запрос, ради запрета которого написан.
    // Поэтому кандидатов сужает хвост, а «это тот же человек» решает
    // phonesMatch с разбором кода страны — как и везде.
    const rows = await this.prisma.$queryRaw<Array<{ phone: string | null }>>`
      SELECT c."phone"
      FROM (
        SELECT a."phone" AS phone
        FROM "Application" a
        WHERE (a."managerId" = ${viewerId} OR a."chinaManagerId" = ${viewerId})
          AND right(regexp_replace(a."phone", '[^0-9]', '', 'g'), 9) = ${tail}
        UNION ALL
        SELECT sp."value" AS phone
        FROM "Student" s
        CROSS JOIN unnest(s."phones") AS sp("value")
        WHERE (s."managerId" = ${viewerId} OR s."chinaManagerId" = ${viewerId})
          AND right(regexp_replace(sp."value", '[^0-9]', '', 'g'), 9) = ${tail}
      ) c
      LIMIT ${Prisma.raw(String(PHONE_MATCH_CANDIDATE_LIMIT))}
    `;
    return rows.some((r) => phonesMatch(r.phone, phone));
  }

  /**
   * След обращения к превью в ActivityLog.
   *
   * ЗАЧЕМ. Превью — единственная поверхность, где партнёрские данные видит
   * не-elevated роль, и до этой записи обращения к нему не оставляли следа
   * нигде: прогон списка чужих номеров был не только возможен, но и
   * недоказуем постфактум. Пишем КАЖДЫЙ реальный lookup, включая отказ по
   * скоупу и промах, — серия отказов и есть самый явный признак перебора, и
   * теряется он первым, если логировать только удачные ответы. Вызывающий
   * при этом во всех трёх исходах получает одинаковый null, так что журнал
   * знает больше, чем узнал он.
   *
   * НОМЕР МАСКИРУЕТСЯ (maskPhoneForLog, последние 4 цифры) — та же
   * конвенция, что у остального партнёрского логирования: телефон это ПДн, а
   * для «тот ли это клиент, что в карточке» и для счёта различных проб за
   * минуту четырёх цифр достаточно.
   *
   * НИКОГДА НЕ БРОСАЕТ: превью справочное, и провал INSERT'а в журнал не
   * должен гасить плашку у менеджера. Провал уходит в logger.warn — как в
   * recordCommissionNonPayment, по той же причине (два носителя, журнал —
   * вторичный).
   */
  private async logPartnerPreviewLookup(opts: {
    viewer: PreviewViewer;
    studentId: string | null;
    applicationId: string | null;
    phone: string | null;
    outcome: 'found' | 'not-found' | 'denied';
    referralCode?: string | null;
  }): Promise<void> {
    const OUTCOME_RU: Record<typeof opts.outcome, string> = {
      found: 'партнёр найден',
      'not-found': 'партнёр не найден',
      denied: 'отказано: клиент не закреплён за вызывающим',
    };
    const phoneMasked = opts.phone ? maskPhoneForLog(opts.phone) : null;
    // Ключ, по которому спрашивали: именно он отличает работу по своим
    // клиентам от прогона чужого списка номеров.
    const subject =
      [
        opts.studentId ? `студент ${opts.studentId}` : null,
        opts.applicationId ? `заявка ${opts.applicationId}` : null,
        phoneMasked ? `номер ${phoneMasked}` : null,
      ]
        .filter(Boolean)
        .join(', ') || '—';
    try {
      await this.activity.log({
        actorId: opts.viewer.id || null,
        actorRole: String(opts.viewer.role ?? '—'),
        action: 'PARTNER_PREVIEW_LOOKUP',
        // В индексированную колонку кладём id только когда он подтверждён как
        // свой: на отказе строка ещё не доказана существующей, а по этой
        // колонке журнал джойнят с карточкой студента.
        studentId: opts.outcome === 'denied' ? null : opts.studentId,
        details: `Превью «кто привёл клиента» (${subject}) — ${OUTCOME_RU[opts.outcome]}`,
        payload: {
          outcome: opts.outcome,
          studentId: opts.studentId,
          applicationId: opts.applicationId,
          phone: phoneMasked,
          referralCode: opts.referralCode ?? null,
        },
      });
    } catch (e: any) {
      this.logger.warn(
        `Не удалось записать PARTNER_PREVIEW_LOOKUP в ActivityLog (${subject}): ${e?.message || e}`,
      );
    }
  }

  /**
   * Кто привёл этого клиента — для формы создания сделки. ТОЛЬКО ЧТЕНИЕ,
   * ничего не создаёт и не меняет.
   *
   * ГЕЙТ — canPreviewDealFormPartner(viewer), узкое исключение из
   * canSeePartnerAttribution (оба живут в auth/role-utils). Везде ещё
   * (карточки студента/заявки/сделки, списки) партнёрские данные закрыты от
   * менеджеров. Здесь — открыты, и вот почему: связь с партнёром теперь
   * проставляет СЕРВЕР, а менеджер обязан видеть, что именно система нашла
   * по введённому номеру. Иначе решение «партнёру заплатят» принимается
   * невидимо для того единственного человека, который в этот момент говорит
   * с клиентом и может заметить ошибку.
   *
   * ПОЧЕМУ ГЕЙТ ЗДЕСЬ, А НЕ ТОЛЬКО @Roles НА КОНТРОЛЛЕРЕ. @Roles(...) этот
   * круг НЕ удерживает: у носителя активной кастомной роли base role — лишь
   * «подложка» (RolesGuard.skipBaseRole), и дальше RolesGuard пускает по
   * implicit-проверке URL, где на GET проходит любой submissions:*, включая
   * read-only submissions:read. Роль вида «Таргетолог»/«SMM» с одним
   * «Продажи — просмотр» доходила бы сюда, НЕ имея права создать сделку
   * (POST /submissions её отсекает). Это ломало заявленный инвариант «роли
   * зеркалят POST /submissions» и обходило fail-closed правило, ради
   * которого canSeePartnerAttribution и написан. Остальные партнёрские
   * поверхности (getOne, listAll, listPendingPayments, students, applications)
   * такого носителя останавливают — эта обязана тоже.
   *
   * Отказ = null, а не 403: превью справочное, и «партнёра не нашли» и
   * «показывать нельзя» для формы одинаковы — она молча не рисует чип
   * (SubmissionForm: retry:false, data ?? null). Кастомная роль с правом
   * оформлять сделки продолжает их оформлять, просто без партнёрского блока —
   * ровно как на всех прочих поверхностях. Партнёрский резолвер при отказе не
   * запускается вовсе: ни запроса, ни строчки в лог.
   *
   * ЧТО ИМЕННО ОТДАЁМ — минимум: имя партнёра, его код и сумма комиссии по
   * ЭТОМУ клиенту. Ни баланса, ни списка клиентов, ни partnerId, ни
   * referralUrl, ни истории начислений. Ответ всегда про одного клиента,
   * которого менеджер прямо сейчас вводит, поэтому эндпоинт не превращается
   * в справочник партнёров.
   *
   * ВТОРОЙ ГЕЙТ — СКОУП: «СВОЙ ЛИ ЭТО КЛИЕНТ» (callerOwns*).
   *
   * Роль отвечает на вопрос «показывать ли партнёров вообще», но не на вопрос
   * «про кого». Без скоупа эндпоинт принимал ЛЮБОЙ телефон, ЛЮБОЙ studentId и
   * ЛЮБОЙ applicationId без единой проверки принадлежности, и непустой ответ
   * сам по себе был утверждением «вот этот номер — клиент от партнёра», да ещё
   * с именем партнёра, его кодом и суммой комиссии. Вслепую 9-значное
   * пространство не пройти, но прогнать ИЗВЕСТНЫЙ список номеров (выгрузка,
   * свой старый телефонник, база конкурента) — вполне: получался справочник
   * ЧУЖОЙ клиентуры ценой одного запроса на номер.
   *
   * Поэтому не-elevated вызывающий обязан быть менеджером этого клиента —
   * тот же скоуп, что в students.service.findAll / applications.service.findAll.
   * Обоснование самого исключения от этого не страдает: свою сделку менеджер
   * заводит по СВОЕМУ клиенту. Elevated (canSeePartnerAttribution) скоуп не
   * проходят — им те же данные и так отдаёт партнёрский блок карточек.
   *
   * ПРОВЕРЯЕТСЯ КАЖДЫЙ КЛЮЧ, А НЕ «ХОТЯ БЫ ОДИН». Ключей три, и в резолвер они
   * идут независимо друг от друга. При проверке «хотя бы одного» пара «свой
   * studentId + чужой applicationId» проходила бы гейт и возвращала партнёра
   * ЧУЖОЙ заявки — то есть весь скоуп обходился бы одним лишним параметром.
   * Достаточно одного непринадлежащего ключа, чтобы ответ стал null.
   *
   * ОТКАЗ НЕОТЛИЧИМ ОТ ПРОМАХА — оба дают null. ForbiddenException был бы тем
   * же оракулом с другой стороны: «403 вместо пустоты» означало бы «номер в
   * базе есть, просто он чужой». Форма трактует null как «партнёра нет» и
   * молча не рисует чип, отдельного состояния под отказ не нужно.
   *
   * ТРЕТИЙ И ЧЕТВЁРТЫЙ РУБЕЖИ — ЛИМИТ И ЖУРНАЛ:
   *   • @Throttle на маршруте (submissions.controller): дефолтного бакета
   *     60/мин здесь мало — это ~3600 проб в час, чего для прогона списка
   *     номеров с запасом хватает;
   *   • ActivityLog(PARTNER_PREVIEW_LOOKUP) на КАЖДЫЙ реальный lookup, включая
   *     отказ по скоупу (см. logPartnerPreviewLookup). Раньше перебор не
   *     оставлял в журнале ни строчки — то есть был не только возможен, но и
   *     недоказуем.
   * Ключом при этом по-прежнему служит только ПОЛНЫЙ разобранный номер
   * (parsePhoneIdentity отдаёт null и на обрывке, и на неоднозначной записи).
   *
   * `applicationId` — та самая заявка-источник из адреса формы
   * (`/submissions/new?applicationId=…`). Она НЕ подсказка к поиску, а тот же
   * приоритет, что в create(): названную вызывающим заявку смотрим первой, а
   * резолвер зовём ровно в тех же двух случаях, что и create(), — её не
   * назвали вовсе либо на ней НЕТ атрибуции (см. ниже).
   */
  async previewPartnerForClient(opts: {
    phone?: string | null;
    studentId?: string | null;
    applicationId?: string | null;
    /** Кто спрашивает. Без него превью не строится (fail-closed). */
    viewer?: PreviewViewer | null;
  }): Promise<{
    fullName: string;
    referralCode: string;
    commissionAmountCents: number;
    /** null = это прогноз по текущей ставке (TJS), а не начисленная сумма. */
    commissionCurrency: string | null;
  } | null> {
    // Авторизация по роли — до любой работы: отказ не должен ни ходить в БД,
    // ни отличаться по времени ответа от «партнёра не нашли». В журнал он
    // тоже не идёт: решение статично, ни одного клиента вызывающий
    // результативно не назвал, а INSERT на каждый заведомо запрещённый GET —
    // это только способ засорить журнал тому, кто ничего не узнал.
    const viewer = opts.viewer ?? null;
    if (!canPreviewDealFormPartner(viewer)) return null;
    if (!this.referrals) return null;

    // Длину ключей режем: они уходят в ActivityLog.payload, и без потолка
    // вызывающий писал бы в журнал строки произвольного размера. Настоящие
    // id — uuid (36 символов), легальный ввод обрезка не задевает.
    const KEY_MAX = 100;
    const studentId = typeof opts.studentId === 'string' && opts.studentId.trim()
      ? opts.studentId.trim().slice(0, KEY_MAX)
      : null;
    const phone = typeof opts.phone === 'string' ? opts.phone : null;
    // Разобрать номер обязаны ЗДЕСЬ, а не внутри резолвера: неразбираемая
    // строка ключом не является, значит по ней нечего ни проверять на
    // принадлежность, ни писать в журнал.
    const usablePhone = parsePhoneIdentity(phone) ? phone : null;
    // Пустую строку из query-параметра трактуем как отсутствие ссылки — ровно
    // как create() (см. sourceApplicationIdRaw).
    const explicitApplicationId =
      typeof opts.applicationId === 'string' && opts.applicationId.trim()
        ? opts.applicationId.trim().slice(0, KEY_MAX)
        : null;
    // Заявка-источник — самостоятельный ключ клиента, не довесок к телефону:
    // на входе `/submissions/new?applicationId=…` у лида может не быть
    // пригодного номера (или менеджер ещё не дошёл до поля), а сделка эту
    // заявку всё равно запишет. Молчать в этом случае — значит скрыть от
    // менеджера партнёра, которому по его сделке заплатят.
    //
    // Спрашивать не о чем — ни журнала, ни расхода лимита: ничего не
    // резолвилось и ничего не раскрыто.
    if (!studentId && !explicitApplicationId && !usablePhone) return null;

    try {
      // СКОУП-ГЕЙТ (см. док-комментарий). Каждый переданный ключ обязан
      // принадлежать вызывающему; elevated пропускаем — партнёрский блок
      // карточек и так отдаёт им то же самое.
      if (!canSeePartnerAttribution(viewer)) {
        const viewerId = typeof viewer?.id === 'string' ? viewer.id : '';
        // Fail-closed: без id владельца проверять принадлежность нечем.
        const ownsAll =
          !!viewerId &&
          (!studentId || (await this.callerOwnsStudent(viewerId, studentId))) &&
          (!explicitApplicationId ||
            (await this.callerOwnsApplication(viewerId, explicitApplicationId))) &&
          (!usablePhone || (await this.callerOwnsPhone(viewerId, usablePhone)));
        if (!ownsAll) {
          await this.logPartnerPreviewLookup({
            viewer: viewer as PreviewViewer,
            studentId,
            applicationId: explicitApplicationId,
            phone: usablePhone,
            outcome: 'denied',
          });
          return null;
        }
      }

      // ТА ЖЕ РАЗВИЛКА, ЧТО В create(), И ЭТО ГЛАВНОЕ ЗДЕСЬ.
      //
      // Повторяем условие create() дословно, ОБЕ его половины:
      //   1) заявку назвали и на ней ЕСТЬ атрибуция → берём её, резолвер не
      //      зовём («явный выбор сильнее — среди заявок с атрибуцией»);
      //   2) не назвали ЛИБО названная без атрибуции → зовёт резолвер, и его
      //      находка, если она есть, побеждает.
      //
      // Взять только половину — значит развести превью с записью, а расхождение
      // здесь выражается прямо в деньгах.
      //   • Потерять шаг 1 (спрашивать один резолвер): он судит по правилу
      //     «старейшая атрибуция выигрывает» и на том же клиенте выбирает
      //     ДРУГУЮ заявку, чем пришла в адресе формы, — плашка называет
      //     партнёра P_old, а сделка запишет заявку партнёра P_new.
      //   • Потерять шаг 2 (`explicit ?? resolve`): заявка из адреса сплошь и
      //     рядом без атрибуции — клиент позвонил сам, лид завели руками, — и
      //     тогда create() всё равно уходит в резолвер и находит старый
      //     лендинговый лид того же телефона. Партнёру по сделке заплатят, а
      //     плашка промолчит: менеджер узнаёт о чужой комиссии из ниоткуда.
      //
      // Флаг «есть ли атрибуция» считает тот же applicationCarriesAttribution,
      // что и create(), — второй копии правила быть не должно.
      // В резолвер уходит usablePhone, а не сырой phone: инвариант «искать
      // можно только по ключу, прошедшему скоуп-гейт» должен читаться в
      // коде, а не выводиться из того, что резолвер разберёт номер заново.
      let sourceApplicationId: string | null = explicitApplicationId;
      if (
        !sourceApplicationId ||
        !(await this.applicationCarriesAttribution(sourceApplicationId))
      ) {
        const resolvedSourceApplicationId = await this.resolveSourceApplicationId({
          studentId,
          phone: usablePhone,
        });
        // Как в create(): пустой резолвер ничего не отбирает — названная
        // вызывающим заявка остаётся на месте.
        if (resolvedSourceApplicationId) {
          sourceApplicationId = resolvedSourceApplicationId;
        }
      }

      const view = await this.referrals.getPartnerAttributionView({
        studentId,
        applicationIds: [sourceApplicationId],
      });
      // След пишем ДО ветвления на null: промах — такая же проба, как
      // попадание, и именно из промахов складывается картина перебора.
      await this.logPartnerPreviewLookup({
        viewer: viewer as PreviewViewer,
        studentId,
        applicationId: explicitApplicationId,
        phone: usablePhone,
        outcome: view ? 'found' : 'not-found',
        referralCode: view?.referralCode ?? null,
      });
      if (!view) return null;

      // Сужение — не косметика: PartnerAttributionView содержит partnerId,
      // referralUrl, commissionId и дату начисления. Менеджеру они не нужны
      // и не должны утекать в сетевой ответ.
      return {
        fullName: view.fullName,
        referralCode: view.referralCode,
        commissionAmountCents: view.commissionAmountCents,
        commissionCurrency: view.commissionCurrency,
      };
    } catch (e: any) {
      // Превью информационное: форма не должна ломаться из-за него.
      this.logger.warn(`Превью партнёра не построено: ${e?.message || e}`);
      return null;
    }
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
    /** Показать только сделки клиентов, закреплённых за этим партнёром. */
    partnerId?: string;
    /** Кто спрашивает — от этого зависит, приложим ли партнёрский блок. */
    viewer?: { role?: string | null; roles?: string[] | null; hasCustomRole?: boolean } | null;
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

    // Фильтр по партнёру. Клиент у сделки может лежать в трёх разных полях
    // (студент, заявка, заявка-источник у сделки из вкладки «Новый»), поэтому
    // сначала спрашиваем у партнёрского сервиса идентификаторы его клиентов,
    // а потом ищем сделку по любому из полей.
    if (opts.partnerId) {
      if (!this.referrals) {
        // Партнёрский модуль недоступен — молча вернуть ВСЕ сделки было бы
        // хуже всего: пользователь выбрал партнёра и получил бы чужие сделки
        // как «его». Отдаём пусто.
        return [];
      }
      const { studentIds, applicationIds } = await this.referrals.getClientIdsForPartner(
        opts.partnerId,
      );
      if (studentIds.length === 0 && applicationIds.length === 0) return [];
      where.OR = [
        ...(studentIds.length ? [{ studentId: { in: studentIds } }] : []),
        ...(applicationIds.length
          ? [
              { applicationId: { in: applicationIds } },
              { sourceApplicationId: { in: applicationIds } },
            ]
          : []),
      ];
    }

    const rows = await this.prisma.saleSubmission.findMany({
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

    // Партнёрский блок в строках списка. Гейт тот же, что и в карточке, хотя
    // сам эндпоинт уже закрыт @Roles(FOUNDER, ADMIN) — дублируем осознанно:
    // если роли на эндпоинте когда-нибудь ослабят, партнёрские данные не
    // утекут молча вместе с этим послаблением.
    if (!this.referrals || !canSeePartnerAttribution(opts.viewer ?? null)) return rows;

    const refs = new Map<string, ReferralClientRef>();
    for (const r of rows) {
      refs.set(r.id, {
        studentId: r.studentId,
        applicationId: r.applicationId,
        applicationIds: [r.sourceApplicationId],
      });
    }
    const views = await this.referrals.getPartnerAttributionViewsBatch(refs);

    return rows.map((r) => ({ ...r, partnerAttribution: views.get(r.id) ?? null }));
  }

  /** FOUNDER: список платежей ожидающих одобрения. */
  async listPendingPayments(opts: {
    /** Показать только платежи клиентов, закреплённых за этим партнёром. */
    partnerId?: string;
    /** Кто спрашивает — от этого зависит, приложим ли партнёрский блок. */
    viewer?: UserWithRoles | null;
  } = {}) {
    const where: Prisma.SubmissionPaymentWhereInput = {
      status: SubmissionPaymentStatus.PENDING,
    };

    // Фильтр по партнёру — ровно тот же способ, что в listAll: клиент сделки
    // лежит в трёх разных полях (студент, заявка, заявка-источник), поэтому
    // сначала спрашиваем идентификаторы клиентов партнёра, потом матчим по
    // любому из полей. Разница только в том, что здесь сделка вложенная.
    if (opts.partnerId) {
      if (!this.referrals) {
        // Как и в listAll: молча отдать ВСЕ платежи было бы хуже всего —
        // пользователь выбрал партнёра и принял бы чужие платежи за его.
        return [];
      }
      const { studentIds, applicationIds } = await this.referrals.getClientIdsForPartner(
        opts.partnerId,
      );
      if (studentIds.length === 0 && applicationIds.length === 0) return [];
      where.submission = {
        OR: [
          ...(studentIds.length ? [{ studentId: { in: studentIds } }] : []),
          ...(applicationIds.length
            ? [
                { applicationId: { in: applicationIds } },
                { sourceApplicationId: { in: applicationIds } },
              ]
            : []),
        ],
      };
    }

    const rows = await this.prisma.submissionPayment.findMany({
      where,
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

    // Партнёрский блок. Гейт тот же канонический, что и в listAll/getOne,
    // хотя эндпоинт и так закрыт @Roles(FOUNDER, ADMIN) — дублируем осознанно
    // на случай будущего послабления ролей.
    if (!this.referrals || !canSeePartnerAttribution(opts.viewer ?? null)) return rows;

    // ПАКЕТНО, а не по строке. Ключ — id СДЕЛКИ, а не платежа: у одной сделки
    // в рассрочке несколько PENDING-платежей, и по всем них партнёр один и
    // тот же. Map по submissionId схлопывает их сам, поэтому лишних
    // идентичностей в батч не уходит.
    const refs = new Map<string, ReferralClientRef>();
    for (const r of rows) {
      if (!r.submission) continue;
      refs.set(r.submission.id, {
        studentId: r.submission.studentId,
        applicationId: r.submission.applicationId,
        applicationIds: [r.submission.sourceApplicationId],
      });
    }
    const views = await this.referrals.getPartnerAttributionViewsBatch(refs);

    return rows.map((r) =>
      r.submission
        ? {
            ...r,
            submission: {
              ...r.submission,
              partnerAttribution: views.get(r.submission.id) ?? null,
            },
          }
        : r,
    );
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
        // План рассрочки — часть карточки сделки, а не отдельный экран.
        // Отдаём здесь же, чтобы страница не делала второй запрос ради
        // блока, который видна сразу. Порядок — по order: он же
        // хронологический (сроки этапов возрастают вместе с номером).
        paymentStages: { orderBy: { order: 'asc' } },
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
      //
      // Audit fix (HIGH, Q5 — manager attribution): забираем managerId ТЕМ ЖЕ
      // запросом, что берёт lock. Это значение — крединг-менеджер платежа, оно
      // уходит в снапшот SubmissionPayment.creditedManagerId ниже и больше
      // никогда не переписывается. Читаем именно ЗДЕСЬ, а не из `submission`,
      // прочитанного до транзакции: снапшот обязан отражать владельца сделки
      // на момент одобрения, под тем же локом, что сериализует одобрения.
      // Fallback на pre-tx `submission.managerId` — только на случай, если raw
      // почему-то вернул пустой набор (строку удалили между read и tx; тогда
      // CAS ниже всё равно не пройдёт).
      const lockedRows = await tx.$queryRaw<Array<{ managerId: string | null }>>`
        SELECT "id", "managerId" FROM "SaleSubmission" WHERE id = ${submission.id} FOR UPDATE
      `;
      const creditedManagerId = lockedRows[0]?.managerId ?? submission.managerId ?? null;

      const claim = await tx.submissionPayment.updateMany({
        where: { id: paymentId, status: SubmissionPaymentStatus.PENDING },
        data: {
          status: SubmissionPaymentStatus.APPROVED,
          reviewedById: reviewerId,
          reviewedAt,
          // Снапшот атрибуции. Пишется в том же CAS-апдейте, что переводит
          // платёж в APPROVED, — значит «одобрен» и «кому засчитан» не могут
          // разъехаться даже при роллбэке части транзакции.
          creditedManagerId,
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
      // Bug (CRITICAL, audit — currency-mixing, финальный фикс): транзакция
      // пишется В ИСТИННОЙ ВАЛЮТЕ СДЕЛКИ. Это опция (b) из аудита.
      //
      // История. Первый заход писал `currency: submission.currency` —
      // и т.к. SaleSubmission.currency @default("USD"), а FinanceService
      // фильтрует все агрегаты по REPORTING_CURRENCY='TJS', контрактные
      // приходы молча выпадали из дашбордов. Второй заход «чинил» это,
      // подменяя валюту на 'TJS' при НЕТРОНУТОЙ сумме: USD 5000 ложились
      // в ledger строкой «5000 TJS», а настоящая валюта оставалась только
      // текстом в comment. Это было хуже исходной болезни:
      //   • finance/KPI видели сумму, заниженную примерно в курс раз (~11×
      //     для USD), и фильтр `currency='TJS'` переставал быть защитой —
      //     чужие деньги были помечены сомони ДО фильтра;
      //   • SalaryService при этом считает бонусную базу через
      //     relation `submission.currency` (всё ещё USD) и исключал тот же
      //     платёж целиком;
      //   • reversal-EXPENSE при отмене сделки копирует currency ИЗ
      //     Transaction, т.е. возврат уходил в TJS, а audit-log рядом
      //     (originalCurrencyForAudit) писал USD.
      // Одна сделка получала три разных ответа и ни одного правильного.
      //
      // Теперь: currency = валюта сделки как есть, amount = сумма как есть.
      // FX на write-time нет и придумывать курс из воздуха нельзя, поэтому
      // не-TJS деньги НЕ попадают в TJS-агрегаты — но и не теряются:
      // finance отдаёт их в `nonTjsTotals`, salary — в `nonTjsSales`
      // (обе ветки уже отрисованы в CRM). Итог: не-TJS сделка считается
      // ОДИН раз и ОДИНАКОВО во всех трёх модулях.
      //
      // Валюту берём БЕЗ нормализации (без trim/toUpperCase) — ровно то
      // значение, что лежит в SaleSubmission.currency. Это не небрежность:
      // salary фильтрует платежи relation-условием
      // `submission: { currency: 'TJS' }` (точное сравнение), и любая
      // нормализация здесь развела бы модули обратно — legacy-строка 'tjs'
      // стала бы 'TJS' в ledger (попала в TJS-выручку) и осталась 'tjs'
      // для зарплаты (выпала из бонусной базы). Ровно тот двойной счёт,
      // который этот фикс закрывает. Канонизация значения делается на
      // ЗАПИСИ сделки (create/update — trim + toUpperCase), а не здесь.
      //
      // Long-term (опция (a) из аудита): завести источник курса и колонки
      // originalAmount/originalCurrency/fxRate — тогда сюда встанет
      // `amount: payment.amount * rate, currency: REPORTING_CURRENCY` с
      // сохранением оригинала. До тех пор врать про валюту нельзя.
      const REPORTING_CURRENCY = 'TJS';
      const dealCurrency = submission.currency || REPORTING_CURRENCY;
      // Нормализованная копия — ТОЛЬКО для партнёрской комиссии и audit-лога
      // (ReferralsService сам делает toUpperCase над baseCurrency, и пост-коммитный
      // inline-путь ниже считает так же — см. originalCurrencyForAudit). В Transaction
      // это значение НЕ идёт: там нужен точный passthrough (см. выше).
      const originalCurrency = dealCurrency.toUpperCase();
      const finTxComment = `Платёж по сделке #${submission.id.slice(0, 8)} (${program.name})`;
      const finTx = await tx.transaction.create({
        data: {
          type: 'INCOME',
          category: 'TUITION_PAYMENT',
          amount: payment.amount,
          currency: dealCurrency,
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

      // РАССРОЧКА: гасим этапы, которые это одобрение покрывает.
      //
      // ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ этап становится PAID. Второго места, где кто-то
      // мог бы пометить этап оплаченным, в системе нет — ни ручной ручки в
      // CRM, ни отдельного эндпоинта: иначе «оплачено» и «деньги пришли»
      // разъехались бы, а разбирать пришлось бы бухгалтеру.
      //
      // Внутри ТОЙ ЖЕ транзакции — намеренно. Одобрение платежа и погашение
      // этапа это одно событие: коммит одного без другого оставил бы либо
      // деньги без закрытого этапа (клиент числится должником, хотя заплатил),
      // либо закрытый этап без денег. Pessimistic lock на SaleSubmission,
      // взятый в начале этой транзакции, заодно сериализует параллельные
      // одобрения по разным платежам одной сделки, так что кумулятивная сумма
      // внутри settleStagesTx всегда консистентна.
      //
      // Правило частичной оплаты (этап закрывается целиком или не закрывается,
      // излишек переходит на следующий этап) описано в док-комментарии
      // InstallmentsService.settleStagesTx.
      //
      // applicationId здесь — уже актуальный: на первом одобрении он присвоен
      // в ветке wonFirstApproval выше. Через него settleStagesTx снимает
      // Application.paymentPending, когда просрочек по сделке не осталось.
      await this.installments.settleStagesTx(tx, {
        submissionId: submission.id,
        applicationId: applicationId ?? null,
        paymentId,
        // Дата фактического прихода денег, а не момент одобрения: этап
        // погашен тогда, когда клиент заплатил.
        paidAt: payment.paidAt,
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
   *   5) прогоняем InstallmentsService.settleStagesTx — после (3) сумма
   *      APPROVED-платежей сделки равна нулю, поэтому проход снимает PAID
   *      со ВСЕХ этапов рассрочки (paidAt/paymentId → null, статус →
   *      PENDING/OVERDUE по сроку). Иначе этап остался бы «оплачен» ссылкой
   *      на только что отклонённый платёж;
   *   6) гасим Application.paymentPending: по расторгнутому договору долга
   *      нет, а суточный cron просрочки трогает только ACTIVE-сделки и снять
   *      флаг уже никогда бы не смог (студент навсегда в должниках).
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

    // COMPLETED — реверсить нечего (деньги остаются в выручке), но ДОЛГ
    // обязан пересчитаться. Раньше здесь стоял голый update статуса, и сделка,
    // закрытая с уже поднятым Application.paymentPending, оставляла его
    // поднятым НАВСЕГДА: пересчитать было больше некому — settleStagesTx
    // зовётся только там, где меняется сумма одобренных платежей, а суточный
    // sweepOverdueStages джойнит `s.status = ACTIVE` (по закрытому контракту
    // уведомлять незачем) и умеет только ПОДНИМАТЬ флаг. Клиент навсегда
    // оставался в «Студентах с задолженностью» на дашборде и в «Задолженности
    // студентов» в финансах (FinanceService.pendingPayments), и снять это мог
    // только ручной PATCH /applications/:id.
    //
    // Пересчёт идёт ОТ СОСТОЯНИЯ ПЛАНА, а не по принципу «закрыли — значит не
    // должен»: если менеджер закрывает контракт с непогашенной просрочкой,
    // долг реальный и флаг обязан остаться. Гасит его только фактическое
    // отсутствие OVERDUE-этапов. Сделку без плана рассрочки вызов не трогает
    // вовсе — там флаг целиком за менеджером (см.
    // InstallmentsService.syncPaymentPendingForSubmissionTx).
    //
    // В ОДНОЙ транзакции со сменой статуса: закрытая сделка с несогласованным
    // признаком должника — ровно то расхождение, которое этот блок убирает.
    if (status === SubmissionStatus.COMPLETED) {
      return this.prisma.$transaction(async (tx) => {
        const row = await tx.saleSubmission.update({
          where: { id: submissionId },
          data: { status },
        });
        await this.installments.syncPaymentPendingForSubmissionTx(tx, {
          submissionId,
          applicationId: submission.applicationId,
        });
        return row;
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

      // (5) РАССРОЧКА: этапы обязаны последовать за деньгами. Каждый
      //     APPROVED-платёж выше стал REJECTED, значит кумулятивная сумма
      //     одобренного по сделке теперь 0 — и тот же state-based проход,
      //     который гасит этапы при одобрении, здесь снимает PAID со ВСЕХ:
      //     status → PENDING/OVERDUE (по сроку), paidAt → null, paymentId →
      //     null. Без этого вызова этап остался бы PAID со ссылкой на
      //     платёж, который мы только что отклонили и по которому выписан
      //     возврат: CRM (installments listForSubmission) рисовала бы
      //     «оплачено» по отменённой сделке, а бухгалтер не свёл бы кассу.
      //     Нового правила не вводим — правило одно: «этап оплачен тогда и
      //     только тогда, когда сумма APPROVED-платежей его покрывает»
      //     (см. InstallmentsService.settleStagesTx), просто здесь оно
      //     применяется после реверса.
      //
      //     Внутри ТОЙ ЖЕ транзакции, что и реверс денег: коммит одного без
      //     другого — это ровно то расхождение, которое фикс и закрывает.
      const settlement = await this.installments.settleStagesTx(tx, {
        submissionId,
        applicationId: submission.applicationId,
        // Закрывать этапы нечем — одобренных платежей по сделке не осталось.
        paymentId: null,
        paidAt: reversedAt,
      });

      // (6) Долг по отменённому контракту — не долг. settleStagesTx выставил
      //     paymentPending по overdueLeft, а он после реверса почти всегда
      //     > 0: этапы с прошедшим сроком вернулись в OVERDUE. Для ЖИВОЙ
      //     сделки это верно, для отменённой — нет: платить по расторгнутому
      //     договору нечего, а снять флаг больше некому. Суточный cron
      //     просрочки джойнит `s.status = ACTIVE` (намеренно — иначе слал бы
      //     менеджеру вечные уведомления по несуществующей сделке), значит
      //     студент завис бы в FinanceService.pendingPayments и в блоке
      //     должников НАВСЕГДА. Поэтому гасим флаг явно, последним шагом —
      //     после settleStagesTx, а не вместо него.
      //
      //     Только при hasStages: у сделки без плана рассрочки paymentPending
      //     целиком за менеджером (он ставит его руками для долгов, к
      //     рассрочке отношения не имеющих), и стирать эту пометку отменой
      //     сделки нельзя — тот же инвариант, что у syncPaymentPendingTx.
      //     Второго флага-должника не заводим: reuse paymentPending.
      //
      //     Скоуп безопасен: SaleSubmission.applicationId — @unique, то есть
      //     заявка принадлежит ровно одной сделке, и снятый здесь флаг не
      //     может погасить долг чужой (активной) сделки того же студента.
      if (settlement.hasStages && submission.applicationId) {
        // updateMany, а не update: заявку могли удалить между чтением сделки
        // и этим шагом, и P2025 уронил бы всю отмену.
        await tx.application.updateMany({
          where: { id: submission.applicationId, paymentPending: true },
          data: { paymentPending: false },
        });
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
   *
   * ПРИЗНАК ДОЛЖНИКА СНИМАЕМ ДО УДАЛЕНИЯ. PaymentStage уходит каскадом вместе
   * со сделкой, а Application остаётся (SetNull) — и оставался с
   * paymentPending = true, при том что ни одного этапа, который бы это
   * объяснял, в базе уже нет: должник-фантом в FinanceService.pendingPayments
   * навсегда (пересчитывать нечего — settleStagesTx зовут только денежные
   * пути, а sweepOverdueStages джойнит `s.status = ACTIVE` и только поднимает
   * флаг). ПОСЛЕ delete посчитать уже нельзя, поэтому пересчёт — первый шаг
   * той же транзакции: упадёт удаление — снятый флаг откатится вместе с ним.
   */
  async remove(submissionId: string) {
    const submission = await this.prisma.saleSubmission.findUnique({
      where: { id: submissionId },
      // applicationId — чтобы снять признак должника до каскадного удаления
      // этапов рассрочки (см. док-комментарий выше).
      select: { id: true, applicationId: true },
    });
    if (!submission) throw new NotFoundException('Сделка не найдена');
    await this.prisma.$transaction(async (tx) => {
      // settled: true — удалённая сделка долга не порождает: плана больше не
      // существует, платить не по чему. Заявку сделки БЕЗ этапов вызов не
      // трогает — ручную пометку менеджера удаление сделки стирать не должно.
      await this.installments.syncPaymentPendingForSubmissionTx(tx, {
        submissionId,
        applicationId: submission.applicationId,
        settled: true,
      });
      await tx.saleSubmission.delete({ where: { id: submissionId } });
    });
    this.realtime.emitStaff('submission:deleted', { submissionId });
    return { ok: true };
  }

  /**
   * FOUNDER редактирует сделку. Всегда можно менять контракт-файлы,
   * totalAmount, currency, notes. Поля, привязанные к уже созданному
   * Student/Application (studentId, newStudent*, programId), становятся
   * "замороженными" после firstApprovedAt — если фронт всё же прислал
   * их, silently ignore (не бросаем 400, чтобы не ломать UI).
   * ОБЁРТКА В $transaction ОБЯЗАТЕЛЬНА, хотя update и одиночный: смена
   * totalAmount у сделки с рассрочкой обязана в том же коммите пересобрать
   * PaymentStage. Инвариант плана — sum(PaymentStage.amount) ==
   * SaleSubmission.totalAmount ТОЧНО (schema.prisma, «INSTALLMENT PLANS»), и
   * раньше эта правка его молча ломала: строки этапов оставались от прежней
   * цены. Оба направления расхождения денежно неверны — план БОЛЬШЕ
   * контракта даёт этап, который не закрывается никогда (вечная просрочка и
   * ежедневное уведомление менеджеру при том, что финансы по тому же
   * totalAmount уже показывают FULL), план МЕНЬШЕ контракта гасит все этапы
   * и стирает реальный долг с дашборда. Разбор и правила пересборки — в
   * InstallmentsService.reallocateOnTotalChangeTx.
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
      select: {
        id: true,
        firstApprovedAt: true,
        managerId: true,
        studentId: true,
        // Нужны для пересборки плана рассрочки при смене суммы контракта:
        // totalAmount — чтобы понять, сдвинулась ли она вообще, currency —
        // для сообщений об отказе, applicationId — чтобы settleStagesTx внутри
        // пересборки синхронизировал Application.paymentPending.
        totalAmount: true,
        currency: true,
        applicationId: true,
      },
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
    // ВАЛЮТА. Нормализуем и проверяем по whitelist'у (audit Q7) — и
    // ЗАМОРАЖИВАЕМ после первого одобрения. Валюта сделки — факт о
    // подписанных деньгах, а не редактируемая подпись: по ней (через
    // relation, своей колонки у SubmissionPayment нет) SalaryService
    // отбирает платежи в бонусную базу месяца. Смена USD→TJS на старой
    // сделке задним числом вбросила бы ВСЕ её ранее одобренные платежи в
    // базу того прошлого месяца (вплоть до смены полосы у уже ВЫПЛАЧЕННОГО
    // SalaryRecord), а TJS→USD — так же тихо их оттуда вынесла бы.
    // Поэтому окно правки — ровно до firstApprovedAt: пока он null,
    // одобренных платежей у сделки нет и переписывать нечего.
    //
    // Присланное значение, совпадающее с текущим, не ошибка, а норма:
    // фронтовая EditSubmissionModal у FOUNDER'а шлёт currency в каждом
    // payload'е (в т.ч. при правке одних notes). Такой no-op молча
    // пропускаем — 400 ловила бы правка, которая ничего не меняет.
    // Реальная попытка сменить валюту после одобрения — громкий 400.
    if (dto.currency !== undefined) {
      const nextCurrency = normalizeSubmissionCurrency(dto.currency);
      // Текущее значение канонизируем БЕЗ whitelist-проверки: у легаси-строки
      // в БД ('usd', мусор) валидация бросила бы 400 на любую правку сделки,
      // включая правку одних notes. Здесь нужно лишь «то же самое или нет».
      const currentCurrency = String(submission.currency || DEFAULT_SUBMISSION_CURRENCY)
        .trim()
        .toUpperCase();
      if (nextCurrency !== currentCurrency) {
        if (submission.firstApprovedAt) {
          throw new BadRequestException(
            'Валюту сделки нельзя изменить после первого одобрения платежа — ' +
              'это переписало бы бонусную базу закрытых месяцев. ' +
              'Отмените сделку и заведите новую в нужной валюте.',
          );
        }
        data.currency = nextCurrency;
      }
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

    // Сдвинулась ли сумма контракта. Сравниваем в центах по той же причине,
    // по которой план считается в центах: 5000 и 5000.000000001 — это одна и
    // та же цена, и пересобирать под неё план незачем.
    const totalChanged =
      data.totalAmount !== undefined &&
      Math.round(data.totalAmount * 100) !== Math.round(submission.totalAmount * 100);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (totalChanged) {
        // Тот же pessimistic lock, что берёт approvePayment, и по той же
        // причине: пока мы переписываем цену и план, параллельное одобрение
        // платежа не должно считать покрытие этапов по суммам, которые прямо
        // сейчас меняются.
        await tx.$queryRaw`SELECT id FROM "SaleSubmission" WHERE id = ${submissionId} FOR UPDATE`;
      }

      const row = await tx.saleSubmission.update({
        where: { id: submissionId },
        data,
        include: {
          program: { select: { id: true, name: true, university: true } },
          student: { select: { id: true, fullName: true } },
          manager: { select: { id: true, fullName: true, role: true } },
          payments: { orderBy: { paidAt: 'desc' } },
        },
      });

      if (totalChanged) {
        // Пересборка ПОСЛЕ записи новой цены: план строится от неё, и обе
        // записи уезжают одним коммитом. Если пересобирать нечем (все этапы
        // оплачены; новая сумма не покрывает оплаченное) — внутри летит 400 с
        // цифрами, и правка суммы откатывается целиком вместе с ним.
        await this.installments.reallocateOnTotalChangeTx(tx, {
          submissionId,
          applicationId: submission.applicationId,
          newTotal: row.totalAmount,
          currency: row.currency,
        });
      }
      return row;
    });
    this.realtime.emitStaff('submission:updated', { submissionId });
    return updated;
  }

  /**
   * Редактирование платежа.
   * - FOUNDER — любой платёж (PENDING/APPROVED, REJECTED нельзя).
   *   APPROVED: связанная Transaction обновляется атомарно в $transaction.
   *   Правка amount дополнительно пересчитывает этапы рассрочки в ТОЙ ЖЕ
   *   транзакции (settleStagesTx) — сумма платежа входит в базу покрытия,
   *   и коммит новой цифры без пересчёта оставлял бы план рассинхронным с
   *   деньгами в обе стороны. Подробности — у самого вызова ниже.
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
        submission: {
          select: {
            id: true,
            currency: true,
            managerId: true,
            // Нужен для пересчёта этапов рассрочки после правки суммы —
            // через него settleStagesTx снимает/поднимает
            // Application.paymentPending (см. блок ниже).
            applicationId: true,
          },
        },
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

    // РАССРОЧКА: правка СУММЫ меняет кумулятивную базу, от которой
    // settleStagesTx считает покрытие этапов, поэтому пересчёт обязателен.
    //
    // Без него редактирование суммы было ЕДИНСТВЕННОЙ денежной операцией,
    // которая не приводила план в соответствие с деньгами, и расхождение
    // жило до следующего постороннего approve/delete:
    //   - уменьшили сумму (10000 → 4000 на плане 5000+5000) — этап №1 больше
    //     не покрыт, но остаётся PAID с paidAt/paymentId. Это ровно тот
    //     случай, ради которого пересчёт добавлен в deletePayment: «деньги
    //     вернули, а этап числится оплаченным». Клиент пропадает из
    //     должников, суточный cron PAID-строку не трогает, и
    //     Application.paymentPending больше никогда не поднимется;
    //   - увеличили сумму — новопокрытые этапы не гасятся, клиент остаётся
    //     должником, cron переводит их в OVERDUE и дёргает менеджера по
    //     уже оплаченному долгу.
    //
    // Пересчёт нужен и когда платёж ещё PENDING: сам он в сумму APPROVED не
    // входит, но settleStagesTx — функция от состояния и идемпотентна,
    // поэтому этот же вызов заодно вычищает расхождение, оставшееся с
    // прошлых правок. Второго правила не появляется: правило одно —
    // «этап оплачен тогда и только тогда, когда сумма APPROVED-платежей его
    // покрывает».
    const needSettleStages = data.amount !== undefined;

    if (needSyncFinance || needSettleStages) {
      const updated = await this.prisma.$transaction(async (tx) => {
        // Тот же pessimistic lock и в том же порядке, что берёт
        // approvePayment (Bug #26): пока мы правим сумму, параллельное
        // одобрение по другому платежу этой сделки ждёт на SELECT FOR UPDATE
        // — иначе оба посчитали бы кумулятивную сумму по своему снимку и
        // разъехались бы в статусах этапов. Единый порядок захвата
        // (SaleSubmission первым) исключает взаимную блокировку.
        await tx.$queryRaw`SELECT id FROM "SaleSubmission" WHERE id = ${payment.submissionId} FOR UPDATE`;

        if (needSyncFinance) {
          const financeUpdate: any = {};
          if (data.amount !== undefined) financeUpdate.amount = data.amount;
          if (data.paidAt !== undefined) financeUpdate.date = data.paidAt;
          await tx.transaction.update({
            where: { id: payment.financeTransactionId! },
            data: financeUpdate,
          });
        }

        const row = await tx.submissionPayment.update({
          where: { id: paymentId },
          data,
        });

        if (needSettleStages) {
          // ПОСЛЕ апдейта платежа — settleStagesTx читает сумму из ЭТОЙ же
          // транзакции и обязан увидеть уже новую цифру.
          await this.installments.settleStagesTx(tx, {
            submissionId: payment.submissionId,
            applicationId: payment.submission.applicationId,
            // Атрибутируем новопокрытые этапы этому платежу только если он
            // APPROVED — то есть реально входит в кумулятивную сумму. Для
            // PENDING передаём null: закрывать этапы ему нечем, и подписать
            // чужой этап его id значило бы соврать в карточке.
            // При УМЕНЬШЕНИИ суммы поле не используется вовсе: сумма только
            // падает, новопокрытых этапов не появляется, а снятые с PAID
            // очищают paymentId сами.
            paymentId:
              payment.status === SubmissionPaymentStatus.APPROVED ? paymentId : null,
            // Дата фактического прихода денег (уже с учётом правки paidAt),
            // а не момент редактирования — как в approvePayment.
            paidAt: row.paidAt,
          });
        }

        return row;
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
            // Нужен для пересчёта этапов рассрочки после удаления платежа —
            // через него снимается/поднимается Application.paymentPending.
            applicationId: true,
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

      // РАССРОЧКА: пересчитываем этапы под уменьшившуюся сумму одобренного.
      //
      // FK PaymentStage.paymentId стоит на SetNull, поэтому удаление платежа
      // само по себе лишь обнуляет ссылку — статус остался бы PAID. То есть
      // деньги вернули, а этап числится оплаченным: клиент пропал из
      // должников дашборда, и просрочка по нему больше никогда не всплывёт.
      // settleStagesTx считает покрытие от состояния (кумулятивная сумма
      // APPROVED-платежей), поэтому тот же вызов, что гасит этапы при
      // одобрении, здесь возвращает непокрытые обратно в PENDING/OVERDUE и
      // поднимает Application.paymentPending. Нового правила не вводим —
      // правило одно, просто применяется после удаления.
      //
      // Внутри ТОЙ ЖЕ транзакции: пересчёт без удаления (или наоборот) —
      // это ровно то расхождение, которое он призван не допустить.
      await this.installments.settleStagesTx(tx, {
        submissionId,
        applicationId: payment.submission.applicationId,
        // Платежа больше нет — закрывать этапы нечем. Те, что останутся PAID,
        // свой paymentId уже носят и здесь не переписываются.
        paymentId: null,
        paidAt: reversedAt,
      });
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
