import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  IncomeSource,
  PaymentChannel,
  PaymentKind,
  PaymentPhaseStatus,
  ProductCategory,
  ReceiptKind,
  TransactionCategory,
  TransactionType,
} from '@prisma/client';
import { MANAGER_ROLES, hasRole } from '../auth/role-utils';
import { tjLocalDay, tjYMD } from '../common/tj-time';
import { RevenueSchemeService } from '../revenue-scheme/revenue-scheme.service';

/**
 * Actor context for create(): id + флаг elevated. Elevated (FOUNDER/ADMIN/
 * ACCOUNTANT) могут ставить любой managerId; менеджеры (SALES_MANAGER/
 * CLIENT_MANAGER) — только self-attribute. Флаг считает вызывающий
 * (controller через isElevated(me)) — сервису не нужно знать про AuthUser.
 *
 * `role` — опционально: если передан, попадает в ActivityLog.actorRole,
 * чтобы FOUNDER мог фильтровать /activity по роли ("покажи все
 * FINANCE_CREATE от SALES_MANAGER"). Не required — внутренние вызывающие
 * (chat/ai) могут не знать роль; в этом случае пишем 'SYSTEM'.
 */
export type FinanceActor = { id: string; isElevated: boolean; role?: string };

/**
 * Окно, в пределах которого рядовой менеджер может ставить дату
 * транзакции. Elevated (FOUNDER/ADMIN/ACCOUNTANT) окно не ограничивает —
 * им нужно вносить исторические записи задним числом (закрытие месяца,
 * восстановление пропущенных платежей).
 *
 * Зачем (audit HIGH): без границы менеджер мог поставить
 * `date: '2025-01-15'` внутрь текущего окна премии, даже если реальная
 * оплата пришла раньше/позже — и тем самым «переносить» доход между
 * периодами, чтобы попасть в бонусный порог. summary / topManagers /
 * breakdown / timeseries фильтруют строго по `date`, так что это ломало
 * любые period-based начисления. Отдельно душим «дату в будущем» для
 * INCOME — записать доход раньше, чем он реально пришёл, легитимного
 * сценария нет даже для бухгалтера.
 */
const MANAGER_DATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // ±3 суток
const DATE_CLOCK_SKEW_MS = 60_000; // 1 минута — запас на дрейф часов

/**
 * Проверяет `dto.date` / `patch.date` на разумные границы. Бросает 400 при:
 *  - невалидной строке (NaN);
 *  - дате в будущем, если transactionType=INCOME (даже elevated нельзя);
 *  - для non-elevated caller — дате вне окна today ± 3 суток.
 * Если dateStr пуст — no-op: сервис подставит `new Date()` дальше.
 * Если caller не передан — считаем elevated (внутренние вызывающие
 * chat/ai уже проверяют роль до вызова; окно к ним не применимо).
 */
function validateTransactionDate(
  dateStr: string | undefined | null,
  transactionType: TransactionType | null | undefined,
  caller: FinanceActor | null | undefined,
): void {
  if (!dateStr) return;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('Некорректная дата');
  }
  const now = Date.now();
  const ts = d.getTime();
  // INCOME в будущем — блок для всех, включая elevated. Небольшой запас
  // на расхождение часов между фронтом и бэком, иначе клик «сегодня»
  // ловил бы 400 при часах фронта, слегка убегающих вперёд.
  if (transactionType === 'INCOME' && ts > now + DATE_CLOCK_SKEW_MS) {
    throw new BadRequestException('Дата INCOME не может быть в будущем');
  }
  // Elevated (FOUNDER/ADMIN/ACCOUNTANT) — окно не ограничиваем.
  // Отсутствующий caller (внутренние вызовы chat/ai) — тоже считаем
  // elevated: они уже валидируют роль до create().
  if (!caller || caller.isElevated) return;
  if (ts > now + MANAGER_DATE_WINDOW_MS + DATE_CLOCK_SKEW_MS) {
    throw new BadRequestException(
      'Дата не может быть больше чем на 3 дня в будущем. Для внесения задним числом обратись к бухгалтеру.',
    );
  }
  if (ts < now - MANAGER_DATE_WINDOW_MS - DATE_CLOCK_SKEW_MS) {
    throw new BadRequestException(
      'Дата не может быть старше 3 дней. Для внесения задним числом обратись к бухгалтеру.',
    );
  }
}

export interface CreateTransactionDto {
  type: TransactionType;
  category: TransactionCategory;
  amount: number;
  currency?: string;
  comment?: string;
  date?: string; // ISO
  studentId?: string | null;
  managerId?: string | null;
  // расширения
  paymentChannel?: PaymentChannel | null;
  paymentKind?: PaymentKind | null;
  productCategory?: string | null;
  payerName?: string | null;
  receiptUrl?: string | null;
  receiptKind?: ReceiptKind | null;
  noReceiptReason?: string | null;
  // === Google Sheet parity — новые поля ===
  incomeSource?: IncomeSource | null;
  productCategoryEnum?: ProductCategory | null;
  paymentPhase?: PaymentPhaseStatus | null;
  paidViaId?: string | null;
}

// Валидация значения против enum-объекта, экспортируемого prisma-client-js
// (в рантайме это `{ NEW_CLIENT: 'NEW_CLIENT', ... }`). Возвращает
// нормализованное значение или бросает BadRequestException. Раньше мы
// клали `dto.incomeSource` в Prisma «как есть» — если фронт пришлёт
// `"new_client"` (lowercase) или опечатку, Prisma бросала 500. Теперь
// это 400 с понятным сообщением.
function validateEnum<T extends Record<string, string>>(
  enumObj: T,
  value: unknown,
  field: string,
): T[keyof T] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const allowed = Object.values(enumObj) as string[];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new BadRequestException(
      `${field}: должно быть одно из [${allowed.join(', ')}]`,
    );
  }
  return value as T[keyof T];
}

// === Sync-мостик между legacy `productCategory` (String) и `productCategoryEnum`
// (ProductCategory). Аудит HIGH: оба поля писались независимо из одного DTO.
// Если новый UI слал только enum — legacy String оставался null, а
// `incomeByProduct()` группирует именно по legacy String → все записи
// нового формата тихо схлопывались в «Без категории». Обратный дрейф —
// когда старый клиент шлёт только String — ломает любые аналитики по enum.
//
// Канонический источник — `productCategoryEnum` (см. комментарий в
// schema.prisma). На запись делаем двусторонний mirror, чтобы старые
// ридеры не сломались:
//  * enum задан → пишем метку в legacy String;
//  * задан только legacy String, совпадающий с меткой → пишем enum.
// Метки должны совпадать с фронтом (frontend-crm/src/api/finance.ts:
// PRODUCT_CATEGORY_LABEL) — при добавлении варианта enum правь оба места.
const PRODUCT_CATEGORY_LABEL: Record<ProductCategory, string> = {
  CONTRACT: 'Контракт',
  MASTERCLASS: 'Мастер-класс',
  ACADEMY: 'Академия',
  OTHER: 'Другое',
};

// Обратный маппинг метки → enum (case-insensitive). Собирается один раз
// в модуль-скоуп, т.к. набор меток статичен.
const LABEL_TO_PRODUCT_CATEGORY: Record<string, ProductCategory> = Object.entries(
  PRODUCT_CATEGORY_LABEL,
).reduce<Record<string, ProductCategory>>((acc, [key, label]) => {
  acc[label.toLowerCase()] = key as ProductCategory;
  return acc;
}, {});

function labelForProductCategory(pc: ProductCategory | null | undefined): string | null {
  if (!pc) return null;
  return PRODUCT_CATEGORY_LABEL[pc] ?? null;
}

function enumForProductCategoryLabel(
  label: string | null | undefined,
): ProductCategory | null {
  if (!label) return null;
  return LABEL_TO_PRODUCT_CATEGORY[label.trim().toLowerCase()] ?? null;
}

// === Единая отчётная валюта ===
// Все агрегаты (summary/breakdown/distribution/topManagers/incomeSources/
// incomeByProduct/byCategory/timeseries) считались `_sum: { amount: true }`
// БЕЗ фильтра по валюте — а `create()` пропускает 5 валют
// (TJS/USD/EUR/CNY/RUB, whitelist в create()). Итог: USD 5000 за
// обучение складывался с TJS-ами как безразмерное число, и фронт
// показывал результат как «сомони». Пропорции пирогов теряли смысл
// при первой же не-TJS транзакции в периоде.
//
// Fix (audit): фильтруем все агрегаты по TJS (основная отчётная валюта),
// а «отброшенные» не-TJS суммы возвращаем отдельным полем `nonTjsTotals`,
// чтобы бухгалтер видел, что валютная активность в периоде была, и мог
// её обработать вручную. Это опция (b) из аудита — минимальный blast
// radius: фронт продолжает работать со старыми формами данных.
const REPORTING_CURRENCY = 'TJS';

// Тип буфера «не-TJS» сумм на период (для admin-панели: «в этом периоде
// была ещё выручка в USD/EUR/CNY/RUB — обработайте отдельно»).
export interface NonTjsBucket {
  income: number;
  expense: number;
  incomeCount: number;
  expenseCount: number;
}
export type NonTjsTotals = Record<string, NonTjsBucket>;

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);
  constructor(
    private prisma: PrismaService,
    // RealtimeGateway — для WS-нотификаций staff-комнате после
    // create/update/remove. Без этого /finance у другого пользователя
    // (FOUNDER + ACCOUNTANT в month-close параллельно) остаётся stale
    // до ручного refetch: `submission:*`/`payment:*` события идут в
    // свои страницы, а Finance UI им не подписан. См. FinanceModule.
    private realtime: RealtimeGateway,
    // ActivityService — аудит транзакций. Без записи в ActivityLog каждая
    // INCOME/EXPENSE молча уходит в БД, а FOUNDER на /activity видит только
    // движение по заявкам и документам. См. audit HIGH — «POST
    // /finance/transactions writes no ActivityLog». Логируем best-effort:
    // .catch(() => undefined), чтобы падение аудита не откатило запись
    // транзакции (пользователь бы дважды кликнул «Сохранить» и получил
    // две строки в БД). Тот же pattern использует applications.service.
    private activity: ActivityService,
    // NotificationsService — @Optional, потому что внутренние тесты /
    // chat/ai могут пойти без модуля. Используется для оповещения staff
    // о переприписке менеджера-получателя на транзакции (audit CRITICAL:
    // без этого «проигравший» менеджер узнаёт о потере бонуса только по
    // квитку зарплаты). Тот же pattern (notifyAllStaff) в applications.
    @Optional() private notifications?: NotificationsService,
    // RevenueSchemeService — источник активной схемы распределения для
    // distribution(). Инжектим необязательно только чтобы старые unit-тесты
    // FinanceService (создающиеся без RevenueSchemeModule) не падали при
    // построении инстанса; в проде модуль всегда есть — см. FinanceModule.
    @Optional() private revenueScheme?: RevenueSchemeService,
  ) {}

  /**
   * Форматирует сумму + валюту + категорию для details ActivityLog —
   * компактно и достаточно для быстрого узнавания в /activity без
   * открытия payload. Отдельная функция, чтобы create/update/remove
   * форматировали одинаково.
   */
  private formatTxDetails(tx: {
    type: TransactionType;
    amount: number;
    currency: string;
    category: TransactionCategory;
  }): string {
    return `${tx.type} ${tx.amount} ${tx.currency} (${tx.category})`;
  }

  /**
   * Считает суммы по не-TJS валютам за период. Возвращает {USD:{income,
   * expense,...}, EUR:{...}, ...}. Пустой объект означает, что весь
   * период был чисто в сомони — фронт может ничего дополнительно не
   * показывать. См. комментарий про REPORTING_CURRENCY выше.
   */
  private async nonTjsTotals(where: any): Promise<NonTjsTotals> {
    const grouped = await this.prisma.transaction.groupBy({
      by: ['type', 'currency'],
      where: { ...where, currency: { not: REPORTING_CURRENCY } },
      _sum: { amount: true },
      _count: true,
    });
    const map: NonTjsTotals = {};
    for (const g of grouped) {
      const cur = g.currency || 'UNKNOWN';
      if (!map[cur]) {
        map[cur] = { income: 0, expense: 0, incomeCount: 0, expenseCount: 0 };
      }
      if (g.type === 'INCOME') {
        map[cur].income = g._sum.amount || 0;
        map[cur].incomeCount = g._count;
      } else {
        map[cur].expense = g._sum.amount || 0;
        map[cur].expenseCount = g._count;
      }
    }
    return map;
  }

  async list(filters: {
    type?: TransactionType;
    category?: TransactionCategory;
    studentId?: string;
    managerId?: string;
    from?: Date;
    to?: Date;
    take?: number;
  }) {
    return this.prisma.transaction.findMany({
      where: {
        ...(filters.type && { type: filters.type }),
        ...(filters.category && { category: filters.category }),
        ...(filters.studentId && { studentId: filters.studentId }),
        ...(filters.managerId && { managerId: filters.managerId }),
        ...(filters.from || filters.to
          ? { date: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }
          : {}),
      },
      orderBy: { date: 'desc' },
      take: filters.take ?? 200,
      include: {
        student: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true, role: true } },
        recordedBy: { select: { id: true, fullName: true, role: true } },
      },
    });
  }

  async create(
    dto: CreateTransactionDto,
    recordedById: string,
    // caller — контекст роли вызывающего для проверки владения студентом
    // и атрибуции менеджерского бонуса. Default: elevated=true — сохраняем
    // обратную совместимость для внутренних вызывающих (chat/ai), которые
    // уже сами проверяют роль перед вызовом. Публичный HTTP-эндпоинт
    // (finance.controller) ОБЯЗАН передавать реальный isElevated(me),
    // иначе non-elevated менеджеры смогут писать транзакции с чужим
    // managerId (bonus inflation) или по чужим студентам (искажение
    // статистики).
    caller: FinanceActor = { id: recordedById, isElevated: true },
  ) {
    const callerIsElevated = caller.isElevated;
    if (!dto.amount || dto.amount <= 0) {
      throw new BadRequestException('Сумма должна быть больше 0');
    }
    if (dto.amount > 1_000_000) {
      throw new BadRequestException('Сумма слишком большая');
    }
    // Currency whitelist. Раньше принимали любую строку — а Salary engine
    // потом суммирует разные валюты как одну: «TJS_OLD»/«tjs»/typo
    // ломают финансовые отчёты молча.
    const VALID_CURRENCIES = new Set(['TJS', 'USD', 'EUR', 'CNY', 'RUB']);
    if (dto.currency) {
      const c = dto.currency.toUpperCase();
      if (!VALID_CURRENCIES.has(c)) {
        throw new BadRequestException(`currency должен быть один из: ${[...VALID_CURRENCIES].join(', ')}`);
      }
      dto.currency = c;
    }
    // === Invariant: TUITION_PAYMENT принадлежит только SubmissionPayment-потоку.
    // Аудит HIGH (Finance vs Salary divergence): finance.breakdown группирует
    // Transaction «как есть», а salary.preview суммирует SubmissionPayment
    // (APPROVED) + Transaction (INCOME с category != TUITION_PAYMENT). Если
    // сюда пропустить ручную транзакцию с category=TUITION_PAYMENT (legacy-
    // импорт, «фикс пропущенного платежа», AI-чат «студент оплатил ...»),
    // то Finance учтёт её в бонусной атрибуции менеджера, а Salary — нет:
    // manualSalesAgg исключит по фильтру category, submissionSalesAgg не
    // увидит (SubmissionPayment-строки для неё не существует). Итог —
    // менеджер видит доход в /finance breakdown, но не получает бонус.
    //
    // Canonical writer'ы TUITION_PAYMENT-строк — `submissions.service.ts::
    // approvePayment` и `payments.service.ts::approvePayment` (оба идут в
    // prisma.transaction.create напрямую, в рамках $transaction с
    // SubmissionPayment, минуя этот сервис). Публичные точки входа (HTTP
    // POST /finance/transactions и chat-AI парсер, оба идут через
    // this.create) обязаны использовать SubmissionPayment-поток, а не
    // писать TUITION_PAYMENT вручную.
    //
    // Блок применим ко ВСЕМ caller'ам, включая elevated (FOUNDER/ADMIN/
    // ACCOUNTANT). Легитимный исторический импорт делается напрямую через
    // prisma в миграции/скрипте, а не через API. См. salary.service.ts
    // (комментарий про manualSalesAgg) — там ссылка на этот инвариант.
    if (dto.category === 'TUITION_PAYMENT') {
      throw new BadRequestException(
        'Категория TUITION_PAYMENT зарезервирована для подтверждения платежей по сделкам ' +
        '(SubmissionPayment → approvePayment). Оформи оплату через заявку/сделку, ' +
        'иначе бонус менеджера не начислится (финансовая сводка учтёт, а зарплата — нет).',
      );
    }
    // Date validation. Помимо базовой проверки NaN (иначе Prisma бросал бы
    // 500 на write) — bounds: не-elevated caller ограничен окном today±3
    // суток, а INCOME в будущем блочим для всех. См. audit HIGH
    // (validateTransactionDate) — без границ менеджер мог «переносить»
    // доход между bonus-периодами, ставя произвольную дату.
    validateTransactionDate(dto.date, dto.type, caller);
    // Text fields — length caps + HTML guard. Все попадают на админскую
    // финансовую страницу, рендерятся в строках таблицы. Раньше
    // принимались raw, что давало stored XSS surface (React JSX
    // эскейпит, но Telegram html-mode уведомления нет).
    const checkText = (val: string | undefined | null, field: string, maxLen: number) => {
      if (val === undefined || val === null) return;
      if (val.length > maxLen) throw new BadRequestException(`${field}: макс. ${maxLen} символов`);
      if (/[<>]/.test(val)) throw new BadRequestException(`${field}: HTML-теги запрещены`);
    };
    checkText(dto.comment, 'comment', 1000);
    checkText(dto.productCategory, 'productCategory', 100);
    checkText(dto.payerName, 'payerName', 200);
    checkText(dto.noReceiptReason, 'noReceiptReason', 500);
    // receiptUrl — http(s) / относительная ссылка. `javascript:alert(1)`
    // бы попал в <a href> на admin UI и сработал при клике.
    if (dto.receiptUrl) {
      const u = dto.receiptUrl.trim();
      if (!/^(https?:\/\/|\/\/|\/)\S{0,2000}$/i.test(u)) {
        throw new BadRequestException('receiptUrl должен быть http(s) или относительной ссылкой');
      }
      dto.receiptUrl = u;
    }

    // ВАЛИДАЦИЯ ЧЕКА ДЛЯ РАСХОДОВ. По требованию: бухгалтер обязан
    // приложить чек, либо фото наличных, либо явно указать причину.
    if (dto.type === 'EXPENSE') {
      if (!dto.receiptKind) {
        throw new BadRequestException(
          'Для расхода обязательно подтверждение: чек, фото наличных или причина',
        );
      }
      if (dto.receiptKind === 'REASON_ONLY') {
        if (!dto.noReceiptReason || dto.noReceiptReason.trim().length < 5) {
          throw new BadRequestException(
            'Укажи причину отсутствия чека (мин. 5 символов)',
          );
        }
      } else {
        // RECEIPT или CASH_PHOTO — нужен url прикреплённой фотки
        if (!dto.receiptUrl) {
          throw new BadRequestException('Загрузи фото чека или наличных');
        }
      }
    }

    // Привязка менеджера.
    //  * Elevated (FOUNDER/ADMIN/ACCOUNTANT): dto.managerId имеет приоритет;
    //    если не задан и есть студент — берём managerId владельца-менеджера
    //    (авто-привязка для расчёта зарплаты). Любой явно переданный
    //    managerId валидируется: user существует и имеет менеджерскую роль,
    //    иначе премии посчитаются на несуществующего/не-менеджера.
    //  * Менеджер (SALES_MANAGER/CLIENT_MANAGER): ЖЁСТКО self-attribute.
    //    dto.managerId и student-производный override игнорируются. Если
    //    транзакция привязана к студенту — этот студент обязан принадлежать
    //    самому менеджеру, иначе 403 (запрет чужой атрибуции).
    let managerId: string | null;
    if (callerIsElevated) {
      managerId = dto.managerId ?? null;
      // Elevated: если прислали studentId — студент обязан существовать
      // (иначе Prisma бросит FK-500 на write, либо, что хуже, оставит
      // orphan-строку с невалидным studentId + null managerId — silent
      // corruption по требованию аудита). Раньше валидация запускалась
      // ТОЛЬКО в ветке INCOME+пустой managerId; теперь — всегда.
      if (dto.studentId) {
        const stu = await this.prisma.student.findUnique({
          where: { id: dto.studentId },
          select: { managerId: true },
        });
        if (!stu) {
          throw new BadRequestException('studentId: студент не найден');
        }
        // Авто-привязка менеджера сохраняется: только для дохода и только
        // когда managerId не задан явно (не переопределяем выбор caller-а).
        if (dto.type === 'INCOME' && !managerId) {
          managerId = stu.managerId ?? null;
        }
      }
      if (managerId) {
        const mgr = await this.prisma.user.findUnique({
          where: { id: managerId },
          select: { id: true, role: true, roles: true },
        });
        if (!mgr) {
          throw new BadRequestException('managerId: пользователь не найден');
        }
        // Elevated тоже могут быть в роли «топового продажника» — допускаем
        // любую менеджерскую или elevated роль как валидный получатель
        // атрибуции. Полностью посторонних (студенты/партнёры) — режем.
        const managerLike: any[] = [...MANAGER_ROLES, 'FOUNDER', 'ADMIN', 'ACCOUNTANT'];
        if (!hasRole(mgr, ...managerLike)) {
          throw new BadRequestException(
            'managerId: пользователь не является менеджером',
          );
        }
      }
    } else {
      // Non-elevated → форсим self-attribute, независимо от того, что
      // прислал клиент. dto.managerId и student.managerId НЕ применяются.
      managerId = caller.id;
      if (dto.studentId) {
        const stu = await this.prisma.student.findUnique({
          where: { id: dto.studentId },
          select: { managerId: true },
        });
        if (!stu) {
          throw new BadRequestException('studentId: студент не найден');
        }
        if (stu.managerId !== caller.id) {
          throw new ForbiddenException(
            'Нельзя вносить транзакцию по чужому студенту',
          );
        }
      }
    }

    // Audit trail: если запись сделана НЕ тем же пользователем, кому
    // приписана атрибуция — фиксируем для последующей ревизии премий.
    // Легитимный кейс — ADMIN/ACCOUNTANT закрывает продажу за менеджера.
    if (managerId && managerId !== recordedById) {
      this.logger.warn(
        `Transaction attribution mismatch: recordedBy=${recordedById}, manager=${managerId}, type=${dto.type}, amount=${dto.amount}`,
      );
    }

    // Google Sheet parity — валидируем новые enum-поля против Prisma-типов.
    // Прежде чем писать в БД: если фронт прислал мусор, отвечаем 400 а не 500.
    const incomeSource = validateEnum(IncomeSource, dto.incomeSource, 'incomeSource');
    const productCategoryEnum = validateEnum(
      ProductCategory,
      dto.productCategoryEnum,
      'productCategoryEnum',
    );
    const paymentPhase = validateEnum(
      PaymentPhaseStatus,
      dto.paymentPhase,
      'paymentPhase',
    );

    // paidViaId — FK на User. Не enum, но: пустая строка → null,
    // проверяем существование, иначе Prisma бросит P2003 (500).
    let paidViaId: string | null = null;
    if (dto.paidViaId) {
      const uid = String(dto.paidViaId).trim();
      if (uid) {
        const u = await this.prisma.user.findUnique({
          where: { id: uid },
          select: { id: true },
        });
        if (!u) throw new BadRequestException('paidViaId: пользователь не найден');
        paidViaId = u.id;
      }
    }

    // Семантика полей по type:
    //  * incomeSource / paymentPhase — только для INCOME
    //  * paidViaId — только для EXPENSE
    // Если фронт прислал не по типу — тихо игнорируем (не бросаем),
    // чтобы не ломать существующие клиенты, которые могут прислать оба.
    const isIncome = dto.type === 'INCOME';
    const isExpense = dto.type === 'EXPENSE';

    // === HIGH-audit fix: sync productCategoryEnum <-> legacy productCategory.
    // enum — канонический (см. schema.prisma). Если он задан, метка едет
    // в legacy String, чтобы `incomeByProduct()` (группировка по String)
    // не терял новые записи. Если задан только legacy String и он совпадает
    // с известной меткой — заполняем enum, чтобы аналитики по enum видели
    // и старые клиенты. Итог: ни один writer не оставит два поля в дрейфе.
    const rawProductCategory = dto.productCategory?.trim() || null;
    let productCategoryFinal: string | null = rawProductCategory;
    let productCategoryEnumFinal: ProductCategory | null = productCategoryEnum ?? null;
    if (productCategoryEnumFinal) {
      // enum — источник истины: метка перезаписывает любой legacy String,
      // чтобы `incomeByProduct` показывал новую запись под правильной меткой,
      // а не под мусорной строкой из DTO.
      productCategoryFinal = labelForProductCategory(productCategoryEnumFinal);
    } else if (rawProductCategory) {
      // Только legacy String — попробуем восстановить enum по метке.
      productCategoryEnumFinal = enumForProductCategoryLabel(rawProductCategory);
    }

    const created = await this.prisma.transaction.create({
      data: {
        type: dto.type,
        category: dto.category,
        amount: dto.amount,
        currency: dto.currency || 'TJS',
        comment: dto.comment?.trim() || null,
        date: dto.date ? new Date(dto.date) : new Date(),
        studentId: dto.studentId || null,
        managerId,
        recordedById,
        paymentChannel: dto.paymentChannel || null,
        paymentKind: dto.paymentKind || null,
        productCategory: productCategoryFinal,
        payerName: dto.payerName?.trim() || null,
        receiptUrl: dto.receiptUrl || null,
        receiptKind: dto.receiptKind || null,
        noReceiptReason: dto.noReceiptReason?.trim() || null,
        incomeSource: isIncome ? (incomeSource ?? null) : null,
        productCategoryEnum: productCategoryEnumFinal,
        paymentPhase: isIncome ? (paymentPhase ?? null) : null,
        paidViaId: isExpense ? paidViaId : null,
      },
      include: {
        student: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true } },
        recordedBy: { select: { id: true, fullName: true } },
        paidVia: { select: { id: true, fullName: true } },
      },
    });
    // WS-нотификация finance-staff-комнате: у второго пользователя, у которого
    // /finance открыт в соседней вкладке, список/summary обновятся сразу
    // — без polling и без hard-refresh. Держим emit ПОСЛЕ commit — если
    // Prisma бросит, клиент получит 4xx/5xx и никаких «фантомных»
    // событий в UI не всплывёт.
    //
    // SEC (HIGH): раньше здесь был emitStaff → payload с amount, payerName,
    // comment, managerId, receiptUrl уходил ВСЕМ staff, включая
    // SALES_MANAGER/CLIENT_MANAGER, которым GET /finance/* даёт 403.
    // Любой менеджер с DevTools мог `socket.on('transaction:new', console.log)`
    // и стримить чужие продажи/расходы/бонусы. emitFinanceStaff ограничивает
    // доставку теми же ролями, что и REST-guard контроллера (FOUNDER/ADMIN/
    // ACCOUNTANT — см. realtime.gateway.ts FINANCE_ROLES).
    this.realtime.emitFinanceStaff('transaction:new', { transaction: created });
    // ActivityLog. Аудит HIGH: без этой записи INCOME/EXPENSE не всплывает
    // на /activity, и FOUNDER не может по UI ответить «кто создал
    // транзакцию X, когда». Best-effort — падение аудита не должно
    // откатывать транзакцию (см. комментарий у this.activity в
    // конструкторе). actorRole берём из caller.role, если контроллер его
    // передал; иначе 'SYSTEM' (внутренние вызывающие типа chat/ai).
    this.activity
      .log({
        actorId: recordedById,
        actorRole: caller.role || 'SYSTEM',
        action: 'FINANCE_CREATE',
        studentId: created.studentId,
        studentName: created.student?.fullName ?? null,
        details: this.formatTxDetails(created),
        payload: {
          transactionId: created.id,
          managerId: created.managerId,
          category: created.category,
          amount: created.amount,
          currency: created.currency,
        },
      })
      .catch(() => undefined);
    return created;
  }

  async update(
    id: string,
    patch: Partial<CreateTransactionDto>,
    // caller — тот же контракт что и в create(). Default: elevated=true —
    // сохраняем совместимость для внутренних вызывающих. Публичный PATCH
    // ходит только из finance.controller под @Roles('ADMIN','ACCOUNTANT'),
    // так что default безопасен; передавать реальный actor всё равно
    // желательно — чтобы окно ±3 суток работало, если PATCH когда-нибудь
    // откроют менеджерам.
    caller: FinanceActor = { id: '', isElevated: true },
  ) {
    // === Snapshot BEFORE-состояния для audit-log (CRITICAL fix). ==========
    // Аудит CRITICAL: без before-снимка PATCH /finance/transactions/:id
    // тихо переписывал managerId (получателя бонуса), amount и date. У
    // «проигравшего» менеджера пропадала атрибуция без ActivityLog-записи —
    // бонус-споры невозможно было расследовать. Забираем нужные поля один
    // раз, реюзаем для (а) guard'а non-elevated ниже, (б) date-validation,
    // (в) diff-log после успешного update.
    //
    // include manager для fullName до правки — иначе после update Prisma
    // вернёт уже новое имя, и в details попадёт «B → B» (мусор).
    const before = await this.prisma.transaction.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        amount: true,
        currency: true,
        category: true,
        date: true,
        managerId: true,
        studentId: true,
        reversedAt: true,
        // Receipt/enum поля нужны для Q4 fix: (а) при flip'е type в
        // EXPENSE мы валидируем «есть ли effective чек» с учётом того,
        // что чек мог быть уже приложен ДО патча (только type меняется);
        // (б) semantic-invariant nulling (INCOME → paidViaId=null,
        // EXPENSE → incomeSource/paymentPhase=null) применяется к
        // ЭФФЕКТИВНОМУ post-patch типу, поэтому знать текущие значения
        // необходимо, чтобы понять, надо ли вообще писать null (иначе
        // Prisma.update дёрнется на всех записях без причины).
        receiptKind: true,
        receiptUrl: true,
        noReceiptReason: true,
        incomeSource: true,
        paymentPhase: true,
        paidViaId: true,
        manager: { select: { id: true, fullName: true } },
      },
    });
    if (!before) {
      throw new BadRequestException('Транзакция не найдена');
    }

    // === Q4 fix (universal reversedAt type-change guard). ================
    // Раньше блокировка type-change на отменённой (reversedAt != null)
    // записи стояла только внутри `if (!caller.isElevated)` — а бонусные
    // агрегаты (topManagers/salary) фильтруют reversedAt на уровне SQL,
    // но НЕ пересчитывают тип строки. Если ADMIN «раз-отменит» EXPENSE
    // флипом в INCOME (или наоборот), reversedAt останется прежним, а
    // строка молча сменит семантику для любого live-агрегата, который
    // reversedAt не фильтрует (аудит, бухгалтерская выгрузка). Легитимный
    // сценарий — сначала «раз-отменить» через отдельный action, затем
    // менять тип; смешивать эти два действия в одном PATCH нельзя.
    if (
      before.reversedAt &&
      patch.type !== undefined &&
      patch.type !== before.type
    ) {
      throw new ForbiddenException(
        'Нельзя менять тип отменённой транзакции',
      );
    }

    // === Role-aware guard (parity fix с create()). ===============
    // Аудит HIGH: раньше update() писал patch.managerId/studentId в БД
    // verbatim. Пока PATCH висит под @Roles('ADMIN','ACCOUNTANT') это
    // маскирует дыру, но: (а) контроллер уже планирует пустить сюда
    // менеджеров (комментарий в finance.controller.ts перед update()),
    // (б) кастомная роль с permission finance:write доходит до PATCH
    // через RolesGuard, минуя жёсткий @Roles. В обоих случаях менеджер
    // мог бы: 1) PATCH'ем переписать managerId любой исторической
    // INCOME-записи на себя (реплей bonus-inflation вектора, который
    // create() уже закрыл self-attribute'ом); 2) привязать транзакцию
    // к чужому студенту (искажение статистики + возможный обход
    // ownership-check'а create()); 3) поднять amount у уже отменённой
    // (reversedAt != null) записи — soft-delete не должен размораживать
    // stale-кредит в bonus-подсчёте.
    //
    // Все три вектора закрываем ЗДЕСЬ, до любой prisma.update. Elevated
    // (FOUNDER/ADMIN/ACCOUNTANT) — как и в create() — исключение:
    // историческая правка/reattribution их прерогатива.
    if (!caller.isElevated) {
      const existing = before;
      // Требуем ПОЛОЖИТЕЛЬНОЕ владение: managerId должен явно совпадать
      // с caller.id. Раньше здесь стоял `existing.managerId && ...` —
      // short-circuit на NULL пропускал orphan-записи (INCOME без
      // attribution: bulk-import, забытый managerId у ADMIN, legacy).
      // В связке с нормализацией `patch.managerId = caller.id` ниже это
      // давало вектор bonus-inflation: рядовой менеджер PATCH'ем на
      // orphan-INCOME (даже пустым, с `managerId: null` или просто
      // тронув comment вместе с managerId) переписывал managerId на
      // себя, и topManagers/salary засчитывали чужую/ничейную сумму
      // в его бонус. Reopening того самого self-attribute вектора,
      // который create() уже закрыл. Отклоняем ОБА случая: и «чужой
      // владелец», и «нет владельца» (orphan). Захват orphan'ов —
      // прерогатива elevated (FOUNDER/ADMIN/ACCOUNTANT).
      if (existing.managerId !== caller.id) {
        throw new ForbiddenException(
          'Нельзя редактировать транзакцию чужого менеджера',
        );
      }
      // Reversed (soft-deleted) → не даём менять сумму. Иначе отменённая
      // продажа снова становится «большой» строкой, а reversedAt
      // остаётся — salary/topManagers её фильтруют, но любой live-агрегат
      // по всей таблице (аудит, бухгалтерия) получит фиктивный inflated
      // hit. Type-change на reversed уже блочен УНИВЕРСАЛЬНО выше
      // (Q4 fix), здесь дублировать не надо.
      if (existing.reversedAt && patch.amount !== undefined) {
        throw new ForbiddenException(
          'Отменённую транзакцию нельзя менять по сумме',
        );
      }
      // === Q4 fix (non-elevated не может флипнуть type). ================
      // create() под non-elevated жёстко self-attribute'ит managerId. Если
      // здесь пустить менеджера менять type, вектор такой: берётся любая
      // компанийская EXPENSE (rent/utilities, managerId=null), Q2 hole
      // разрешает reassign managerId на self, Q4 hole разрешает flip в
      // INCOME. Итог — фейковая выручка на бонус-счёте себя, без чека,
      // с наследованным «мусорным» incomeSource/paymentPhase от EXPENSE.
      // Легитимная правка типа — прерогатива бухгалтерии; если менеджер
      // проставил тип криво при создании, пусть перезалит через
      // ACCOUNTANT (или отменит и создаст заново — в его 3-суточном
      // окне это ок).
      if (patch.type !== undefined && patch.type !== before.type) {
        throw new ForbiddenException(
          'Менеджер не может менять тип транзакции',
        );
      }
      // managerId в патче: любая цель кроме self — отказ (симметрично
      // create() ветке non-elevated: managerId = caller.id, без вариантов).
      // Не молча перезаписываем — если фронт целится в чужого, это скорее
      // всего сознательный обход, отвечаем 403 честно.
      if (patch.managerId !== undefined) {
        const target = patch.managerId || null;
        if (target && target !== caller.id) {
          throw new ForbiddenException(
            'Менеджер не может переприписать транзакцию на другого пользователя',
          );
        }
        // null или self → нормализуем в self (create() тоже форсит self).
        patch.managerId = caller.id;
      }
      // studentId в патче: тот же ownership-check что и в create()
      // (finance.service.ts:402-415). Без него менеджер мог перевесить
      // существующую транзакцию на чужого студента и тем самым:
      // – испортить студенческую статистику владельцу;
      // – (в связке с бонусами по студенту) переиграть attribution
      //   после факта.
      if (patch.studentId !== undefined && patch.studentId) {
        const stu = await this.prisma.student.findUnique({
          where: { id: patch.studentId },
          select: { managerId: true },
        });
        if (!stu) {
          throw new BadRequestException('studentId: студент не найден');
        }
        if (stu.managerId !== caller.id) {
          throw new ForbiddenException(
            'Нельзя привязывать транзакцию к чужому студенту',
          );
        }
      }
    }

    // Те же проверки что в create. Раньше update тупо форвардил patch
    // в Prisma — currency/comment/receiptUrl/etc обходили все защиты,
    // которые я добавил в create. Делаем те же check'и.
    if (patch.amount !== undefined) {
      if (!Number.isFinite(patch.amount) || patch.amount <= 0) {
        throw new BadRequestException('Сумма должна быть больше 0');
      }
      if (patch.amount > 1_000_000) {
        throw new BadRequestException('Сумма слишком большая');
      }
    }
    const VALID_CURRENCIES = new Set(['TJS', 'USD', 'EUR', 'CNY', 'RUB']);
    if (patch.currency !== undefined && patch.currency !== null) {
      const c = patch.currency.toUpperCase();
      if (!VALID_CURRENCIES.has(c)) {
        throw new BadRequestException(`currency должен быть один из: ${[...VALID_CURRENCIES].join(', ')}`);
      }
      patch.currency = c;
    }
    // Инвариант TUITION_PAYMENT (см. одноимённый комментарий в create()).
    // PATCH-flip category=OTHER_INCOME → TUITION_PAYMENT воспроизводит ту же
    // Finance/Salary дивергенцию: строка становится невидимой для
    // salary.manualSalesAgg (фильтр category != TUITION_PAYMENT), но по-
    // прежнему видна в finance.breakdown/byManager. Отдельно разрешаем
    // no-op (patch.category === before.category === 'TUITION_PAYMENT'):
    // canonical writer'ы (submissions/payments approvePayment) пишут строку
    // с этой категорией напрямую через prisma, и PATCH таких строк по
    // другим полям (comment/receiptUrl) должен продолжать работать без
    // случайного 400 при "верни как было" из UI.
    if (patch.category === 'TUITION_PAYMENT' && before.category !== 'TUITION_PAYMENT') {
      throw new BadRequestException(
        'Категория TUITION_PAYMENT зарезервирована для платежей по сделкам (SubmissionPayment). ' +
        'Ручная смена категории на TUITION_PAYMENT приведёт к расхождению финансов и зарплат.',
      );
    }
    if (patch.date !== undefined && patch.date !== null) {
      // Bounds-check на дату патча — окно ±3 суток для не-elevated и
      // «нет будущего» для INCOME. Тип берём из patch.type, если он в
      // патче, иначе — из уже полученного `before` (второй findUnique
      // не нужен — snapshot собран в начале update()).
      const effectiveType: TransactionType | null | undefined =
        patch.type ?? before.type ?? null;
      validateTransactionDate(patch.date, effectiveType, caller);
    }
    const checkText = (val: string | undefined | null, field: string, maxLen: number) => {
      if (val === undefined || val === null) return;
      if (val.length > maxLen) throw new BadRequestException(`${field}: макс. ${maxLen} символов`);
      if (/[<>]/.test(val)) throw new BadRequestException(`${field}: HTML-теги запрещены`);
    };
    checkText(patch.comment, 'comment', 1000);
    checkText(patch.productCategory, 'productCategory', 100);
    checkText(patch.payerName, 'payerName', 200);
    checkText(patch.noReceiptReason, 'noReceiptReason', 500);
    if (patch.receiptUrl) {
      const u = patch.receiptUrl.trim();
      if (!/^(https?:\/\/|\/\/|\/)\S{0,2000}$/i.test(u)) {
        throw new BadRequestException('receiptUrl должен быть http(s) или относительной ссылкой');
      }
      patch.receiptUrl = u;
    }

    // Google Sheet parity — валидация новых enum-полей на patch тоже,
    // иначе PATCH обошёл бы проверку и Prisma опять ловила бы 500.
    let incomeSourcePatch: IncomeSource | null | undefined;
    if (patch.incomeSource !== undefined) {
      incomeSourcePatch = patch.incomeSource === null
        ? null
        : validateEnum(IncomeSource, patch.incomeSource, 'incomeSource') ?? null;
    }
    let productCategoryEnumPatch: ProductCategory | null | undefined;
    if (patch.productCategoryEnum !== undefined) {
      productCategoryEnumPatch = patch.productCategoryEnum === null
        ? null
        : validateEnum(ProductCategory, patch.productCategoryEnum, 'productCategoryEnum') ?? null;
    }
    let paymentPhasePatch: PaymentPhaseStatus | null | undefined;
    if (patch.paymentPhase !== undefined) {
      paymentPhasePatch = patch.paymentPhase === null
        ? null
        : validateEnum(PaymentPhaseStatus, patch.paymentPhase, 'paymentPhase') ?? null;
    }
    let paidViaIdPatch: string | null | undefined;
    if (patch.paidViaId !== undefined) {
      if (!patch.paidViaId) {
        paidViaIdPatch = null;
      } else {
        const uid = String(patch.paidViaId).trim();
        if (!uid) {
          paidViaIdPatch = null;
        } else {
          const u = await this.prisma.user.findUnique({
            where: { id: uid },
            select: { id: true },
          });
          if (!u) throw new BadRequestException('paidViaId: пользователь не найден');
          paidViaIdPatch = u.id;
        }
      }
    }

    // === HIGH-audit fix (см. create()): держим productCategory <-> enum
    // синхронизированными. enum — канонический источник. Правила для PATCH:
    //  * enum-патч задан значением → и enum, и legacy пишем (метка едет
    //    в legacy). Явный patch.productCategory в этом же запросе игнорим —
    //    иначе enum и String разойдутся, а enum канон.
    //  * enum-патч задан null (очистка) → чистим и legacy тоже.
    //  * enum-патч не задан, а patch.productCategory задан → пишем legacy
    //    и, если метка совпала с известной, синхронно пишем enum.
    // В итоге ни один writer не оставит два поля рассогласованными.
    let productCategoryDataPatch:
      | { productCategory: string | null }
      | Record<string, never> = {};
    let productCategoryEnumDataPatch:
      | { productCategoryEnum: ProductCategory | null }
      | Record<string, never> = {};
    if (productCategoryEnumPatch !== undefined) {
      productCategoryEnumDataPatch = { productCategoryEnum: productCategoryEnumPatch };
      productCategoryDataPatch = {
        productCategory: labelForProductCategory(productCategoryEnumPatch),
      };
    } else if (patch.productCategory !== undefined) {
      const legacyVal = patch.productCategory?.trim() || null;
      productCategoryDataPatch = { productCategory: legacyVal };
      const mirroredEnum = enumForProductCategoryLabel(legacyVal);
      if (mirroredEnum) {
        productCategoryEnumDataPatch = { productCategoryEnum: mirroredEnum };
      }
    }

    // === Q4 fix (type-flip receipt validation, parity с create()). =====
    // Если PATCH меняет type И новый тип = EXPENSE — прогоняем ту же
    // проверку чека, что create() применяет при создании EXPENSE
    // (receiptKind обязателен; REASON_ONLY требует noReceiptReason ≥ 5
    // символов; иначе receiptUrl обязателен). «Эффективное» значение
    // берём из patch (если поле в патче) или из before-снимка (если нет)
    // — иначе пришлось бы требовать перезаливки чека даже при чистом
    // type-flip'е на записи, у которой чек уже приложен.
    //
    // Флипу FROM EXPENSE → INCOME отдельная валидация не нужна: create()
    // никак не ограничивает INCOME по чеку.
    const typeChanged =
      patch.type !== undefined && patch.type !== before.type;
    if (typeChanged && patch.type === 'EXPENSE') {
      const effReceiptKind =
        patch.receiptKind !== undefined ? patch.receiptKind : before.receiptKind;
      const effReceiptUrl =
        patch.receiptUrl !== undefined ? patch.receiptUrl : before.receiptUrl;
      const effNoReceiptReason =
        patch.noReceiptReason !== undefined
          ? patch.noReceiptReason
          : before.noReceiptReason;
      if (!effReceiptKind) {
        throw new BadRequestException(
          'Для расхода обязательно подтверждение: чек, фото наличных или причина',
        );
      }
      if (effReceiptKind === 'REASON_ONLY') {
        if (!effNoReceiptReason || effNoReceiptReason.trim().length < 5) {
          throw new BadRequestException(
            'Укажи причину отсутствия чека (мин. 5 символов)',
          );
        }
      } else {
        // RECEIPT / CASH_PHOTO — нужен URL прикреплённой фотки
        if (!effReceiptUrl) {
          throw new BadRequestException('Загрузи фото чека или наличных');
        }
      }
    }

    // === Q4 fix (semantic field-nulling по эффективному типу). ==========
    // create() гарантирует инвариант: EXPENSE не носит incomeSource /
    // paymentPhase, INCOME не носит paidViaId. Без этого блока PATCH
    // молча оставлял бы предыдущие значения при type-flip'е (или писал
    // несовместимые поля из патча) — а `topManagers` / `incomeSources`
    // группируют по incomeSource, и EXPENSE с ненулевым incomeSource
    // подмешивалась бы в аналитику доходов. Форсим null на пост-патч
    // тип, spread'им ПОСЛЕ явных patch-полей ниже, чтобы перебить их.
    const effectiveType: TransactionType =
      (patch.type ?? before.type) as TransactionType;
    const isIncomeEff = effectiveType === 'INCOME';
    const isExpenseEff = effectiveType === 'EXPENSE';
    const semanticNullPatch: {
      incomeSource?: null;
      paymentPhase?: null;
      paidViaId?: null;
    } = {
      ...(isExpenseEff && { incomeSource: null, paymentPhase: null }),
      ...(isIncomeEff && { paidViaId: null }),
    };

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        ...(patch.type && { type: patch.type }),
        ...(patch.category && { category: patch.category }),
        ...(patch.amount !== undefined && { amount: patch.amount }),
        ...(patch.currency && { currency: patch.currency }),
        ...(patch.comment !== undefined && { comment: patch.comment?.trim() || null }),
        ...(patch.date && { date: new Date(patch.date) }),
        ...(patch.studentId !== undefined && { studentId: patch.studentId || null }),
        ...(patch.managerId !== undefined && { managerId: patch.managerId || null }),
        ...(patch.paymentChannel !== undefined && { paymentChannel: patch.paymentChannel }),
        ...(patch.paymentKind !== undefined && { paymentKind: patch.paymentKind }),
        ...productCategoryDataPatch,
        ...(patch.payerName !== undefined && { payerName: patch.payerName?.trim() || null }),
        ...(patch.receiptUrl !== undefined && { receiptUrl: patch.receiptUrl }),
        ...(patch.receiptKind !== undefined && { receiptKind: patch.receiptKind }),
        ...(patch.noReceiptReason !== undefined && { noReceiptReason: patch.noReceiptReason?.trim() || null }),
        ...(incomeSourcePatch !== undefined && { incomeSource: incomeSourcePatch }),
        ...productCategoryEnumDataPatch,
        ...(paymentPhasePatch !== undefined && { paymentPhase: paymentPhasePatch }),
        ...(paidViaIdPatch !== undefined && { paidViaId: paidViaIdPatch }),
        // Semantic invariant win: перебивает любые patch-поля выше,
        // если они несовместимы с эффективным типом (см. create()
        // строки 547-550 — ровно та же логика).
        ...semanticNullPatch,
      },
      include: {
        student: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true } },
      },
    });
    // WS-нотификация finance-staff-комнате: тот же сценарий, что в create() —
    // FOUNDER держит /finance открытой в другой вкладке, ACCOUNTANT
    // правит amount/managerId/date, FOUNDER видит правку без ручного
    // refetch. Emit ПОСЛЕ commit'а — на ошибке Prisma событие не
    // всплывёт и клиент получит 4xx/5xx.
    //
    // SEC (HIGH): emitFinanceStaff вместо emitStaff — payload содержит новые
    // amount/managerId/comment/payerName. SALES_MANAGER/CLIENT_MANAGER
    // не имеют HTTP-доступа к PATCH /finance/transactions/:id (см. @Roles
    // на finance.controller.ts), поэтому и WS-события об этих правках им
    // видеть нельзя — иначе через `socket.on('transaction:updated', ...)`
    // менеджер бы читал чужие правки, включая переприписки managerId
    // (bonus reassignments).
    this.realtime.emitFinanceStaff('transaction:updated', { transaction: updated });

    // === Аудит правок транзакции (CRITICAL fix). =========================
    // Всё, что ниже — best-effort .catch(). Мы уже закоммитили правку в
    // БД; если аудит-запись упадёт, откатывать транзакцию поздно
    // (пользователь бы кликнул «Сохранить» ещё раз и получил дубль).
    // Логируем то, что важно для расследования бонус-споров:
    //  * TRANSACTION_MANAGER_CHANGE — сдвиг получателя атрибуции (кто-то
    //    у кого-то отнял бонус). Отдельный action, чтобы FOUNDER мог одним
    //    фильтром /activity?action=TRANSACTION_MANAGER_CHANGE увидеть все
    //    переприписки за месяц.
    //  * FINANCE_UPDATE — общий след правки на случай, когда изменились
    //    amount / date (тоже влияют на bonus period + threshold), но не
    //    менеджер. Пишем его если diff есть хоть по одному важному полю.
    const actorId = caller.id || '';
    const actorRole = caller.role || 'SYSTEM';
    const managerChanged =
      patch.managerId !== undefined &&
      (before.managerId ?? null) !== (updated.managerId ?? null);
    const amountChanged =
      patch.amount !== undefined && before.amount !== updated.amount;
    const dateChanged =
      patch.date !== undefined && before.date.getTime() !== updated.date.getTime();

    if (managerChanged) {
      const beforeName = before.manager?.fullName || (before.managerId ? before.managerId.slice(0, 8) : '—');
      const afterName = updated.manager?.fullName || (updated.managerId ? updated.managerId.slice(0, 8) : '—');
      const txLabel = updated.id.slice(0, 8);
      const details =
        `Транзакция ${txLabel}: менеджер ${beforeName} → ${afterName}, ` +
        `сумма ${updated.amount} ${updated.currency}`;
      this.activity
        .log({
          actorId: actorId || null,
          actorRole,
          action: 'TRANSACTION_MANAGER_CHANGE',
          studentId: updated.studentId,
          studentName: updated.student?.fullName ?? null,
          details,
          payload: {
            transactionId: updated.id,
            before: {
              managerId: before.managerId,
              managerName: before.manager?.fullName ?? null,
              amount: before.amount,
              currency: before.currency,
              date: before.date,
            },
            after: {
              managerId: updated.managerId,
              managerName: updated.manager?.fullName ?? null,
              amount: updated.amount,
              currency: updated.currency,
              date: updated.date,
            },
          },
        })
        .catch(() => undefined);

      // Уведомляем staff (в т.ч. «проигравшего» и «выигравшего» менеджера)
      // о том, что атрибуция сдвинулась. Без этого проигравший узнавал
      // о потере бонуса только по квитку зарплаты — репутационный риск для
      // финотдела. Тот же pattern (notifyAllStaff) в applications.service
      // при MANAGER_CHANGE. Best-effort.
      if (this.notifications) {
        this.notifications
          .notifyAllStaff({
            type: 'TRANSACTION_MANAGER_CHANGE',
            title: 'Менеджер транзакции изменён',
            message: details,
            payload: {
              transactionId: updated.id,
              beforeManagerId: before.managerId,
              afterManagerId: updated.managerId,
              amount: updated.amount,
              currency: updated.currency,
              studentId: updated.studentId,
            },
          })
          .catch(() => undefined);
      }
    }

    // Общий FINANCE_UPDATE — пишем если хоть одно bonus-relevant поле
    // (amount / date) изменилось. Managerchange уже покрыт отдельным
    // action выше, поэтому здесь пропускаем, если ТОЛЬКО он и изменился
    // (иначе получится две записи об одном и том же для FOUNDER'а).
    if (amountChanged || dateChanged) {
      const parts: string[] = [];
      if (amountChanged) {
        parts.push(`сумма ${before.amount} ${before.currency} → ${updated.amount} ${updated.currency}`);
      }
      if (dateChanged) {
        parts.push(`дата ${before.date.toISOString()} → ${updated.date.toISOString()}`);
      }
      this.activity
        .log({
          actorId: actorId || null,
          actorRole,
          action: 'FINANCE_UPDATE',
          studentId: updated.studentId,
          studentName: updated.student?.fullName ?? null,
          details: `Транзакция ${updated.id.slice(0, 8)}: ${parts.join('; ')}`,
          payload: {
            transactionId: updated.id,
            before: {
              amount: before.amount,
              currency: before.currency,
              date: before.date,
            },
            after: {
              amount: updated.amount,
              currency: updated.currency,
              date: updated.date,
            },
            managerId: updated.managerId,
            patch,
          },
        })
        .catch(() => undefined);
    }

    return updated;
  }

  /**
   * FOUNDER-editable распределение выручки. Читает активный
   * RevenueScheme (см. revenue-scheme.service) и раскладывает
   * incomeTotal за период по его buckets:
   *   - PERCENTAGE: allocated = incomeTotal × percent / 100
   *   - FIXED_SUM: allocated = сумма amountCents по items / 100
   *
   * Legacy 70/20/10 логика удалена — единственный потребитель
   * (Finance.tsx) переходит на новый формат в этой же итерации.
   *
   * incomeTotal берём в основной валюте отчётности (TJS). Не-TJS
   * активности возвращаем в `nonTjsTotals` — бухгалтер видит, что
   * валютные транзакции были, и обрабатывает их отдельно (пока нет
   * FX-конвертации на write-time).
   */
  async distribution(opts: { from?: Date; to?: Date }) {
    this.validateRange(opts);
    // Fix (audit — CANCELLED sales leak): base `where` теперь несёт
    // `reversedAt: null`, как liveWhere в breakdown() и liveIncomeWhere в
    // topManagers(). Иначе soft-deleted INCOME-строки от CANCELLED
    // SaleSubmission продолжают формировать incomeTotal, а зеркальный
    // компенсирующий EXPENSE distribution() всё равно не читает — каждый
    // PERCENTAGE-бакет переоценивался на (возвраты × percent / 100), а
    // netAfterDistribution уезжал. То же и для nonTjsTotals: reversed
    // USD/EUR-строки исключаются вместе с базовым фильтром.
    const where = {
      ...(opts.from || opts.to
        ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
        : {}),
      reversedAt: null,
    };
    const [grouped, nonTjs, scheme] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { ...where, currency: REPORTING_CURRENCY },
        _sum: { amount: true },
      }),
      this.nonTjsTotals(where),
      this.revenueScheme?.getActive(),
    ]);
    const incomeTotal = grouped.find((g) => g.type === 'INCOME')?._sum.amount || 0;

    // Прежде чем что-то делить — если по какой-то причине активной
    // схемы нет (RevenueSchemeService не заинжекчен / БД пустая до
    // прогонки миграции), возвращаем консистентный «пустой» ответ,
    // чтобы фронт не падал на scheme.buckets.map. onModuleInit
    // засеедит дефолт на следующем рестарте.
    if (!scheme) {
      return {
        incomeTotal,
        scheme: null,
        totalPercentageAllocated: 0,
        totalFixedAllocated: 0,
        netAfterDistribution: incomeTotal,
        currency: REPORTING_CURRENCY,
        nonTjsTotals: nonTjs,
      };
    }

    let totalPercentageAllocated = 0;
    let totalFixedAllocated = 0;
    const buckets = scheme.buckets.map((b) => {
      // items — оставляем позиции в исходном order (уже отсортированы
      // в getActive), но amountCents конвертируем в sum-of-currency,
      // чтобы фронт не делил снова на 100.
      const items = b.items.map((it) => ({
        id: it.id,
        name: it.name,
        amount: it.amountCents !== null && it.amountCents !== undefined
          ? Math.round(it.amountCents) / 100
          : null,
        userId: it.userId,
        user: it.user ? { id: it.user.id, fullName: it.user.fullName } : null,
      }));
      let allocated = 0;
      if (b.kind === 'PERCENTAGE') {
        const pct = b.percent ?? 0;
        allocated = Math.round(incomeTotal * pct) / 100;
        totalPercentageAllocated += allocated;
      } else {
        // FIXED_SUM — суммируем amountCents всех items. null-суммы
        // (item без суммы в FIXED_SUM — валидатор запрещает, но на
        // случай legacy строк защищаемся) игнорируем.
        const cents = b.items.reduce(
          (acc, it) => acc + (typeof it.amountCents === 'number' ? it.amountCents : 0),
          0,
        );
        allocated = Math.round(cents) / 100;
        totalFixedAllocated += allocated;
      }
      return {
        id: b.id,
        name: b.name,
        kind: b.kind,
        color: b.color,
        percent: b.percent,
        order: b.order,
        allocated,
        items,
      };
    });

    const netAfterDistribution =
      Math.round((incomeTotal - totalPercentageAllocated - totalFixedAllocated) * 100) / 100;

    return {
      incomeTotal,
      scheme: {
        id: scheme.id,
        name: scheme.name,
        updatedAt: scheme.updatedAt,
        buckets,
      },
      totalPercentageAllocated: Math.round(totalPercentageAllocated * 100) / 100,
      totalFixedAllocated: Math.round(totalFixedAllocated * 100) / 100,
      netAfterDistribution,
      currency: REPORTING_CURRENCY,
      nonTjsTotals: nonTjs,
    };
  }

  /**
   * Топ менеджеров по продажам за период (для диаграммы "кто сколько принёс").
   */
  async topManagers(opts: { from?: Date; to?: Date; limit?: number }) {
    this.validateRange(opts);
    const limit = Math.min(opts.limit || 10, 50);
    // Fix (audit — currency mixing): ранжируем по TJS-суммам, иначе
    // менеджер, закрывший 1 контракт в USD, оказывался выше того, кто
    // сделал 5 контрактов в TJS (USD 5000 суммируется как 5000 TJS).
    //
    // Follow-up: ранжирование ведётся только по TJS-INCOME, но менеджер
    // с USD-only продажами полностью пропадал из «ТОП»-списка — фронт не
    // получал никакого сигнала, что валютная активность в периоде была.
    // Возвращаем `nonTjsTotals` (как в breakdown/summary/distribution),
    // чтобы UI мог показать бэйдж «BASE · TJS» и подсказку про USD/EUR.
    const dateRange =
      opts.from || opts.to
        ? {
            date: {
              ...(opts.from && { gte: opts.from }),
              ...(opts.to && { lte: opts.to }),
            },
          }
        : {};
    // Bug #25: ранжируем менеджеров по «живым» продажам —
    // отменённые сделки (reversedAt != null) не должны попадать
    // в топ, иначе менеджер «за счёт» отказников может всплыть выше
    // реально работающих.
    const liveIncomeWhere = {
      ...dateRange,
      reversedAt: null,
      type: 'INCOME' as const,
      managerId: { not: null },
    };
    const [grouped, nonTjs] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['managerId'],
        where: { ...liveIncomeWhere, currency: REPORTING_CURRENCY },
        _sum: { amount: true },
        _count: true,
        orderBy: { _sum: { amount: 'desc' } },
        take: limit,
      }),
      // Скоуп — тот же (live INCOME с назначенным менеджером). Так
      // бухгалтер видит USD/EUR-продажи, отсутствующие в ранжировании.
      this.nonTjsTotals(liveIncomeWhere),
    ]);
    const managerIds = grouped.map((g) => g.managerId!).filter(Boolean);
    const users = await this.prisma.user.findMany({
      where: { id: { in: managerIds } },
      select: { id: true, fullName: true, email: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return {
      managers: grouped.map((g) => ({
        manager: userMap.get(g.managerId!) || { id: g.managerId, fullName: 'Без менеджера' },
        amount: g._sum.amount || 0,
        count: g._count,
      })),
      currency: REPORTING_CURRENCY,
      nonTjsTotals: nonTjs,
    };
  }

  /**
   * Источники дохода (для диаграммы): новые клиенты / доплаты /
   * вложения собственника. Группируем INCOME по paymentKind.
   */
  async incomeSources(opts: { from?: Date; to?: Date }) {
    this.validateRange(opts);
    // Fix (audit — currency mixing): фильтруем по TJS, иначе пирог
    // «источники дохода» смешивал USD/EUR-суммы в те же слайсы.
    const grouped = await this.prisma.transaction.groupBy({
      by: ['paymentKind'],
      where: {
        type: 'INCOME',
        currency: REPORTING_CURRENCY,
        ...(opts.from || opts.to
          ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
          : {}),
      },
      _sum: { amount: true },
      _count: true,
    });
    const LABEL: Record<string, string> = {
      FULL: 'Новые клиенты (полная)',
      PREPAYMENT: 'Новые клиенты (предоплата)',
      ADDITIONAL: 'Доплаты',
      OWNER_INVESTMENT: 'Вложения собственника',
      _none: 'Без указания',
    };
    return grouped.map((g) => ({
      kind: g.paymentKind || '_none',
      label: LABEL[g.paymentKind || '_none'] || g.paymentKind,
      amount: g._sum.amount || 0,
      count: g._count,
    }));
  }

  /** Продуктовые категории дохода (Академия / Канада / США / ...). */
  async incomeByProduct(opts: { from?: Date; to?: Date }) {
    this.validateRange(opts);
    // Fix (audit — currency mixing): фильтруем по TJS. Иначе продукт
    // «США» с двумя USD-платежами по 5000 съедал бы «Академию» с
    // 20 TJS-платежами по 1000 в пирог-разрезе продуктов.
    const grouped = await this.prisma.transaction.groupBy({
      by: ['productCategory'],
      where: {
        type: 'INCOME',
        currency: REPORTING_CURRENCY,
        ...(opts.from || opts.to
          ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
          : {}),
      },
      _sum: { amount: true },
      _count: true,
    });
    return grouped
      .map((g) => ({
        product: g.productCategory || 'Без категории',
        amount: g._sum.amount || 0,
        count: g._count,
      }))
      .sort((a, b) => b.amount - a.amount);
  }

  async remove(
    id: string,
    // caller — тот же контракт что в create()/update(). Default: elevated,
    // чтобы внутренние вызывающие (тесты, чат-бот) не ломались. Публичный
    // DELETE ходит через контроллер с реальным actor'ом — actorRole
    // попадает в ActivityLog для аудита.
    caller: FinanceActor = { id: '', isElevated: true },
    // === Recovery-safe delete (audit HIGH, «hard-delete no recovery»). ===
    // По умолчанию remove() теперь делает SOFT-delete: помечает исходную
    // запись `reversedAt=new Date()` (не удаляя её физически) и добивает
    // зеркальной корректирующей записью противоположного типа —
    // ровно тот же pattern, что уже используется в
    // submissions.service.ts::changeStatus(CANCEL). Соответственно:
    //  • ошибочный клик Delete на 1_000_000 TJS INCOME больше не стирает
    //    receiptUrl / comment / payerName / incomeSource / paymentPhase /
    //    productCategory / paidViaId / date — их можно восстановить одним
    //    PATCH `reversedAt=null` + UPDATE зеркальной строки;
    //  • bonusApplied / salary-consistency — см. отдельный state-guard
    //    ниже, блокируем даже soft-delete по умолчанию;
    //  • финансовый дашборд (сумма income − expense) остаётся сбалансирован
    //    zeркальной записью, а bonus-агрегаты (salary/topManagers/breakdown)
    //    исключают reversedAt по SQL — INCOME из бонусной базы уходит.
    //
    // hardDelete=true — только для FOUNDER-ветки в контроллере (роль
    // проверяется на controller-layer, здесь просто исполняется физическое
    // удаление ПОСЛЕ orphan-check). Нужен для «санитарной» чистки древних
    // reversal-цепочек, которые уже не имеют бизнес-смысла.
    //
    // overrideBonusApplied=true — снимает конкретно bonusApplied-guard.
    // Требует elevated (проверяется в контроллере). Используется, когда
    // бухгалтер уже вручную откатил SalaryRecord и хочет отменить исходную
    // INCOME (иначе Conflict остановит его на автомате).
    options: { hardDelete?: boolean; overrideBonusApplied?: boolean } = {},
  ) {
    const hardDelete = options.hardDelete === true;
    const overrideBonusApplied = options.overrideBonusApplied === true;
    // Снимок до удаления — Prisma.delete вернёт запись, но с
    // relation'ами получить её потом уже нельзя (строки в БД нет),
    // а ActivityLog хочет studentName + человекочитаемые details.
    // Один findUnique дешевле, чем аудит с голым id.
    const existing = await this.prisma.transaction.findUnique({
      where: { id },
      include: { student: { select: { id: true, fullName: true } } },
    });

    // Единая NotFound-нормализация: раньше existence-check жил ТОЛЬКО
    // внутри `!caller.isElevated` — elevated с несуществующим id проваливался
    // в prisma.transaction.delete и получал raw P2025 (500 бухгалтеру).
    // Плюс без этого early-return дальнейшие безусловные state-guard'ы
    // (bonusApplied / reversedAt) не смогут безопасно разыменовать existing.
    if (!existing) {
      throw new NotFoundException('Транзакция не найдена');
    }

    // === Role-aware guard (parity fix с update()). =======================
    // Аудит HIGH (Q5): раньше remove() шёл сразу в prisma.transaction.delete
    // без проверки owner'а/роли. Пока контроллер прикрыт классовым
    // @Roles('ADMIN','ACCOUNTANT') это маскирует дыру, но:
    //  (а) стоит однажды добавить SALES_MANAGER в @Roles (или открыть DELETE
    //      через кастомный permission finance:write — вектор, о котором
    //      предупреждает комментарий в update() выше) — и любой менеджер
    //      сможет удалить чужую INCOME-запись, сбивая бонус коллеге, без
    //      явного следа мотива;
    //  (б) остаётся асимметрия с update(), у которого guard есть — а более
    //      разрушительный delete идёт голым. Defense-in-depth: тот же чек
    //      здесь, до любой мутации.
    // Owner-check остаётся role-gated: elevated (FOUNDER/ADMIN/ACCOUNTANT)
    // работают с чужими записями по определению (историческая правка —
    // их прерогатива). Data-integrity state-guard'ы (bonusApplied,
    // reversedAt) вынесены НИЖЕ и применяются ко всем ролям.
    if (!caller.isElevated) {
      // Owner = кто-то из двух: либо attributed manager, либо recorder.
      // Требуем хотя бы одно совпадение с caller.id — null-managerId
      // (не приписанная) запись, которую внёс сам caller, всё равно его.
      const ownedAsManager =
        existing.managerId != null && existing.managerId === caller.id;
      const ownedAsRecorder =
        existing.recordedById != null && existing.recordedById === caller.id;
      if (!ownedAsManager && !ownedAsRecorder) {
        throw new ForbiddenException('Нельзя удалять чужую транзакцию');
      }
      // Non-elevated никогда не могут hard-delete — даже с флагом. Контроллер
      // это тоже проверяет (FOUNDER-only), но дублируем на service-уровне
      // на случай, если DELETE позовут не из finance.controller (chat/ai).
      if (hardDelete) {
        throw new ForbiddenException(
          'Физическое удаление доступно только FOUNDER; используйте soft-delete',
        );
      }
      // Аналогично overrideBonusApplied — только elevated.
      if (overrideBonusApplied) {
        throw new ForbiddenException(
          'Обход блокировки bonusApplied доступен только elevated (FOUNDER/ADMIN/ACCOUNTANT)',
        );
      }
    }

    // === Data-integrity state guards (audit HIGH, Q4 + Q5). ==============
    // Q4 — bonusApplied=true: SalaryRecord уже подтянул эту INCOME в
    // salesAmount и, вероятно, выплата уже прошла. Soft-delete тоже опасен —
    // bonus-агрегаты фильтруют reversedAt=null, поэтому при следующем
    // пересчёте salary этой INCOME там уже не будет, а выплаченный бонус
    // останется как «висящий». Разрешаем только с явным
    // overrideBonusApplied=true (elevated) — обычно после ручного отката
    // SalaryRecord бухгалтером.
    if (existing.bonusApplied && !overrideBonusApplied) {
      throw new ConflictException(
        'Транзакция уже учтена в зарплате. Откатите SalaryRecord и повторите с overrideBonusApplied=true, либо используйте reverse-flow.',
      );
    }
    // Q5 — reversedAt != null: строка уже soft-deleted (либо через
    // submission CANCEL, либо предыдущим soft-remove). Повторный soft-delete
    // создал бы дубль mirror-EXPENSE и раздул netProfit-корректировку в
    // текущем периоде. Hard-delete по reversedAt-строке стирает единственный
    // след самой отмены. В обоих случаях — блок.
    if (existing.reversedAt) {
      throw new ConflictException(
        hardDelete
          ? 'Транзакция уже отменена (reversedAt) — hard-delete разрушит аудит-трейл самой отмены'
          : 'Транзакция уже отменена (reversedAt) — повторный soft-delete создаст дубль зеркальной записи',
      );
    }

    // === Orphan-reference guard (audit CRITICAL). =========================
    // SubmissionPayment.financeTransactionId / Payment.transactionId /
    // Commission.transactionId — исторически plain String без @relation
    // (см. schema.prisma:1683, 1157, 1282). Prisma в этом случае НЕ
    // каскадит и НЕ валидирует ссылку на удаление — а зависимые ветки
    // логики читают её позже как «живую»:
    //   • submissions.service.ts changeStatus CANCEL — если Transaction
    //     удалён, findUnique возвращает null → reversal INCOME для
    //     SaleSubmission и создание mirror-REFUND EXPENSE тихо не
    //     срабатывают. Bonus/salary base остаётся раздутой, netProfit
    //     занижен (сам INCOME row тоже удалён);
    //   • submissions.service.ts updatePayment paidAt/amount sync —
    //     tx.transaction.update({ where: { id: <удалённый> } }) бросает
    //     P2025 → 500 бухгалтеру, SubmissionPayment остаётся рассинхрон;
    //   • partners/referrals.service.ts — использует Commission.transactionId
    //     как ключ дедупликации; удалённая транзакция превращает ключ в
    //     ссылку в никуда, следующее approve может выплатить партнёру
    //     повторно.
    //
    // Для hard-delete — жёсткий блок (row исчезает, ссылки становятся
    // dangling). Для soft-delete — тоже блок: даже если row остаётся,
    // прямой delete в обход submission-CANCEL оставляет SubmissionPayment
    // в статусе APPROVED, ссылающимся на reversedAt-строку. Правильный
    // путь отмены сделки со связями — SaleSubmission CANCEL, который сам
    // проставит reversedAt + REJECTED + зеркальную EXPENSE согласованно.
    const [linkedSubPayment, linkedPayment, linkedCommission] =
      await Promise.all([
        this.prisma.submissionPayment.findFirst({
          where: { financeTransactionId: id },
          select: { id: true, submissionId: true },
        }),
        this.prisma.payment.findFirst({
          where: { transactionId: id },
          select: { id: true, studentId: true },
        }),
        this.prisma.commission.findFirst({
          where: { transactionId: id },
          select: { id: true, partnerId: true },
        }),
      ]);
    if (linkedSubPayment || linkedPayment || linkedCommission) {
      const refs: string[] = [];
      if (linkedSubPayment) {
        refs.push(
          `SubmissionPayment ${linkedSubPayment.id} (заявка ${linkedSubPayment.submissionId})`,
        );
      }
      if (linkedPayment) {
        refs.push(
          `Payment ${linkedPayment.id} (студент ${linkedPayment.studentId})`,
        );
      }
      if (linkedCommission) {
        refs.push(
          `Commission ${linkedCommission.id} (партнёр ${linkedCommission.partnerId})`,
        );
      }
      throw new ConflictException(
        'Нельзя удалить транзакцию: на неё ссылаются ' +
          refs.join(', ') +
          '. Отмените исходную операцию (SaleSubmission CANCEL / возврат платежа), это создаст обратную запись и освободит ссылку.',
      );
    }

    // === Hard-delete branch (FOUNDER-only, elevated confirmation). ========
    // Дошли сюда — все guard'ы прошли, orphan-ссылок нет, FOUNDER явно
    // попросил физическое удаление. Это последняя ветка, где prisma.delete
    // остался легитимен: «санитарная» чистка исторических строк без
    // бизнес-эффекта. Все остальные сценарии — через soft-delete ниже.
    if (hardDelete) {
      const deleted = await this.prisma.transaction.delete({ where: { id } });
      // WS-нотификация finance-staff-комнате: у второго пользователя, у которого
      // /finance открыт, строка исчезнет из списка сразу. Полезный payload —
      // просто id (фронту нужен именно он, чтобы выкинуть запись из cache).
      //
      // SEC (HIGH): emitFinanceStaff вместо emitStaff — раньше в payload
      // уходил весь `deleted` объект (amount, payerName, comment, managerId,
      // receiptUrl). SALES_MANAGER/CLIENT_MANAGER не могут DELETE через HTTP
      // (finance.controller.ts @Roles ADMIN/ACCOUNTANT), поэтому и знать о
      // содержимом удалённых строк им нельзя. Комната 'finance-staff' держит
      // WS-канал в тех же ролях-границах, что и REST.
      this.realtime.emitFinanceStaff('transaction:deleted', { id, transaction: deleted });
      this.activity
        .log({
          actorId: caller.id || null,
          actorRole: caller.role || 'SYSTEM',
          action: 'FINANCE_DELETE',
          studentId: existing.studentId ?? null,
          studentName: existing.student?.fullName ?? null,
          details: this.formatTxDetails(existing) + ' [HARD DELETE]',
          payload: {
            transactionId: id,
            managerId: existing.managerId ?? null,
            amount: existing.amount,
            currency: existing.currency,
            category: existing.category,
            type: existing.type,
            hardDelete: true,
            overrideBonusApplied,
          },
        })
        .catch(() => undefined);
      return deleted;
    }

    // === Soft-delete branch (default, recovery-safe). =====================
    // Тот же pattern, что submissions.service.ts::changeStatus(CANCEL):
    //   (1) исходная строка → reversedAt=now (не удаляем);
    //   (2) зеркальная запись противоположного типа с тем же amount/currency
    //       и reversedAt=now — «парная корректировка» для отчётов, которые
    //       reversedAt не фильтруют (сырой ledger, бухгалтерская выгрузка).
    // Всё внутри prisma.$transaction — либо оба апдейта, либо ни одного,
    // чтобы не оставить «половинное» состояние (только reversedAt без
    // зеркала = дисбаланс netProfit; только зеркало без reversedAt =
    // дубль в бонусной базе).
    const reversedAt = new Date();
    const mirrorType: TransactionType =
      existing.type === 'INCOME' ? 'EXPENSE' : 'INCOME';
    // Категория зеркала — «OTHER_*»: соответствует schema TransactionCategory.
    // Совпадает с тем, что делает submissions CANCEL (OTHER_EXPENSE) — так
    // reports/breakdown не увидят вспышку в «профильной» категории.
    const mirrorCategory: TransactionCategory =
      existing.type === 'INCOME' ? 'OTHER_EXPENSE' : 'OTHER_INCOME';
    const shortId = existing.id.slice(0, 8);

    const { reversed, mirror } = await this.prisma.$transaction(async (tx) => {
      const reversedRow = await tx.transaction.update({
        where: { id },
        data: { reversedAt },
      });
      const mirrorRow = await tx.transaction.create({
        data: {
          type: mirrorType,
          category: mirrorCategory,
          amount: existing.amount,
          currency: existing.currency,
          // Дата зеркала = сегодня, чтобы корректировка попала в текущий
          // финансовый период, а не задним числом в уже закрытый месяц
          // (иначе ретро-сдвиг netProfit предыдущих отчётов).
          date: reversedAt,
          studentId: existing.studentId,
          managerId: existing.managerId,
          // recordedBy — кто инициировал отмену. Может быть null для
          // внутренних вызывающих (chat/ai) без caller.id — schema поле
          // nullable, это допустимо.
          recordedById: caller.id || null,
          comment: `Отмена транзакции #${shortId} (soft-delete)`,
          // Reversal-запись — корректирующая; маркируем reversedAt тоже,
          // чтобы (а) при возможном UN-CANCEL её не «отменить повторно»,
          // (б) отчёты могли отличить её как pair-entry, (в) bonus-агрегаты
          // (фильтруют reversedAt=null) её не подхватили как «настоящий»
          // доход/расход менеджера.
          reversedAt,
        },
      });
      return { reversed: reversedRow, mirror: mirrorRow };
    });

    // WS-нотификации finance-staff-комнате. Emit ПОСЛЕ commit'а $transaction,
    // чтобы при роллбэке в UI не всплыли фантомы. Emit'им ОБЕ строки:
    //  • transaction:updated — исходная получила reversedAt, UI должен
    //    показать её как «отменена» (перечёркнутой);
    //  • transaction:new — зеркальная строка появилась в списке как
    //    корректирующая запись.
    // Фронт (Finance.tsx) слушает и то и другое → schedule invalidate.
    this.realtime.emitFinanceStaff('transaction:updated', { transaction: reversed });
    this.realtime.emitFinanceStaff('transaction:new', { transaction: mirror });

    // ActivityLog: FINANCE_DELETE. Best-effort — падение аудита не должно
    // откатывать сам soft-delete. Сохраняем ссылку на mirror.id, чтобы
    // при разборе инцидента можно было найти обе строки.
    this.activity
      .log({
        actorId: caller.id || null,
        actorRole: caller.role || 'SYSTEM',
        action: 'FINANCE_DELETE',
        studentId: existing.studentId ?? null,
        studentName: existing.student?.fullName ?? null,
        details:
          this.formatTxDetails(existing) +
          ` [SOFT DELETE → mirror ${mirror.id.slice(0, 8)}]`,
        payload: {
          transactionId: id,
          mirrorTransactionId: mirror.id,
          managerId: existing.managerId ?? null,
          amount: existing.amount,
          currency: existing.currency,
          category: existing.category,
          type: existing.type,
          softDelete: true,
          overrideBonusApplied,
          reversedAt: reversedAt.toISOString(),
        },
      })
      .catch(() => undefined);

    return reversed;
  }

  /**
   * Единый эндпоинт-агрегат для аналитической страницы «структура доходов
   * и расходов». Возвращает три параллельных разреза за один период:
   *  - byIncomeSource — INCOME разбитый по `incomeSource` (NEW_CLIENT / UP_SALE / OTHER)
   *  - byManager      — INCOME разбитый по менеджеру (кто сколько принёс)
   *  - byExpenseCategory — EXPENSE разбитый по TransactionCategory
   * Отменённые (reversedAt != null) исключаем, чтобы структура не искажалась
   * отказниками — та же логика, что в topManagers.
   *
   * === BONUS-RECONCILE FIX (audit CRITICAL, follow-up bug #22) ===========
   * Ранее byManager/byIncomeSource считали ВСЮ INCOME по Transaction.date,
   * а salary.preview — TUITION_PAYMENT-приход по SubmissionPayment.reviewedAt
   * (bug #22 фикс, см. salary.service.ts:112). Одна и та же продажа с
   * paidAt в одном периоде и reviewedAt в следующем попадала в разные
   * месяцы у двух отчётов: FOUNDER видел в /finance/breakdown у Amir'а
   * 15 000 TJS в ноябре, а в квитке зарплаты — 10 000 TJS. Разницу
   * невозможно было отследить без ручной сверки платежей.
   *
   * Fix: разбиваем INCOME на два куска (те же, что использует salary):
   *   1) TUITION_PAYMENT-транзакции — берём через SubmissionPayment
   *      .reviewedAt-период (тот же якорь, что даёт бонус). Так суммарный
   *      byManager amount === salary.preview.salesAmount для одного
   *      менеджера/периода.
   *   2) Ручные INCOME (category != TUITION_PAYMENT) — по Transaction
   *      .date, как раньше. У них нет SubmissionPayment.reviewedAt,
   *      триггер начисления = сам факт транзакции.
   *
   * byExpenseCategory остаётся по Transaction.date — расходы к
   * SubmissionPayment не привязаны, триггер всегда сам факт транзакции.
   *
   * Двойной парити-якорь с salary: TUITION_PAYMENT-транзакции с
   * reversedAt != null исключаем даже если payment ещё status=APPROVED
   * (случай ручной корректировки без CANCEL сделки). См. ANCHOR-PARITY-FIX
   * в salary.service.ts.
   */
  async breakdown(opts: { from?: Date; to?: Date }) {
    this.validateRange(opts);
    const dateRange = opts.from || opts.to
      ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
      : {};
    const reviewedRange = opts.from || opts.to
      ? { reviewedAt: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
      : {};
    const liveWhere = { ...dateRange, reversedAt: null } as const;
    // Fix (audit — currency mixing, CRITICAL): все три groupBy
    // считались `_sum: { amount: true }` без фильтра по валюте.
    // Один USD 5000 tuition-платёж превращал 200 USD/TJS смешанной
    // выручки в «200 сомони» на пирогах. Теперь фильтруем по TJS,
    // а не-TJS активности отдаём в `nonTjsTotals` — фронт может
    // показать баннер «в периоде были ещё платежи в USD/EUR».
    const tjsWhere = { ...liveWhere, currency: REPORTING_CURRENCY } as const;

    // Шаг 1: собираем финансовые транзакции, порождённые SubmissionPayment
    // одобрениями, попавшими в период по reviewedAt (тот же скоуп, что
    // salary — TJS-сделки, не CANCELLED). Prisma не даёт back-relation
    // Transaction → SubmissionPayment (в schema.prisma только @unique-FK),
    // поэтому идём в 2 шага: сначала payment-ids → tx-ids, потом
    // groupBy по Transaction c `id in (...)`.
    const reviewedPayments = await this.prisma.submissionPayment.findMany({
      where: {
        status: 'APPROVED',
        ...reviewedRange,
        submission: {
          currency: REPORTING_CURRENCY,
          status: { not: 'CANCELLED' },
        },
        financeTransactionId: { not: null },
      },
      select: { financeTransactionId: true },
    });
    const reviewedTxIds = reviewedPayments
      .map((p) => p.financeTransactionId)
      .filter((id): id is string => id !== null);

    // Where-фильтр «tuition-транзакции, попавшие в период по reviewedAt».
    // reversedAt: null — второй якорь parity с salary (см. заголовок).
    // Пустой набор id → Prisma вернёт 0 строк без ошибки.
    const submissionSourcedWhere = {
      id: { in: reviewedTxIds },
      reversedAt: null,
      type: 'INCOME' as const,
      currency: REPORTING_CURRENCY,
    };

    // Ручной INCOME — старый date-based фильтр, но с исключением
    // TUITION_PAYMENT (эти теперь считаются через reviewedAt-ветку выше,
    // чтобы не задвоить). По инварианту, ручное создание Transaction с
    // category=TUITION_PAYMENT запрещено, но фильтр — defense-in-depth.
    const manualIncomeWhere = {
      ...tjsWhere,
      type: 'INCOME' as const,
      category: { not: 'TUITION_PAYMENT' as const },
    };

    const [bySrcManual, bySrcSub, byMgrManual, byMgrSub, byCat, mgrList, nonTjs] =
      await Promise.all([
        this.prisma.transaction.groupBy({
          by: ['incomeSource'],
          where: manualIncomeWhere,
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.transaction.groupBy({
          by: ['incomeSource'],
          where: submissionSourcedWhere,
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.transaction.groupBy({
          by: ['managerId'],
          where: { ...manualIncomeWhere, managerId: { not: null } },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.transaction.groupBy({
          by: ['managerId'],
          where: { ...submissionSourcedWhere, managerId: { not: null } },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.transaction.groupBy({
          by: ['category'],
          where: { ...tjsWhere, type: 'EXPENSE' },
          _sum: { amount: true },
          _count: true,
          orderBy: { _sum: { amount: 'desc' } },
        }),
        // Единичный дозапрос за именами менеджеров — findMany быстрее чем
        // N отдельных `include`, а groupBy relation'ы не поддерживает.
        this.prisma.user.findMany({
          select: { id: true, fullName: true, email: true },
        }),
        this.nonTjsTotals(liveWhere),
      ]);

    const INCOME_SRC_LABEL: Record<string, string> = {
      NEW_CLIENT: 'Новый клиент',
      UP_SALE: 'Апселл',
      OTHER: 'Прочее',
      _none: 'Без указания',
    };
    const userMap = new Map(mgrList.map((u) => [u.id, u]));

    // Мёрж двух источников INCOME по incomeSource. Ключ null → '_none'
    // при выводе, но в Map держим null, чтобы не спутать с валидным enum.
    const srcMap = new Map<string | null, { amount: number; count: number }>();
    for (const g of [...bySrcManual, ...bySrcSub]) {
      const key = g.incomeSource ?? null;
      const cur = srcMap.get(key) ?? { amount: 0, count: 0 };
      cur.amount += g._sum.amount || 0;
      cur.count += g._count;
      srcMap.set(key, cur);
    }
    // Тот же мёрж для byManager. Если один менеджер имеет и ручной, и
    // submission-приход в периоде — суммируем; иначе была бы дубль-строка.
    const mgrMap = new Map<string, { amount: number; count: number }>();
    for (const g of [...byMgrManual, ...byMgrSub]) {
      if (!g.managerId) continue; // managerId filter выше уже режет null
      const cur = mgrMap.get(g.managerId) ?? { amount: 0, count: 0 };
      cur.amount += g._sum.amount || 0;
      cur.count += g._count;
      mgrMap.set(g.managerId, cur);
    }

    return {
      byIncomeSource: Array.from(srcMap.entries()).map(([source, v]) => ({
        source: source ?? '_none',
        label: INCOME_SRC_LABEL[source ?? '_none'] ?? source,
        amount: v.amount,
        count: v.count,
      })),
      // Сортировка desc по amount — перенесена из orderBy в in-memory
      // после мёржа. Прежний Prisma orderBy отсортировал бы каждый кусок
      // отдельно и после сложения порядок разъехался бы.
      byManager: Array.from(mgrMap.entries())
        .sort((a, b) => b[1].amount - a[1].amount)
        .map(([managerId, v]) => ({
          managerId,
          manager: userMap.get(managerId) || { id: managerId, fullName: 'Без менеджера' },
          amount: v.amount,
          count: v.count,
        })),
      byExpenseCategory: byCat.map((g) => ({
        category: g.category,
        amount: g._sum.amount || 0,
        count: g._count,
      })),
      currency: REPORTING_CURRENCY,
      nonTjsTotals: nonTjs,
      // Метадата якоря — фронт может показать подсказку бухгалтеру:
      // «tuition-приход учтён по дате одобрения FOUNDER'ом (совпадает с
      // датой начисления бонуса зарплаты); ручной INCOME — по дате
      // самой транзакции». Помогает при сверке с /salary/preview,
      // если менеджер спрашивает «почему разные числа?».
      incomeAnchor: {
        tuition: 'submissionPayment.reviewedAt',
        manual: 'transaction.date',
      },
    };
  }

  private validateRange(opts: { from?: Date; to?: Date }) {
    if (opts.from && opts.to && opts.from > opts.to) {
      throw new BadRequestException('Начало периода позже конца');
    }
  }

  /** Сводка: общий доход / расход / прибыль за период. */
  async summary(opts: { from?: Date; to?: Date }) {
    this.validateRange(opts);
    const where = {
      ...(opts.from || opts.to
        ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
        : {}),
    };
    // Fix (audit — currency mixing): считаем чистую прибыль в TJS.
    // Иначе `netProfit` = TJS_доход − USD_расход (безразмерное число),
    // и весь дашборд бухгалтера показывал ложь при первой валютной
    // транзакции. Не-TJS суммы возвращаем отдельно (см. nonTjsTotals).
    const [income, expense, nonTjs] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { ...where, type: 'INCOME', currency: REPORTING_CURRENCY },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transaction.aggregate({
        where: { ...where, type: 'EXPENSE', currency: REPORTING_CURRENCY },
        _sum: { amount: true },
        _count: true,
      }),
      this.nonTjsTotals(where),
    ]);
    const totalIncome = income._sum.amount || 0;
    const totalExpense = expense._sum.amount || 0;
    return {
      totalIncome,
      totalExpense,
      netProfit: totalIncome - totalExpense,
      incomeCount: income._count,
      expenseCount: expense._count,
      currency: REPORTING_CURRENCY,
      nonTjsTotals: nonTjs,
    };
  }

  /** Группировка по категориям — для дашборда руководителя. */
  async byCategory(opts: { from?: Date; to?: Date }) {
    this.validateRange(opts);
    const where = {
      ...(opts.from || opts.to
        ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
        : {}),
    };
    // Fix (audit — currency mixing): TJS-only. См. общий комментарий у
    // REPORTING_CURRENCY. Не-TJS в этот эндпоинт не подмешиваем: фронт
    // рендерит бары в сомони и суммирование USD как сомони обманывает
    // руководителя.
    const grouped = await this.prisma.transaction.groupBy({
      by: ['type', 'category'],
      where: { ...where, currency: REPORTING_CURRENCY },
      _sum: { amount: true },
      _count: true,
    });
    return grouped.map((g) => ({
      type: g.type,
      category: g.category,
      amount: g._sum.amount || 0,
      count: g._count,
    }));
  }

  /**
   * Временной ряд для графика — суммы доходов/расходов сгруппированные
   * по дням / неделям / месяцам.
   */
  async timeseries(opts: { from?: Date; to?: Date; bucket?: 'day' | 'week' | 'month' }) {
    this.validateRange(opts);
    const bucket = opts.bucket || 'week';
    const where = {
      ...(opts.from || opts.to
        ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
        : {}),
    };
    // Fix (audit — currency mixing): график тоже TJS-only. Раньше
    // USD 5000 tuition-платёж давал пик «5000 сомони» на графике
    // за нужную неделю — визуально идентичный настоящему TJS-платежу.
    const all = await this.prisma.transaction.findMany({
      where: { ...where, currency: REPORTING_CURRENCY },
      orderBy: { date: 'asc' },
      select: { type: true, amount: true, date: true },
    });

    const map = new Map<string, { income: number; expense: number; profit: number }>();
    for (const t of all) {
      const key = bucketKey(t.date, bucket);
      const cur = map.get(key) || { income: 0, expense: 0, profit: 0 };
      if (t.type === 'INCOME') cur.income += t.amount;
      else cur.expense += t.amount;
      cur.profit = cur.income - cur.expense;
      map.set(key, cur);
    }

    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, ...value }));
  }

  /**
   * Студенты с задолженностью — по флагу Application.paymentPending.
   *
   * ПОЧЕМУ НЕ СТАТУС. Раньше здесь стояло `status: 'AWAITING_PAYMENT'`.
   * В новом наборе статусов (исходы квалификации лида) «ожидает оплаты» нет
   * вообще, а prisma/migrate-lead-statuses.ts схлопывает AWAITING_PAYMENT в
   * IN_PROCESSING — то есть после первого же прогона миграции этот запрос
   * навсегда возвращал бы пустой список. Причём молча: и карточка дашборда
   * «Студентов с задолженностью», и раздел «Задолженность студентов» в
   * Финансах рисуют пустоту, а не ошибку, так что «ноль должников» никто бы
   * не оспорил. Подменить статус на IN_PROCESSING тоже нельзя — это объявило
   * бы должниками всех, кто просто в работе.
   *
   * Поэтому признак долга живёт в durable-колонке paymentPending: миграция
   * заполняет её из AWAITING_PAYMENT ДО перезаписи статусов, а менеджер
   * ставит и снимает флаг в карточке заявки (PATCH /applications/:id),
   * независимо от статуса квалификации.
   *
   * Легаси-статус остаётся во втором операнде OR ровно по той же причине, по
   * которой легаси-хвосты есть в common/application-status.ts: `start:prod`
   * поднимает новый билд, а миграционные скрипты доезжают уже после, и в этом
   * окне должник ещё лежит с AWAITING_PAYMENT и paymentPending = false.
   * Когда `SELECT DISTINCT status FROM "Application"` перестанет отдавать
   * легаси-значения, этот операнд можно убрать вместе с остальными хвостами.
   */
  async pendingPayments() {
    const apps = await this.prisma.application.findMany({
      where: {
        OR: [{ paymentPending: true }, { status: 'AWAITING_PAYMENT' }],
      },
      include: {
        student: { select: { id: true, fullName: true, phones: true, email: true } },
        manager: { select: { id: true, fullName: true } },
        program: { select: { id: true, name: true, cost: true, currency: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return apps;
  }
}

function bucketKey(d: Date, bucket: 'day' | 'week' | 'month'): string {
  const dt = new Date(d);
  // Fix (Q7 — TZ leak): раньше bucket считался в UTC, из-за чего транзакции
  // между 00:00–04:59 TJT падали в предыдущие сутки/неделю/месяц (например,
  // 2026-02-01T02:00 TJT = 2026-01-31T21:00Z → уходило в январь). Все ключи
  // должны считаться в Asia/Dushanbe — как и остальные периодические границы
  // (см. common/tj-time.ts).
  if (bucket === 'day') {
    return tjLocalDay(dt);
  }
  const { y, m, d: dd } = tjYMD(dt);
  if (bucket === 'month') {
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  // week — ISO week (понедельник как старт) от TJ-локальной календарной даты.
  // Берём (y,m,d) в TJT и обращаемся с ним как с чистой датой через UTC-якорь,
  // чтобы арифметика дней не «поехала» из-за UTC-vs-TJT.
  const anchor = new Date(Date.UTC(y, m - 1, dd));
  const day = anchor.getUTCDay() || 7;
  const monday = new Date(Date.UTC(y, m - 1, dd - day + 1));
  return monday.toISOString().slice(0, 10);
}

