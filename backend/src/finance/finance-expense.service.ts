import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SalaryService } from '../salary/salary.service';
import { PartnersService } from '../partners/partners.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { tjEndOfDay, tjEndOfMonth, tjLocalDay, tjParseLocalDate, tjStartOfDay } from '../common/tj-time';
import { FINANCE_CURRENCIES, monthStartOf } from './finance-accounts.service';
import { FinancePayrollService } from './finance-payroll.service';

/**
 * Финансы → «Расход» (часть 2, 10.11.2026): пять статей — Зарплата, Аренда и
 * подписки, Комиссии партнёрам, Долги и кредиты, Прочее.
 *
 * Статья операции: связь с позицией аренды/подписки или с долгом, иначе по
 * категории (SALARY; RENT/SUBSCRIPTION; PARTNER_COMMISSION; LOAN_PAYMENT;
 * остальное — «Прочее»). Суммы — в сомони; расходы в другой валюте — отдельно.
 *
 * «Осталось оплатить» в месяце:
 *   зарплата — начисленное за ПРОШЛЫЙ месяц и ещё не выплаченное (платим
 *     в следующем месяце); дальше — по текущим начислениям;
 *   аренда и подписки — сумма позиций, действующих в месяце, минус оплаты;
 *   комиссии — что начислено партнёрам и ещё не выплачено (только сейчас);
 *   долги — по ежемесячному платежу или к сроку «вернуть до»;
 *   прочее — своя цифра на месяц или среднее прошлых месяцев, минус уже
 *     потраченное в текущем.
 */

export type ExpenseGroup = 'salary' | 'rent' | 'partners' | 'debts' | 'other';
export const EXPENSE_GROUPS: ExpenseGroup[] = ['salary', 'rent', 'partners', 'debts', 'other'];
const OTHER_CATS = ['UTILITIES', 'MARKETING', 'OFFICE', 'MISC_EXPENSE', 'TARGETED_ADS', 'OTHER_EXPENSE'];

const round2 = (n: number) => Math.round(n * 100) / 100;
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function groupOf(t: { category: string; subscriptionId?: string | null; debtId?: string | null }): ExpenseGroup {
  if (t.subscriptionId) return 'rent';
  if (t.debtId) return 'debts';
  switch (t.category) {
    case 'SALARY': return 'salary';
    case 'RENT':
    case 'SUBSCRIPTION': return 'rent';
    case 'PARTNER_COMMISSION': return 'partners';
    case 'LOAN_PAYMENT': return 'debts';
    default: return 'other';
  }
}

export function addYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function ymDiff(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}
const ymOf = (d: Date) => tjLocalDay(d).slice(0, 7);
const currentYm = () => tjLocalDay(new Date()).slice(0, 7);

function text(val: unknown, field: string, max: number, required = false): string | null {
  if (val === undefined || val === null || String(val).trim() === '') {
    if (required) throw new BadRequestException(`${field}: заполните поле`);
    return null;
  }
  const s = String(val).trim();
  if (s.length > max) throw new BadRequestException(`${field}: не длиннее ${max} символов`);
  if (/[<>]/.test(s)) throw new BadRequestException(`${field}: знаки < и > нельзя`);
  return s;
}
function money(val: unknown, field: string, { allowZero = false } = {}): number {
  const n = typeof val === 'string' ? Number(val.replace(/\s/g, '').replace(',', '.')) : Number(val);
  if (val === undefined || val === null || val === '' || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new BadRequestException(`${field}: введите сумму${allowZero ? '' : ' больше нуля'}`);
  }
  if (n > 100_000_000) throw new BadRequestException(`${field}: слишком большая сумма`);
  return round2(n);
}
function ymParam(val: unknown, field: string, required = false): string | null {
  if (val === undefined || val === null || val === '') {
    if (required) throw new BadRequestException(`${field}: выберите месяц`);
    return null;
  }
  if (!YM_RE.test(String(val))) throw new BadRequestException(`${field}: месяц в формате ГГГГ-ММ`);
  return String(val);
}
function payDayParam(val: unknown): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new BadRequestException('День оплаты — число от 1 до 31');
  return n;
}
function currencyParam(val: unknown): string {
  const c = String(val || 'TJS').toUpperCase();
  if (!(FINANCE_CURRENCIES as readonly string[]).includes(c)) throw new BadRequestException('Неизвестная валюта');
  return c;
}

type Money = { tjs: number; foreign: Record<string, number> };
const emptyMoney = (): Money => ({ tjs: 0, foreign: {} });
function addMoney(m: Money, cur: string, v: number) {
  if (cur === 'TJS') m.tjs = round2(m.tjs + v);
  else m.foreign[cur] = round2((m.foreign[cur] ?? 0) + v);
}

export interface SubscriptionDto {
  name?: unknown; kind?: unknown; amount?: unknown; currency?: unknown; payDay?: unknown;
  startYm?: unknown; endYm?: unknown; accountId?: unknown; note?: unknown; archived?: unknown;
}
export interface DebtDto {
  name?: unknown; kind?: unknown; total?: unknown; currency?: unknown; paidBefore?: unknown; monthlyAmount?: unknown;
  payDay?: unknown; startYm?: unknown; dueDate?: unknown; accountId?: unknown; note?: unknown;
}

@Injectable()
export class FinanceExpenseService {
  constructor(
    private prisma: PrismaService,
    private salary: SalaryService,
    private partners: PartnersService,
    private payrollSheet: FinancePayrollService,
    private realtime: RealtimeGateway,
  ) {}

  private changed() {
    this.realtime.emitFinanceStaff('finance:accounts', {});
  }

  // ── факт: расходы по месяцам и статьям ────────────────────────────────
  private async fact(fromYm: string, toYm: string) {
    const txs = await this.prisma.transaction.findMany({
      where: { type: 'EXPENSE', reversedAt: null, date: { gte: monthStartOf(fromYm), lte: tjEndOfMonth(monthStartOf(toYm)) } },
      select: { amount: true, currency: true, date: true, category: true, subscriptionId: true, debtId: true },
    });
    const out = new Map<string, Record<ExpenseGroup, Money>>();
    for (const t of txs) {
      const ym = ymOf(t.date);
      let row = out.get(ym);
      if (!row) {
        row = { salary: emptyMoney(), rent: emptyMoney(), partners: emptyMoney(), debts: emptyMoney(), other: emptyMoney() };
        out.set(ym, row);
      }
      addMoney(row[groupOf(t)], t.currency, t.amount);
    }
    return out;
  }

  // ── зарплата: начислено за месяц и что из этого не выплачено ──────────
  private async payroll(ym: string) {
    // Та же ведомость, что в «Расход → Зарплата»: авансы уменьшают «к выплате».
    const sh = await this.payrollSheet.sheet(ym);
    return { ym, employees: sh.cards.employees, paidCount: sh.cards.paidCount, accrued: sh.cards.accrued, toPay: sh.cards.toPay };
  }

  // ── аренда и подписки ─────────────────────────────────────────────────
  private activeIn(s: { startYm: string; endYm: string | null; archived: boolean }, ym: string) {
    return !s.archived && s.startYm <= ym && (!s.endYm || ym <= s.endYm);
  }

  async subscriptions(ym: string) {
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const from = monthStartOf(ym);
    const to = tjEndOfMonth(from);
    const subs = await this.prisma.financeSubscription.findMany({
      orderBy: [{ archived: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      include: {
        account: { select: { id: true, name: true, currency: true, color: true } },
        transactions: {
          where: { reversedAt: null, date: { gte: from, lte: to } },
          orderBy: { date: 'asc' },
          select: { id: true, amount: true, date: true, account: { select: { id: true, name: true } } },
        },
      },
    });
    let monthly = emptyMoney();
    let toPay = emptyMoney();
    let hidden = 0;
    const rows = [] as any[];
    for (const s of subs) {
      const active = this.activeIn(s, ym);
      if (!active && !s.transactions.length) {
        if (!s.archived) hidden++;
        continue;
      }
      const paid = round2(s.transactions.reduce((x, t) => x + t.amount, 0));
      const due = active ? s.amount : 0;
      const left = round2(Math.max(0, due - paid));
      if (active) {
        addMoney(monthly, s.currency, s.amount);
        addMoney(toPay, s.currency, left);
      }
      rows.push({
        id: s.id, name: s.name, kind: s.kind, amount: s.amount, currency: s.currency, payDay: s.payDay,
        startYm: s.startYm, endYm: s.endYm, note: s.note, archived: s.archived, active, account: s.account,
        paid, left, status: due > 0 && left <= 0.005 ? 'paid' : paid > 0 ? 'partial' : 'none',
        payments: s.transactions.map((t) => ({ id: t.id, amount: t.amount, date: tjLocalDay(t.date), account: t.account })),
      });
    }
    return { ym, rows, monthly, toPay, hidden };
  }

  private async subData(dto: SubscriptionDto, partial: boolean) {
    const data: any = {};
    if (!partial || dto.name !== undefined) data.name = text(dto.name, 'Название', 120, true);
    if (!partial || dto.kind !== undefined) {
      const k = String(dto.kind || 'SUBSCRIPTION');
      if (k !== 'RENT' && k !== 'SUBSCRIPTION') throw new BadRequestException('Тип: аренда или подписка');
      data.kind = k;
    }
    if (!partial || dto.amount !== undefined) data.amount = money(dto.amount, 'Сумма в месяц');
    if (!partial || dto.currency !== undefined) data.currency = currencyParam(dto.currency);
    if (!partial || dto.payDay !== undefined) data.payDay = payDayParam(dto.payDay);
    if (!partial || dto.startYm !== undefined) data.startYm = ymParam(dto.startYm, 'С какого месяца') ?? currentYm();
    if (!partial || dto.endYm !== undefined) data.endYm = ymParam(dto.endYm, 'По какой месяц');
    if (!partial || dto.note !== undefined) data.note = text(dto.note, 'Заметка', 300);
    if (dto.accountId !== undefined || !partial) data.accountId = dto.accountId ? await this.checkAccount(String(dto.accountId)) : null;
    if (partial && dto.archived !== undefined) data.archived = !!dto.archived;
    return data;
  }

  private async checkAccount(id: string) {
    const acc = await this.prisma.financeAccount.findUnique({ where: { id } });
    if (!acc || acc.archived) throw new BadRequestException('Счёт не найден или в архиве');
    return acc.id;
  }

  async createSubscription(dto: SubscriptionDto) {
    const data = await this.subData(dto, false);
    if (data.endYm && data.endYm < data.startYm) throw new BadRequestException('«По какой месяц» раньше «с какого»');
    const position = await this.prisma.financeSubscription.count();
    const created = await this.prisma.financeSubscription.create({ data: { ...data, position } });
    this.changed();
    return created;
  }

  async updateSubscription(id: string, dto: SubscriptionDto) {
    const before = await this.prisma.financeSubscription.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Позиция не найдена');
    const data = await this.subData(dto, true);
    const start = data.startYm ?? before.startYm;
    const end = data.endYm !== undefined ? data.endYm : before.endYm;
    if (end && end < start) throw new BadRequestException('«По какой месяц» раньше «с какого»');
    if (data.currency && data.currency !== before.currency) {
      const used = await this.prisma.transaction.count({ where: { subscriptionId: id } });
      if (used) throw new BadRequestException('По позиции уже были оплаты — валюту не поменять');
    }
    const updated = await this.prisma.financeSubscription.update({ where: { id }, data });
    this.changed();
    return updated;
  }

  // ── долги и кредиты ───────────────────────────────────────────────────
  /** План платежей по долгу на месяцы from..to (только будущее и текущий). */
  private debtPlan(
    d: { total: number; paidBefore: number; monthlyAmount: number | null; startYm: string | null; dueDate: Date | null; createdAt: Date },
    paidTotal: number,
    fromYm: string,
    months: number,
  ) {
    const cur = currentYm();
    const owed = round2(d.total - d.paidBefore);
    let rem = round2(Math.max(0, owed - paidTotal));
    const plan: Record<string, number> = {};
    let overdue = 0;
    if (d.monthlyAmount && d.monthlyAmount > 0) {
      const start = d.startYm || ymOf(d.createdAt);
      const expectedBy = (ym: string) => (ym < start ? 0 : Math.min(owed, d.monthlyAmount! * (ymDiff(start, ym) + 1)));
      overdue = round2(Math.min(rem, Math.max(0, expectedBy(addYm(cur, -1)) - paidTotal)));
      for (let i = 0; i < months; i++) {
        const ym = addYm(fromYm, i);
        if (ym < cur) continue;
        const v = ym === cur
          ? Math.max(0, expectedBy(ym) - paidTotal)
          : Math.max(0, expectedBy(ym) - Math.max(expectedBy(addYm(ym, -1)), paidTotal));
        const take = round2(Math.min(rem, v));
        plan[ym] = take;
        rem = round2(rem - take);
      }
    } else if (d.dueDate) {
      const dueYm = ymOf(d.dueDate);
      if (dueYm < cur) overdue = rem;
      const at = dueYm < cur ? cur : dueYm;
      for (let i = 0; i < months; i++) {
        const ym = addYm(fromYm, i);
        if (ym === at) plan[ym] = rem;
      }
    }
    return { plan, overdue };
  }

  async debts(ym: string) {
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const from = monthStartOf(ym);
    const to = tjEndOfMonth(from);
    const todayStart = tjStartOfDay(new Date());
    const debts = await this.prisma.financeDebt.findMany({
      where: { archived: false },
      orderBy: { createdAt: 'asc' },
      include: {
        account: { select: { id: true, name: true, currency: true, color: true } },
        transactions: {
          where: { reversedAt: null },
          orderBy: { date: 'asc' },
          select: { id: true, amount: true, date: true, account: { select: { id: true, name: true } } },
        },
      },
    });
    const remaining = emptyMoney();
    const paidMonth = emptyMoney();
    const dueMonth = emptyMoney();
    const rows = debts.map((d) => {
      const paidTotal = round2(d.transactions.reduce((x, t) => x + t.amount, 0));
      const left = round2(Math.max(0, d.total - d.paidBefore - paidTotal));
      const { plan, overdue } = this.debtPlan(d, paidTotal, ym, 1);
      const due = plan[ym] ?? 0;
      const inMonth = round2(d.transactions.filter((t) => t.date >= from && t.date <= to).reduce((x, t) => x + t.amount, 0));
      addMoney(remaining, d.currency, left);
      addMoney(paidMonth, d.currency, inMonth);
      addMoney(dueMonth, d.currency, due);
      // ближайший платёж: из плана или к сроку
      let nextDate: string | null = null;
      let nextAmount: number | null = null;
      if (left > 0.005) {
        if (d.monthlyAmount) {
          const p = this.debtPlan(d, paidTotal, currentYm(), 24).plan;
          const first = Object.entries(p).find(([, v]) => v > 0.005);
          if (first) {
            const day = Math.min(d.payDay ?? 1, new Date(Date.UTC(Number(first[0].slice(0, 4)), Number(first[0].slice(5, 7)), 0)).getUTCDate());
            nextDate = `${first[0]}-${String(day).padStart(2, '0')}`;
            nextAmount = first[1];
          }
        } else if (d.dueDate) {
          nextDate = tjLocalDay(d.dueDate);
          nextAmount = left;
        }
      }
      return {
        id: d.id, name: d.name, kind: d.kind, total: d.total, currency: d.currency, paidBefore: d.paidBefore,
        monthlyAmount: d.monthlyAmount, payDay: d.payDay, startYm: d.startYm, dueDate: d.dueDate ? tjLocalDay(d.dueDate) : null,
        note: d.note, account: d.account, paidTotal, left, closed: left <= 0.005,
        late: left > 0.005 && (overdue > 0.005 || (!!d.dueDate && d.dueDate < todayStart)),
        overdue, dueMonth: due, paidMonth: inMonth, nextDate, nextAmount,
        payments: d.transactions.map((t) => ({ id: t.id, amount: t.amount, date: tjLocalDay(t.date), account: t.account })),
      };
    });
    return { ym, rows, stats: { remaining, paidMonth, dueMonth } };
  }

  private async debtData(dto: DebtDto, partial: boolean) {
    const data: any = {};
    if (!partial || dto.name !== undefined) data.name = text(dto.name, 'Кому должны', 120, true);
    if (!partial || dto.kind !== undefined) {
      const k = String(dto.kind || 'PERSON');
      if (k !== 'BANK' && k !== 'PERSON') throw new BadRequestException('Тип: кредит банка или долг');
      data.kind = k;
    }
    if (!partial || dto.total !== undefined) data.total = money(dto.total, 'Сумма долга');
    if (!partial || dto.currency !== undefined) data.currency = currencyParam(dto.currency);
    if (!partial || dto.paidBefore !== undefined) data.paidBefore = dto.paidBefore === undefined || dto.paidBefore === '' || dto.paidBefore === null ? 0 : money(dto.paidBefore, 'Отдали раньше', { allowZero: true });
    if (!partial || dto.monthlyAmount !== undefined) data.monthlyAmount = dto.monthlyAmount === undefined || dto.monthlyAmount === '' || dto.monthlyAmount === null ? null : money(dto.monthlyAmount, 'Платёж в месяц');
    if (!partial || dto.payDay !== undefined) data.payDay = payDayParam(dto.payDay);
    if (!partial || dto.startYm !== undefined) data.startYm = ymParam(dto.startYm, 'С какого месяца платим');
    if (!partial || dto.dueDate !== undefined) {
      if (dto.dueDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dto.dueDate))) throw new BadRequestException('«Вернуть до» — дата ГГГГ-ММ-ДД');
        data.dueDate = tjParseLocalDate(String(dto.dueDate));
      } else data.dueDate = null;
    }
    if (!partial || dto.note !== undefined) data.note = text(dto.note, 'За что', 300);
    if (dto.accountId !== undefined || !partial) data.accountId = dto.accountId ? await this.checkAccount(String(dto.accountId)) : null;
    return data;
  }

  async createDebt(dto: DebtDto) {
    const data = await this.debtData(dto, false);
    if (data.paidBefore > data.total) throw new BadRequestException('«Отдали раньше» больше суммы долга');
    const created = await this.prisma.financeDebt.create({ data });
    this.changed();
    return created;
  }

  async updateDebt(id: string, dto: DebtDto) {
    const before = await this.prisma.financeDebt.findUnique({ where: { id }, include: { transactions: { where: { reversedAt: null }, select: { amount: true } } } });
    if (!before || before.archived) throw new NotFoundException('Долг не найден');
    const data = await this.debtData(dto, true);
    const total = data.total ?? before.total;
    const paidBefore = data.paidBefore ?? before.paidBefore;
    const paid = before.transactions.reduce((x, t) => x + t.amount, 0);
    if (paidBefore + paid > total + 0.005) throw new BadRequestException(`Уже отдали ${round2(paidBefore + paid)} — сумма долга не может быть меньше`);
    if (data.currency && data.currency !== before.currency && before.transactions.length) {
      throw new BadRequestException('По долгу уже были платежи — валюту не поменять');
    }
    const updated = await this.prisma.financeDebt.update({ where: { id }, data });
    this.changed();
    return updated;
  }

  async removeDebt(id: string) {
    const d = await this.prisma.financeDebt.findUnique({ where: { id } });
    if (!d || d.archived) throw new NotFoundException('Долг не найден');
    await this.prisma.financeDebt.update({ where: { id }, data: { archived: true } });
    this.changed();
    return { ok: true };
  }

  // ── комиссии партнёрам ────────────────────────────────────────────────
  async partnersBoard(ym: string) {
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const from = monthStartOf(ym);
    const to = tjEndOfMonth(from);
    const [partners, requests, paid] = await Promise.all([
      this.prisma.partner.findMany({
        where: { OR: [{ balanceCents: { gt: 0 } }, { payouts: { some: { status: 'REQUESTED' } } }] },
        select: { id: true, fullName: true, balanceCents: true, totalPaidCents: true },
        orderBy: { balanceCents: 'desc' },
      }),
      this.prisma.partnerPayout.findMany({
        where: { status: 'REQUESTED' },
        orderBy: { requestedAt: 'asc' },
        include: { partner: { select: { id: true, fullName: true } } },
      }),
      this.prisma.transaction.findMany({
        where: { type: 'EXPENSE', reversedAt: null, category: 'PARTNER_COMMISSION', date: { gte: from, lte: to } },
        orderBy: { date: 'desc' },
        select: { id: true, amount: true, currency: true, date: true, comment: true, account: { select: { id: true, name: true } } },
      }),
    ]);
    const requestedBy = new Map<string, number>();
    for (const r of requests) requestedBy.set(r.partnerId, (requestedBy.get(r.partnerId) ?? 0) + r.amountCents);
    const balance = round2(partners.reduce((x, p) => x + p.balanceCents, 0) / 100);
    const requested = round2(requests.reduce((x, r) => x + r.amountCents, 0) / 100);
    const paidMonth = emptyMoney();
    for (const t of paid) addMoney(paidMonth, t.currency, t.amount);
    return {
      ym,
      waiting: round2(balance + requested),
      balance,
      requested,
      paidMonth,
      partners: partners.map((p) => ({
        id: p.id, name: p.fullName, balance: round2(p.balanceCents / 100),
        requested: round2((requestedBy.get(p.id) ?? 0) / 100), paidTotal: round2(p.totalPaidCents / 100),
      })),
      requests: requests.map((r) => ({
        id: r.id, partner: { id: r.partner.id, name: r.partner.fullName }, amount: round2(r.amountCents / 100),
        currency: r.currency, method: r.method, details: r.details, requestedAt: tjLocalDay(r.requestedAt),
      })),
      payments: paid.map((t) => ({ id: t.id, amount: t.amount, currency: t.currency, date: tjLocalDay(t.date), comment: t.comment, account: t.account })),
    };
  }

  async payPartnerPayout(me: { id: string }, id: string, dto: { accountId?: string; date?: string; receiptUrl?: string }) {
    if (!dto?.accountId) throw new BadRequestException('Выберите счёт, с которого платите');
    let date = new Date();
    if (dto.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dto.date))) throw new BadRequestException('Дата в формате ГГГГ-ММ-ДД');
      date = tjParseLocalDate(String(dto.date));
      if (date > tjEndOfDay(new Date())) throw new BadRequestException('Дата выплаты не может быть в будущем');
    }
    const receiptUrl = typeof dto.receiptUrl === 'string' && dto.receiptUrl.startsWith('/uploads/') ? dto.receiptUrl : null;
    const res = await this.partners.adminMarkPayout(id, 'paid', { accountId: dto.accountId, date, recordedById: me.id, receiptUrl });
    this.realtime.emitFinanceStaff('transaction:new', {});
    this.changed();
    return res;
  }

  // ── прочее ────────────────────────────────────────────────────────────
  /** Среднее «Прочего» по прошлым месяцам (не больше 12), начиная с первого месяца с расходами. */
  private async otherAverage() {
    const cur = currentYm();
    const fromYm = addYm(cur, -12);
    const f = await this.fact(fromYm, addYm(cur, -1));
    const months = [...f.keys()].sort();
    if (!months.length) return { avg: 0, months: 0, from: null as string | null, to: null as string | null };
    const first = months[0];
    const n = ymDiff(first, cur);
    let sum = 0;
    for (const [, g] of f) sum += g.other.tjs;
    return { avg: n > 0 ? round2(sum / n) : 0, months: n, from: first, to: addYm(cur, -1) };
  }

  private async otherPlans(fromYm: string, months: number) {
    const yms = Array.from({ length: months }, (_, i) => addYm(fromYm, i));
    const rows = await this.prisma.financeOtherPlan.findMany({ where: { ym: { in: yms } } });
    return new Map(rows.map((r) => [r.ym, r.amount]));
  }

  async other(ym: string) {
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const from = monthStartOf(ym);
    const to = tjEndOfMonth(from);
    const txs = await this.prisma.transaction.findMany({
      where: { type: 'EXPENSE', reversedAt: null, date: { gte: from, lte: to }, subscriptionId: null, debtId: null, category: { in: OTHER_CATS as any } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, amount: true, currency: true, date: true, category: true, comment: true,
        account: { select: { id: true, name: true } }, paidVia: { select: { id: true, fullName: true } },
      },
    });
    const byCat = new Map<string, { category: string; tjs: number; foreign: Record<string, number>; count: number }>();
    const spent = emptyMoney();
    for (const t of txs) {
      const c = byCat.get(t.category) ?? { category: t.category, tjs: 0, foreign: {}, count: 0 };
      c.count++;
      if (t.currency === 'TJS') c.tjs = round2(c.tjs + t.amount);
      else c.foreign[t.currency] = round2((c.foreign[t.currency] ?? 0) + t.amount);
      byCat.set(t.category, c);
      addMoney(spent, t.currency, t.amount);
    }
    const avg = await this.otherAverage();
    const cur = currentYm();
    const plans = await this.otherPlans(cur, 12);
    const own = await this.prisma.financeOtherPlan.findUnique({ where: { ym } });
    return {
      ym,
      spent,
      plan: own ? own.amount : avg.avg,
      planSource: own ? 'own' : 'avg',
      average: avg,
      byCategory: [...byCat.values()].sort((a, b) => b.tjs - a.tjs),
      rows: txs.map((t) => ({ id: t.id, amount: t.amount, currency: t.currency, date: tjLocalDay(t.date), category: t.category, comment: t.comment, account: t.account, paidVia: t.paidVia })),
      plans: Array.from({ length: 12 }, (_, i) => {
        const m = addYm(cur, i);
        return { ym: m, amount: plans.get(m) ?? null };
      }),
    };
  }

  async setOtherPlan(dto: { ym?: unknown; amount?: unknown }) {
    const ym = ymParam(dto?.ym, 'Месяц', true)!;
    if (ym < currentYm()) throw new BadRequestException('План — только на текущий и будущие месяцы');
    if (dto.amount === null || dto.amount === undefined || dto.amount === '') {
      await this.prisma.financeOtherPlan.deleteMany({ where: { ym } });
    } else {
      const amount = money(dto.amount, 'План', { allowZero: true });
      await this.prisma.financeOtherPlan.upsert({ where: { ym }, create: { ym, amount }, update: { amount } });
    }
    this.changed();
    return { ok: true };
  }

  // ── сводка, план вперёд, график ───────────────────────────────────────
  /** Сколько осталось оплатить по статьям на months месяцев от текущего. */
  private async planAhead(months: number, payrollPrev?: Awaited<ReturnType<FinanceExpenseService['payroll']>>) {
    const cur = currentYm();
    const yms = Array.from({ length: months }, (_, i) => addYm(cur, i));
    const pr = payrollPrev ?? (await this.payroll(addYm(cur, -1)));
    const [subs, debts, partners, plans, avg, factCur] = await Promise.all([
      this.prisma.financeSubscription.findMany({
        where: { archived: false },
        include: { transactions: { where: { reversedAt: null, date: { gte: monthStartOf(cur), lte: tjEndOfMonth(monthStartOf(cur)) } }, select: { amount: true } } },
      }),
      this.prisma.financeDebt.findMany({ where: { archived: false }, include: { transactions: { where: { reversedAt: null }, select: { amount: true } } } }),
      this.partnersBoard(cur),
      this.otherPlans(cur, months),
      this.otherAverage(),
      this.fact(cur, cur),
    ]);
    const spentOther = factCur.get(cur)?.other.tjs ?? 0;
    const out = yms.map((ym, i) => {
      const row: Record<ExpenseGroup, number> & { ym: string; otherSource: 'own' | 'avg' } = {
        ym, salary: 0, rent: 0, partners: 0, debts: 0, other: 0, otherSource: plans.has(ym) ? 'own' : 'avg',
      };
      row.salary = i === 0 ? pr.toPay : pr.accrued;
      for (const s of subs) {
        if (s.currency !== 'TJS' || !this.activeIn(s, ym)) continue;
        const paid = i === 0 ? s.transactions.reduce((x, t) => x + t.amount, 0) : 0;
        row.rent += Math.max(0, s.amount - paid);
      }
      row.partners = i === 0 ? partners.waiting : 0;
      const otherPlan = plans.get(ym) ?? avg.avg;
      row.other = i === 0 ? Math.max(0, otherPlan - spentOther) : otherPlan;
      return row;
    });
    for (const d of debts) {
      if (d.currency !== 'TJS') continue;
      const paidTotal = d.transactions.reduce((x, t) => x + t.amount, 0);
      const { plan } = this.debtPlan(d, paidTotal, cur, months);
      for (const r of out) r.debts += plan[r.ym] ?? 0;
    }
    for (const r of out) for (const g of EXPENSE_GROUPS) r[g] = round2(r[g]);
    return { rows: out, payroll: pr, average: avg };
  }

  async summary(ym: string) {
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const cur = currentYm();
    const [f, pay, subs, debts, partners, other] = await Promise.all([
      this.fact(ym, ym),
      this.payroll(addYm(ym, -1)),
      this.subscriptions(ym),
      this.debts(ym),
      this.partnersBoard(ym),
      this.other(ym),
    ]);
    const fact = f.get(ym) ?? { salary: emptyMoney(), rent: emptyMoney(), partners: emptyMoney(), debts: emptyMoney(), other: emptyMoney() };
    const active = subs.rows.filter((r: any) => r.active);
    return {
      ym,
      current: cur,
      fact,
      cards: {
        salary: { forYm: pay.ym, employees: pay.employees, paidCount: pay.paidCount, accrued: pay.accrued, toPay: pay.toPay, paid: fact.salary.tjs },
        rent: { count: active.length, paidCount: active.filter((r: any) => r.status === 'paid').length, toPay: subs.toPay.tjs, monthly: subs.monthly.tjs, paid: fact.rent.tjs },
        partners: { waiting: partners.waiting, partners: partners.partners.length, requests: partners.requests.length, paid: fact.partners.tjs },
        debts: {
          toPay: ym >= cur ? debts.stats.dueMonth.tjs : 0,
          paid: fact.debts.tjs,
          remaining: debts.stats.remaining.tjs,
          count: debts.rows.filter((r) => !r.closed).length,
          dueNames: debts.rows.filter((r) => r.dueMonth > 0.005).map((r) => r.name).slice(0, 3),
          overdue: round2(debts.rows.reduce((x, r) => x + (r.currency === 'TJS' ? r.overdue : 0), 0)),
        },
        other: { spent: other.spent.tjs, plan: other.plan, planSource: other.planSource, paid: fact.other.tjs },
      },
    };
  }

  async plan(months: number) {
    const n = [3, 6, 12].includes(months) ? months : 3;
    const r = await this.planAhead(n);
    return { months: n, rows: r.rows, average: r.average, payroll: { ym: r.payroll.ym, accrued: r.payroll.accrued, toPay: r.payroll.toPay } };
  }

  /** График: 6 месяцев до выбранного + выбранный + 5 вперёд; прошлое — факт, текущий — факт + осталось, будущее — план. */
  async chart(ym: string) {
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const cur = currentYm();
    const first = addYm(ym, -5);
    const last = addYm(ym, 6);
    const f = await this.fact(first, last < cur ? last : cur);
    const ahead = last >= cur ? (await this.planAhead(Math.min(12, ymDiff(cur, last) + 1))).rows : [];
    const aheadBy = new Map(ahead.map((r) => [r.ym, r]));
    const rows = Array.from({ length: 12 }, (_, i) => {
      const m = addYm(first, i);
      const kind = m < cur ? 'fact' : m === cur ? 'current' : 'plan';
      const fr = f.get(m);
      const pr = aheadBy.get(m);
      const groups = {} as Record<ExpenseGroup, number>;
      for (const g of EXPENSE_GROUPS) {
        const factV = kind === 'plan' ? 0 : (fr?.[g].tjs ?? 0);
        const leftV = kind === 'fact' ? 0 : (pr?.[g] ?? 0);
        groups[g] = round2(factV + leftV);
      }
      return { ym: m, kind, groups, total: round2(EXPENSE_GROUPS.reduce((x, g) => x + groups[g], 0)) };
    });
    return { ym, current: cur, rows };
  }
}
