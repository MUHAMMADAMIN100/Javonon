import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { tjEndOfDay, tjEndOfMonth, tjLocalDay, tjParseLocalDate, tjStartOfDay, tjStartOfMonth } from '../common/tj-time';

/**
 * Счета компании, переводы между ними и остатки (раздел «Финансы», перенос из
 * Sabt, 10.11.2026).
 *
 * Остаток счёта не хранится — считается на лету:
 *   стартовый остаток + доходы − расходы + пришедшие переводы − ушедшие.
 * В расчёт идут только живые операции (reversedAt = null, как во всех суммах
 * раздела) с датой не позже сегодняшнего дня по Душанбе.
 *
 * Счёт операции: её accountId, а если он пуст (старые операции и операции из
 * сделок, зарплаты и т.п.) — по способу оплаты и валюте через
 * FinanceChannelMap. Способ оплаты у оплаты по сделке не записан в самой
 * операции — берём его из платежа сделки (SubmissionPayment / Payment).
 * Сами операции при этом не меняются: раскладку можно перенастроить в любой
 * момент.
 *
 * Остатки ведутся с даты FinanceConfig.balanceSince (решение заказчика
 * 10.11.2026 — «с даты запуска»): стартовый остаток счёта — сколько было на
 * нём в этот день, более ранние операции на остатки не влияют и в раскладку
 * не попадают. Дата ставится сама при создании первого счёта (сегодня), её
 * можно поменять в настройках. Пусто — вся история.
 */

export const FINANCE_CURRENCIES = ['TJS', 'USD', 'EUR', 'CNY', 'RUB'] as const;
const ACCOUNT_KINDS = ['BANK', 'CASH', 'SAVINGS'] as const;
/** Способ оплаты не указан. */
export const CHANNEL_NONE = 'NONE';
const CHANNELS = ['ALIF_MOBILE', 'CASH', 'BANK_TRANSFER', 'CARD', 'CRYPTO', 'OTHER', CHANNEL_NONE];
const MAX_AMOUNT = 100_000_000;

/** Способ оплаты платежа сделки → способ оплаты операции. */
const SUBMISSION_METHOD_CHANNEL: Record<string, string> = { TRANSFER: 'BANK_TRANSFER', CASH: 'CASH', OTHER: 'OTHER' };

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AccountDto {
  name?: string;
  kind?: string;
  currency?: string;
  color?: string | null;
  startBalance?: number | string;
  archived?: boolean;
  position?: number;
}

export interface TransferDto {
  fromAccountId?: string;
  toAccountId?: string;
  amount?: number | string;
  toAmount?: number | string | null;
  date?: string;
  comment?: string | null;
}

export interface LedgerRow {
  date: Date;
  accountId: string;
  delta: number;
}

export interface ChannelBucket {
  channel: string;
  currency: string;
  count: number;
  accountId: string | null;
}

function checkText(val: unknown, field: string, max: number): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string') throw new BadRequestException(`${field}: ожидается текст`);
  const v = val.trim();
  if (v.length > max) throw new BadRequestException(`${field}: не длиннее ${max} символов`);
  if (/[<>]/.test(v)) throw new BadRequestException(`${field}: знаки < и > недопустимы`);
  return v || null;
}

function parseMoney(val: unknown, field: string, { allowZero = false, allowNegative = false } = {}): number {
  const n = typeof val === 'string' ? Number(val.replace(/\s/g, '').replace(',', '.')) : Number(val);
  if (!Number.isFinite(n)) throw new BadRequestException(`${field}: введите число`);
  if (!allowNegative && n < 0) throw new BadRequestException(`${field}: не может быть отрицательной`);
  if (!allowZero && n <= 0) throw new BadRequestException(`${field}: должна быть больше нуля`);
  if (Math.abs(n) > MAX_AMOUNT) throw new BadRequestException(`${field}: слишком большая сумма`);
  return round2(n);
}

function parseCurrency(val: unknown): string {
  const c = String(val || '').toUpperCase();
  if (!(FINANCE_CURRENCIES as readonly string[]).includes(c)) {
    throw new BadRequestException(`Валюта должна быть одной из: ${FINANCE_CURRENCIES.join(', ')}`);
  }
  return c;
}

/** «YYYY-MM» → первое число месяца (по Душанбе). */
export function monthStartOf(ym: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
  const [y, m] = ym.split('-').map(Number);
  // Полдень 1-го числа по UTC — заведомо внутри этого дня по Душанбе.
  return tjStartOfMonth(new Date(Date.UTC(y, m - 1, 1, 12)));
}

@Injectable()
export class FinanceAccountsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
  ) {}

  private changed() {
    this.realtime.emitFinanceStaff('finance:accounts', {});
  }

  /** С какого дня ведутся остатки (начало дня по Душанбе) или null — вся история. */
  private async balanceSince(): Promise<Date | null> {
    const cfg = await this.prisma.financeConfig.findUnique({ where: { id: 'default' } });
    return cfg?.balanceSince ?? null;
  }

  async getConfig() {
    const since = await this.balanceSince();
    return { balanceSince: since ? tjLocalDay(since) : null };
  }

  async setConfig(dto: { balanceSince?: string | null }) {
    let since: Date | null = null;
    if (dto?.balanceSince) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dto.balanceSince))) throw new BadRequestException('Дата в формате ГГГГ-ММ-ДД');
      since = tjParseLocalDate(String(dto.balanceSince));
      if (Number.isNaN(since.getTime())) throw new BadRequestException('Неверная дата');
      if (since > tjEndOfDay(new Date())) throw new BadRequestException('Дата начала учёта не может быть в будущем');
    }
    await this.prisma.financeConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', balanceSince: since },
      update: { balanceSince: since },
    });
    this.changed();
    return this.getConfig();
  }

  /**
   * Все живые движения денег по счетам до `until` включительно (без даты —
   * все), плюс сводка по способам оплаты для операций без счёта.
   */
  private async loadLedger(until?: Date) {
    const since = await this.balanceSince();
    const dateWhere = until || since
      ? { date: { ...(since && { gte: since }), ...(until && { lte: until }) } }
      : {};
    const [accounts, maps, txs, transfers] = await Promise.all([
      this.prisma.financeAccount.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.financeChannelMap.findMany(),
      this.prisma.transaction.findMany({
        where: { reversedAt: null, ...dateWhere },
        select: { id: true, type: true, amount: true, accountAmount: true, currency: true, date: true, accountId: true, paymentChannel: true, category: true },
      }),
      this.prisma.financeTransfer.findMany({
        where: { reversedAt: null, ...dateWhere },
        select: { fromAccountId: true, toAccountId: true, amount: true, toAmount: true, date: true },
      }),
    ]);

    // Способ оплаты оплат по сделкам — из самих платежей.
    const lookupIds = txs
      .filter((t) => !t.accountId && !t.paymentChannel && t.category === 'TUITION_PAYMENT')
      .map((t) => t.id);
    const derived = new Map<string, string>();
    if (lookupIds.length) {
      const [subs, pays] = await Promise.all([
        this.prisma.submissionPayment.findMany({
          where: { financeTransactionId: { in: lookupIds } },
          select: { financeTransactionId: true, paymentMethod: true },
        }),
        this.prisma.payment.findMany({
          where: { transactionId: { in: lookupIds } },
          select: { transactionId: true, method: true },
        }),
      ]);
      for (const s of subs) if (s.financeTransactionId) derived.set(s.financeTransactionId, SUBMISSION_METHOD_CHANNEL[s.paymentMethod] ?? 'OTHER');
      for (const p of pays) if (p.transactionId) derived.set(p.transactionId, String(p.method));
    }

    const mapByKey = new Map(maps.map((m) => [`${m.channel}|${m.currency}`, m.accountId]));
    const buckets = new Map<string, ChannelBucket>();
    const rows: LedgerRow[] = [];
    let unassignedCount = 0;
    const unassignedByCurrency: Record<string, { income: number; expense: number }> = {};

    for (const t of txs) {
      const delta = t.type === 'INCOME' ? t.amount : -t.amount;
      if (t.accountId) {
        // Валюта счёта может отличаться от валюты операции ($-оплата на счёт в сомони) —
        // тогда на счёт легла accountAmount.
        const onAccount = t.accountAmount ?? t.amount;
        rows.push({ date: t.date, accountId: t.accountId, delta: t.type === 'INCOME' ? onAccount : -onAccount });
        continue;
      }
      const channel = t.paymentChannel ?? derived.get(t.id) ?? CHANNEL_NONE;
      const key = `${channel}|${t.currency}`;
      const accountId = mapByKey.get(key) ?? null;
      const b = buckets.get(key) ?? { channel, currency: t.currency, count: 0, accountId };
      b.count++;
      buckets.set(key, b);
      if (accountId) {
        rows.push({ date: t.date, accountId, delta });
      } else {
        unassignedCount++;
        const u = (unassignedByCurrency[t.currency] ??= { income: 0, expense: 0 });
        if (t.type === 'INCOME') u.income += t.amount;
        else u.expense += t.amount;
      }
    }
    for (const tr of transfers) {
      rows.push({ date: tr.date, accountId: tr.fromAccountId, delta: -tr.amount });
      rows.push({ date: tr.date, accountId: tr.toAccountId, delta: tr.toAmount });
    }
    for (const u of Object.values(unassignedByCurrency)) {
      u.income = round2(u.income);
      u.expense = round2(u.expense);
    }
    return { accounts, rows, buckets, since, unassigned: { count: unassignedCount, byCurrency: unassignedByCurrency } };
  }

  /** Счета с остатками на сегодня + сколько операций ещё не разложено. */
  async listAccounts() {
    const { accounts, rows, unassigned, since } = await this.loadLedger(tjEndOfDay(new Date()));
    const sum = new Map<string, number>();
    for (const r of rows) sum.set(r.accountId, (sum.get(r.accountId) ?? 0) + r.delta);
    const list = accounts.map((a) => ({
      ...a,
      balance: round2(a.startBalance + (sum.get(a.id) ?? 0)),
    }));
    // Итог по валютам — только по действующим счетам (как карточки «Обзора»).
    const totals: Record<string, number> = {};
    for (const a of list) {
      if (a.archived) continue;
      totals[a.currency] = round2((totals[a.currency] ?? 0) + a.balance);
    }
    return { accounts: list, totals, unassigned, balanceSince: since ? tjLocalDay(since) : null };
  }

  async createAccount(dto: AccountDto) {
    const name = checkText(dto?.name, 'Название', 60);
    if (!name) throw new BadRequestException('Укажите название счёта');
    const kind = dto.kind ?? 'BANK';
    if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) throw new BadRequestException('Вид счёта: банк, наличные или накопления');
    const currency = parseCurrency(dto.currency ?? 'TJS');
    const startBalance = dto.startBalance === undefined ? 0 : parseMoney(dto.startBalance, 'Стартовый остаток', { allowZero: true, allowNegative: true });
    const color = checkText(dto.color, 'Цвет', 20);
    const position = await this.prisma.financeAccount.count();
    // Первый счёт: остатки — с сегодняшнего дня, если дата ещё не задана.
    if (position === 0 && !(await this.balanceSince())) {
      await this.prisma.financeConfig.upsert({
        where: { id: 'default' },
        create: { id: 'default', balanceSince: tjStartOfDay(new Date()) },
        update: { balanceSince: tjStartOfDay(new Date()) },
      });
    }
    const created = await this.prisma.financeAccount.create({
      data: { name, kind: kind as any, currency, startBalance, color, position },
    });
    this.changed();
    return created;
  }

  async updateAccount(id: string, dto: AccountDto) {
    const acc = await this.prisma.financeAccount.findUnique({ where: { id } });
    if (!acc) throw new NotFoundException('Счёт не найден');
    const data: any = {};
    if (dto.name !== undefined) {
      const name = checkText(dto.name, 'Название', 60);
      if (!name) throw new BadRequestException('Укажите название счёта');
      data.name = name;
    }
    if (dto.kind !== undefined) {
      if (!(ACCOUNT_KINDS as readonly string[]).includes(dto.kind)) throw new BadRequestException('Вид счёта: банк, наличные или накопления');
      data.kind = dto.kind;
    }
    if (dto.currency !== undefined) {
      const currency = parseCurrency(dto.currency);
      if (currency !== acc.currency) {
        // Валюта — свойство всех сумм счёта: менять можно, пока на нём ничего нет.
        const [tx, tr, maps] = await Promise.all([
          this.prisma.transaction.count({ where: { accountId: id } }),
          this.prisma.financeTransfer.count({ where: { OR: [{ fromAccountId: id }, { toAccountId: id }] } }),
          this.prisma.financeChannelMap.count({ where: { accountId: id } }),
        ]);
        if (tx + tr + maps > 0) throw new BadRequestException('Валюту можно поменять, только пока на счёте нет операций');
        data.currency = currency;
      }
    }
    if (dto.color !== undefined) data.color = checkText(dto.color, 'Цвет', 20);
    if (dto.startBalance !== undefined) data.startBalance = parseMoney(dto.startBalance, 'Стартовый остаток', { allowZero: true, allowNegative: true });
    if (dto.archived !== undefined) data.archived = !!dto.archived;
    if (dto.position !== undefined) {
      const p = Number(dto.position);
      if (!Number.isInteger(p) || p < 0 || p > 1000) throw new BadRequestException('Порядок: целое число');
      data.position = p;
    }
    const updated = await this.prisma.financeAccount.update({ where: { id }, data });
    this.changed();
    return updated;
  }

  /**
   * Раскладка операций без счёта: каждая пара «способ оплаты · валюта», что
   * встречается в операциях, с числом операций и выбранным счётом.
   */
  async channelMap() {
    const { buckets } = await this.loadLedger();
    const rows = [...buckets.values()].sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));
    return { rows };
  }

  async setChannelMap(dto: { channel?: string; currency?: string; accountId?: string | null }) {
    const channel = String(dto?.channel || '');
    if (!CHANNELS.includes(channel)) throw new BadRequestException('Неизвестный способ оплаты');
    const currency = parseCurrency(dto.currency);
    if (!dto.accountId) {
      await this.prisma.financeChannelMap.deleteMany({ where: { channel, currency } });
      this.changed();
      return { channel, currency, accountId: null };
    }
    const acc = await this.prisma.financeAccount.findUnique({ where: { id: dto.accountId } });
    if (!acc) throw new BadRequestException('Счёт не найден');
    if (acc.currency !== currency) {
      throw new BadRequestException(`Операции в ${currency} можно положить только на счёт в ${currency}`);
    }
    await this.prisma.financeChannelMap.upsert({
      where: { channel_currency: { channel, currency } },
      create: { channel, currency, accountId: acc.id },
      update: { accountId: acc.id },
    });
    this.changed();
    return { channel, currency, accountId: acc.id };
  }

  /**
   * Остаток по дням месяца — сумма по счетам в сомони. Дни после сегодня —
   * null (будущего факта нет).
   */
  async balanceDays(ym: string) {
    const monthStart = monthStartOf(ym);
    const monthEnd = tjEndOfMonth(monthStart);
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const todayEnd = tjEndOfDay(new Date());
    const today = tjLocalDay(new Date());
    const { accounts, rows, since } = await this.loadLedger(todayEnd);
    const sinceDay = since ? tjLocalDay(since) : null;
    const tjs = new Set(accounts.filter((a) => a.currency === 'TJS').map((a) => a.id));
    let balance = accounts.filter((a) => tjs.has(a.id)).reduce((s, a) => s + a.startBalance, 0);
    const perDay = new Map<string, { income: number; expense: number }>();
    for (const r of rows) {
      if (!tjs.has(r.accountId) || r.date > monthEnd) continue;
      if (r.date < monthStart) {
        balance += r.delta;
        continue;
      }
      const day = tjLocalDay(r.date);
      const d = perDay.get(day) ?? { income: 0, expense: 0 };
      if (r.delta >= 0) d.income += r.delta;
      else d.expense -= r.delta;
      perDay.set(day, d);
    }
    const days: Array<{ date: string; balance: number | null; income: number; expense: number }> = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const date = `${ym}-${String(i).padStart(2, '0')}`;
      const d = perDay.get(date) ?? { income: 0, expense: 0 };
      // Будущих дней и дней до начала учёта нет.
      if (date > today || (sinceDay && date < sinceDay)) {
        days.push({ date, balance: null, income: 0, expense: 0 });
        continue;
      }
      balance += d.income - d.expense;
      days.push({ date, balance: round2(balance), income: round2(d.income), expense: round2(d.expense) });
    }
    return { ym, today, since: sinceDay, hasAccounts: tjs.size > 0, days };
  }

  async listTransfers(range: { from?: Date; to?: Date }) {
    return this.prisma.financeTransfer.findMany({
      where: {
        ...(range.from || range.to
          ? { date: { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) } }
          : {}),
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
      include: {
        fromAccount: { select: { id: true, name: true, currency: true, color: true } },
        toAccount: { select: { id: true, name: true, currency: true, color: true } },
      },
    });
  }

  async createTransfer(dto: TransferDto, actorId: string) {
    if (!dto?.fromAccountId || !dto?.toAccountId) throw new BadRequestException('Выберите счёт «откуда» и счёт «куда»');
    if (dto.fromAccountId === dto.toAccountId) throw new BadRequestException('Счета перевода должны различаться');
    const [from, to] = await Promise.all([
      this.prisma.financeAccount.findUnique({ where: { id: dto.fromAccountId } }),
      this.prisma.financeAccount.findUnique({ where: { id: dto.toAccountId } }),
    ]);
    if (!from || !to) throw new BadRequestException('Счёт не найден');
    if (from.archived || to.archived) throw new BadRequestException('Счёт в архиве — верните его из архива');
    const amount = parseMoney(dto.amount, 'Сумма');
    const toAmount = from.currency === to.currency ? amount : parseMoney(dto.toAmount, `Сколько пришло, ${to.currency}`);
    const date = dto.date ? new Date(dto.date) : new Date();
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Неверная дата');
    if (date > tjEndOfDay(new Date())) throw new BadRequestException('Перевод записывает то, что уже было, — дата не может быть в будущем');
    const since = await this.balanceSince();
    if (since && date < since) {
      throw new BadRequestException(`Остатки ведутся с ${tjLocalDay(since).split('-').reverse().join('.')} — более ранний перевод на них не повлияет`);
    }
    const comment = checkText(dto.comment, 'Комментарий', 500);
    const created = await this.prisma.financeTransfer.create({
      data: { fromAccountId: from.id, toAccountId: to.id, amount, toAmount, date, comment, recordedById: actorId },
      include: {
        fromAccount: { select: { id: true, name: true, currency: true, color: true } },
        toAccount: { select: { id: true, name: true, currency: true, color: true } },
      },
    });
    this.changed();
    return created;
  }

  /** Отмена перевода: остаётся в журнале, из остатков исключается. */
  async reverseTransfer(id: string) {
    const tr = await this.prisma.financeTransfer.findUnique({ where: { id } });
    if (!tr) throw new NotFoundException('Перевод не найден');
    if (tr.reversedAt) return tr;
    const updated = await this.prisma.financeTransfer.update({ where: { id }, data: { reversedAt: new Date() } });
    this.changed();
    return updated;
  }

  /** Проверка счёта для операции: существует, не в архиве, валюта совпадает. */
  async accountForTransaction(accountId: string, currency: string | undefined) {
    const acc = await this.prisma.financeAccount.findUnique({ where: { id: accountId } });
    if (!acc) throw new BadRequestException('Счёт не найден');
    if (acc.archived) throw new BadRequestException('Счёт в архиве — выберите другой');
    if (currency && currency.toUpperCase() !== acc.currency) {
      throw new BadRequestException(`Валюта операции (${currency.toUpperCase()}) не совпадает с валютой счёта «${acc.name}» (${acc.currency})`);
    }
    return acc;
  }
}
