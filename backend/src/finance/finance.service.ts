import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PaymentChannel,
  PaymentKind,
  ReceiptKind,
  TransactionCategory,
  TransactionType,
} from '@prisma/client';

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
}

@Injectable()
export class FinanceService {
  constructor(private prisma: PrismaService) {}

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

  async create(dto: CreateTransactionDto, recordedById: string) {
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
    // Date NaN check. Раньше new Date("garbage") давал Invalid Date,
    // Prisma бросал 500 на write.
    if (dto.date) {
      const d = new Date(dto.date);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Некорректная дата');
    }
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

    // Авто-привязка менеджера: если транзакция-доход и привязана к студенту,
    // — берём его managerId, чтобы потом зарплата считалась автоматически.
    let managerId = dto.managerId ?? null;
    if (dto.type === 'INCOME' && dto.studentId && !managerId) {
      const stu = await this.prisma.student.findUnique({
        where: { id: dto.studentId },
        select: { managerId: true },
      });
      managerId = stu?.managerId ?? null;
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
        productCategory: dto.productCategory?.trim() || null,
        payerName: dto.payerName?.trim() || null,
        receiptUrl: dto.receiptUrl || null,
        receiptKind: dto.receiptKind || null,
        noReceiptReason: dto.noReceiptReason?.trim() || null,
      },
      include: {
        student: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true } },
        recordedBy: { select: { id: true, fullName: true } },
      },
    });
  }

  async update(id: string, patch: Partial<CreateTransactionDto>) {
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
      const d = new Date(patch.date as any);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Некорректная дата');
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
        ...(patch.productCategory !== undefined && { productCategory: patch.productCategory?.trim() || null }),
        ...(patch.payerName !== undefined && { payerName: patch.payerName?.trim() || null }),
        ...(patch.receiptUrl !== undefined && { receiptUrl: patch.receiptUrl }),
        ...(patch.receiptKind !== undefined && { receiptKind: patch.receiptKind }),
        ...(patch.noReceiptReason !== undefined && { noReceiptReason: patch.noReceiptReason?.trim() || null }),
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
    const grouped = await this.prisma.transaction.groupBy({
      by: ['type'],
      where,
      _sum: { amount: true },
    });
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
    };
  }

  /**
   * Топ менеджеров по продажам за период (для диаграммы "кто сколько принёс").
   */
  async topManagers(opts: { from?: Date; to?: Date; limit?: number }) {
    this.validateRange(opts);
    const limit = Math.min(opts.limit || 10, 50);
    const grouped = await this.prisma.transaction.groupBy({
      by: ['managerId'],
      where: {
        type: 'INCOME',
        managerId: { not: null },
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
    const grouped = await this.prisma.transaction.groupBy({
      by: ['paymentKind'],
      where: {
        type: 'INCOME',
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
    const grouped = await this.prisma.transaction.groupBy({
      by: ['productCategory'],
      where: {
        type: 'INCOME',
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
    const [income, expense] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { ...where, type: 'INCOME' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transaction.aggregate({
        where: { ...where, type: 'EXPENSE' },
        _sum: { amount: true },
        _count: true,
      }),
    ]);
    const totalIncome = income._sum.amount || 0;
    const totalExpense = expense._sum.amount || 0;
    return {
      totalIncome,
      totalExpense,
      netProfit: totalIncome - totalExpense,
      incomeCount: income._count,
      expenseCount: expense._count,
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
    const grouped = await this.prisma.transaction.groupBy({
      by: ['type', 'category'],
      where,
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
    const all = await this.prisma.transaction.findMany({
      where,
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

