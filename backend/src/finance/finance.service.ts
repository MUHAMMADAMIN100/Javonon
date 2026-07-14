import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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

/**
 * Actor context for create(): id + флаг elevated. Elevated (FOUNDER/ADMIN/
 * ACCOUNTANT) могут ставить любой managerId; менеджеры (SALES_MANAGER/
 * CLIENT_MANAGER) — только self-attribute. Флаг считает вызывающий
 * (controller через isElevated(me)) — сервису не нужно знать про AuthUser.
 */
export type FinanceActor = { id: string; isElevated: boolean };

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
  constructor(private prisma: PrismaService) {}

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

    return this.prisma.transaction.create({
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
    if (patch.date !== undefined && patch.date !== null) {
      // Bounds-check на дату патча — окно ±3 суток для не-elevated и
      // «нет будущего» для INCOME. Тип берём из patch.type, если он в
      // патче, иначе — из существующей записи (иначе PATCH мог бы
      // передвинуть INCOME в будущее без указания type).
      let effectiveType: TransactionType | null | undefined = patch.type;
      if (effectiveType === undefined) {
        const existing = await this.prisma.transaction.findUnique({
          where: { id },
          select: { type: true },
        });
        effectiveType = existing?.type ?? null;
      }
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

    return this.prisma.transaction.update({
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
      },
    });
  }

  /**
   * Модель распределения 70/20/10:
   *  70% — бизнес-расходы (зарплаты + аренда + операционные)
   *  20% — долги/аутсорс (выплаты подрядчикам, посредникам)
   *  10% — резерв
   *
   * Берём ЧИСТУЮ ПРИБЫЛЬ за период (доход − расход), и показываем как
   * она должна быть распределена. Реальное распределение делает админ
   * вручную через создание EXPENSE-транзакций.
   */
  async distribution(opts: { from?: Date; to?: Date }) {
    this.validateRange(opts);
    const where = {
      ...(opts.from || opts.to
        ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
        : {}),
    };
    // Fix (audit — currency mixing): фильтруем по TJS. Раньше USD/EUR
    // складывались с TJS как безразмерное число, и рекомендация «70%
    // бизнес» рассчитывалась от смешанной суммы. Не-TJS активности
    // возвращаем в `nonTjsTotals` — бухгалтер её видит и обрабатывает
    // отдельно (пока нет FX-конвертации на write-time).
    const [grouped, nonTjs] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { ...where, currency: REPORTING_CURRENCY },
        _sum: { amount: true },
      }),
      this.nonTjsTotals(where),
    ]);
    const income = grouped.find((g) => g.type === 'INCOME')?._sum.amount || 0;
    const expense = grouped.find((g) => g.type === 'EXPENSE')?._sum.amount || 0;
    const net = income - expense;
    const positive = Math.max(0, net);
    return {
      income,
      expense,
      net,
      distribution: {
        business: Math.round(positive * 0.7 * 100) / 100,
        debts: Math.round(positive * 0.2 * 100) / 100,
        reserve: Math.round(positive * 0.1 * 100) / 100,
      },
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
    const grouped = await this.prisma.transaction.groupBy({
      by: ['managerId'],
      where: {
        type: 'INCOME',
        managerId: { not: null },
        currency: REPORTING_CURRENCY,
        // Bug #25: ранжируем менеджеров по «живым» продажам —
        // отменённые сделки (reversedAt != null) не должны попадать
        // в топ, иначе менеджер «за счёт» отказников может всплыть выше
        // реально работающих.
        reversedAt: null,
        ...(opts.from || opts.to
          ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
          : {}),
      },
      _sum: { amount: true },
      _count: true,
      orderBy: { _sum: { amount: 'desc' } },
      take: limit,
    });
    const managerIds = grouped.map((g) => g.managerId!).filter(Boolean);
    const users = await this.prisma.user.findMany({
      where: { id: { in: managerIds } },
      select: { id: true, fullName: true, email: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return grouped.map((g) => ({
      manager: userMap.get(g.managerId!) || { id: g.managerId, fullName: 'Без менеджера' },
      amount: g._sum.amount || 0,
      count: g._count,
    }));
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

  async remove(id: string) {
    return this.prisma.transaction.delete({ where: { id } });
  }

  /**
   * Единый эндпоинт-агрегат для аналитической страницы «структура доходов
   * и расходов». Возвращает три параллельных разреза за один период:
   *  - byIncomeSource — INCOME разбитый по `incomeSource` (NEW_CLIENT / UP_SALE / OTHER)
   *  - byManager      — INCOME разбитый по менеджеру (кто сколько принёс)
   *  - byExpenseCategory — EXPENSE разбитый по TransactionCategory
   * Отменённые (reversedAt != null) исключаем, чтобы структура не искажалась
   * отказниками — та же логика, что в topManagers.
   */
  async breakdown(opts: { from?: Date; to?: Date }) {
    this.validateRange(opts);
    const dateRange = opts.from || opts.to
      ? { date: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }
      : {};
    const liveWhere = { ...dateRange, reversedAt: null } as const;
    // Fix (audit — currency mixing, CRITICAL): все три groupBy
    // считались `_sum: { amount: true }` без фильтра по валюте.
    // Один USD 5000 tuition-платёж превращал 200 USD/TJS смешанной
    // выручки в «200 сомони» на пирогах. Теперь фильтруем по TJS,
    // а не-TJS активности отдаём в `nonTjsTotals` — фронт может
    // показать баннер «в периоде были ещё платежи в USD/EUR».
    const tjsWhere = { ...liveWhere, currency: REPORTING_CURRENCY } as const;

    const [bySrc, byMgr, byCat, mgrList, nonTjs] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['incomeSource'],
        where: { ...tjsWhere, type: 'INCOME' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transaction.groupBy({
        by: ['managerId'],
        where: { ...tjsWhere, type: 'INCOME', managerId: { not: null } },
        _sum: { amount: true },
        _count: true,
        orderBy: { _sum: { amount: 'desc' } },
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

    return {
      byIncomeSource: bySrc.map((g) => ({
        source: g.incomeSource || '_none',
        label: INCOME_SRC_LABEL[g.incomeSource || '_none'] || g.incomeSource,
        amount: g._sum.amount || 0,
        count: g._count,
      })),
      byManager: byMgr.map((g) => ({
        managerId: g.managerId,
        manager: userMap.get(g.managerId!) || { id: g.managerId, fullName: 'Без менеджера' },
        amount: g._sum.amount || 0,
        count: g._count,
      })),
      byExpenseCategory: byCat.map((g) => ({
        category: g.category,
        amount: g._sum.amount || 0,
        count: g._count,
      })),
      currency: REPORTING_CURRENCY,
      nonTjsTotals: nonTjs,
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

  /** Студенты с задолженностью — из status AWAITING_PAYMENT. */
  async pendingPayments() {
    const apps = await this.prisma.application.findMany({
      where: { status: 'AWAITING_PAYMENT' },
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
  if (bucket === 'day') {
    return dt.toISOString().slice(0, 10);
  }
  if (bucket === 'month') {
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  // week — ISO week (понедельник как старт)
  const day = dt.getUTCDay() || 7;
  const monday = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - day + 1));
  return monday.toISOString().slice(0, 10);
}

