import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { tjEndOfMonth, tjLocalDay, tjStartOfDay } from '../common/tj-time';
import { monthStartOf } from './finance-accounts.service';
import { FinanceExpenseService, groupOf, addYm } from './finance-expense.service';
import { FinancePayrollService } from './finance-payroll.service';
import { directionOf } from './finance-income.service';

/**
 * Финансы → «Планирование» (часть 3, 11.11.2026): календарь месяца — что
 * пришло и ушло (факт) и что ещё ждём (план), просрочки.
 *
 * Приходы: оплаты по факту; неоплаченные этапы сделок — в день срока.
 * Расходы: по факту; зарплата за прошлый месяц — 10-го; аренда и подписки — в
 * свой день; кредиты и долги — по плану; заявки партнёров на вывод.
 * Напоминания (колокольчик): за 3 дня до срока и в первый день просрочки.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const DIR_LABEL: Record<string, string> = { CONTRACT: 'Контракт', ACADEMY: 'Академия', MASTERCLASS: 'Мастер-класс', OTHER: 'Доход' };
const GRP_LABEL: Record<string, string> = { salary: 'Зарплата', rent: 'Аренда и подписки', partners: 'Выплата партнёру', debts: 'Долг', other: 'Расход' };

export interface PlanItem {
  id: string;
  kind: 'stage' | 'income' | 'expense' | 'salary' | 'subscription' | 'debt' | 'payout';
  dir: 'in' | 'out';
  date: string;
  name: string;
  amount: number;
  currency: string;
  status: 'done' | 'wait' | 'late';
  ref?: Record<string, unknown>;
}

const dayIn = (ym: string, day: number | null | undefined) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(Math.min(Math.max(1, day || 1), last)).padStart(2, '0')}`;
};

@Injectable()
export class FinancePlanningService {
  private readonly logger = new Logger(FinancePlanningService.name);

  constructor(
    private prisma: PrismaService,
    private expense: FinanceExpenseService,
    private payroll: FinancePayrollService,
    private notifications: NotificationsService,
  ) {}

  async month(ym: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const from = monthStartOf(ym);
    const to = tjEndOfMonth(from);
    const today = tjLocalDay(new Date());
    const curYm = today.slice(0, 7);
    const status = (date: string): 'wait' | 'late' => (date < today ? 'late' : 'wait');
    const items: PlanItem[] = [];
    const overdueOld: PlanItem[] = [];

    // ── факт: операции месяца ──
    const txs = await this.prisma.transaction.findMany({
      where: { reversedAt: null, date: { gte: from, lte: to } },
      select: {
        id: true, type: true, category: true, amount: true, currency: true, date: true, comment: true, payerName: true,
        productCategoryEnum: true, subscriptionId: true, debtId: true, student: { select: { fullName: true } }, manager: { select: { fullName: true } },
      },
    });
    const grouped = new Map<string, PlanItem>();
    for (const t of txs) {
      const date = tjLocalDay(t.date);
      if (t.type === 'INCOME') {
        items.push({
          id: `tx-${t.id}`, kind: 'income', dir: 'in', date, currency: t.currency, amount: t.amount, status: 'done',
          name: t.student?.fullName || t.payerName || t.comment || DIR_LABEL[directionOf(t)], ref: { txId: t.id },
        });
        continue;
      }
      const g = groupOf(t);
      if (g === 'salary' || g === 'partners') {
        const key = `${date}|${g}|${t.currency}`;
        const it = grouped.get(key) ?? { id: `grp-${key}`, kind: 'expense', dir: 'out', date, currency: t.currency, amount: 0, status: 'done', name: GRP_LABEL[g], ref: { count: 0, group: g } } as PlanItem;
        it.amount = round2(it.amount + t.amount);
        (it.ref as any).count++;
        grouped.set(key, it);
        continue;
      }
      items.push({ id: `tx-${t.id}`, kind: 'expense', dir: 'out', date, currency: t.currency, amount: t.amount, status: 'done', name: t.comment || GRP_LABEL[g], ref: { txId: t.id, group: g } });
    }
    items.push(...grouped.values());

    // ── план: неоплаченные этапы сделок ──
    const subs = await this.prisma.saleSubmission.findMany({
      where: { status: 'ACTIVE', paymentStages: { some: { status: { not: 'PAID' }, dueDate: { lte: to } } } },
      select: {
        id: true, totalAmount: true, currency: true, newStudentName: true, managerId: true,
        student: { select: { fullName: true } },
        paymentStages: { orderBy: { order: 'asc' }, select: { id: true, order: true, amount: true, dueDate: true, status: true } },
        payments: { where: { status: 'APPROVED' }, select: { amount: true } },
      },
    });
    for (const s of subs) {
      const A = s.payments.reduce((x, p) => x + p.amount, 0);
      const name = s.student?.fullName || s.newStudentName || '—';
      const cur = (s.currency || 'TJS').toUpperCase();
      let cum = 0;
      for (const st of s.paymentStages) {
        cum = round2(cum + st.amount);
        if (st.status === 'PAID') continue;
        const uncovered = round2(Math.min(st.amount, Math.max(0, cum - A)));
        if (uncovered <= 0.005) continue;
        const date = tjLocalDay(st.dueDate);
        if (date > tjLocalDay(to)) continue;
        const it: PlanItem = {
          id: `stage-${st.id}`, kind: 'stage', dir: 'in', date, currency: cur, amount: uncovered, status: status(date),
          name: `${name} · этап ${st.order}`,
          ref: { submissionId: s.id, stageId: st.id, name, currency: cur, dueAmount: uncovered, left: round2(Math.max(0, s.totalAmount - A)),
            stageOrder: st.order, stagesCount: s.paymentStages.length, managerId: s.managerId },
        };
        if (date < tjLocalDay(from)) overdueOld.push(it);
        else items.push(it);
      }
    }

    // ── план расходов: только для текущего и будущих месяцев ──
    if (ym >= curYm) {
      const prev = addYm(ym, -1);
      const [sheet, subsList, debts, partners] = await Promise.all([
        this.payroll.sheet(prev),
        this.expense.subscriptions(ym),
        this.expense.debts(ym),
        this.expense.partnersBoard(ym),
      ]);
      if (sheet.cards.toPay > 0.005) {
        const date = dayIn(ym, 10);
        items.push({ id: `salary-${prev}`, kind: 'salary', dir: 'out', date, currency: 'TJS', amount: sheet.cards.toPay, status: status(date),
          name: `Зарплата за ${prev} · осталось`, ref: { ym: prev } });
      }
      for (const r of subsList.rows as any[]) {
        if (!r.active || r.left <= 0.005) continue;
        const date = dayIn(ym, r.payDay);
        items.push({ id: `sub-${r.id}`, kind: 'subscription', dir: 'out', date, currency: r.currency, amount: r.left, status: status(date), name: r.name,
          ref: { id: r.id, name: r.name, kind: r.kind, currency: r.currency, amount: r.amount, paid: r.paid, left: r.left, accountId: r.account?.id ?? null } });
      }
      for (const d of debts.rows) {
        if (d.closed || d.dueMonth <= 0.005) continue;
        const date = d.dueDate && d.dueDate.slice(0, 7) === ym ? d.dueDate : dayIn(ym, d.payDay);
        items.push({ id: `debt-${d.id}`, kind: 'debt', dir: 'out', date, currency: d.currency, amount: d.dueMonth, status: status(date), name: d.name,
          ref: { id: d.id, name: d.name, currency: d.currency, left: d.left, dueMonth: d.dueMonth, accountId: d.account?.id ?? null } });
      }
      if (ym === curYm) {
        for (const r of partners.requests) {
          const date = r.requestedAt.slice(0, 7) === ym ? r.requestedAt : today;
          items.push({ id: `payout-${r.id}`, kind: 'payout', dir: 'out', date, currency: r.currency, amount: r.amount, status: 'wait', name: `Вывод «${r.partner.name}»`, ref: { id: r.id } });
        }
      }
    }

    items.sort((a, b) => a.date.localeCompare(b.date) || (a.dir === b.dir ? 0 : a.dir === 'in' ? -1 : 1));
    const add = (m: Record<string, number>, cur: string, v: number) => (m[cur] = round2((m[cur] ?? 0) + v));
    const kpi = { in: { done: {} as Record<string, number>, wait: {} as Record<string, number> }, out: { done: {} as Record<string, number>, wait: {} as Record<string, number> } };
    for (const it of items) add(kpi[it.dir][it.status === 'done' ? 'done' : 'wait'], it.currency, it.amount);
    const overdue = [...overdueOld, ...items.filter((i) => i.status === 'late')]
      .map((i) => ({ ...i, days: Math.max(1, Math.round((Date.parse(today) - Date.parse(i.date)) / 86_400_000)) }))
      .sort((a, b) => b.days - a.days);
    return { ym, today, items, kpi, overdue };
  }

  /** Основателю, админам и бухгалтеру. */
  private async notifyFinance(data: { type: string; title: string; message: string; payload?: any }) {
    await this.notifications.notifyAdmins(data);
    const founders = await this.prisma.user.findMany({
      where: { isActive: true, OR: [{ role: 'FOUNDER' }, { roles: { has: 'FOUNDER' } }] },
      select: { id: true },
    });
    for (const f of founders) await this.notifications.notifyUser(f.id, data);
  }

    /** Напоминания в колокольчик: за 3 дня до срока и в первый день просрочки. */
  @Cron('0 9 * * *', { timeZone: 'Asia/Dushanbe' })
  async remind() {
    try {
      const today = tjLocalDay(new Date());
      const in3 = tjLocalDay(new Date(tjStartOfDay(new Date()).getTime() + 3 * 86_400_000 + 3_600_000));
      const yesterday = tjLocalDay(new Date(tjStartOfDay(new Date()).getTime() - 12 * 3_600_000));
      const yms = [...new Set([today.slice(0, 7), in3.slice(0, 7)])];
      const all: PlanItem[] = [];
      for (const ym of yms) all.push(...(await this.month(ym)).items.filter((i) => i.status !== 'done'));
      const soon = all.filter((i) => i.date === in3);
      const late = all.filter((i) => i.date === yesterday);
      const fmt = (i: PlanItem) => `${i.name} · ${i.dir === 'in' ? '+' : '−'}${i.amount.toLocaleString('ru-RU')} ${i.currency}`;
      if (soon.length) {
        await this.notifyFinance({ type: 'finance:plan-soon', title: `Через 3 дня — платежей: ${soon.length}`, message: soon.slice(0, 5).map(fmt).join('\n'), payload: { link: `/finance/planning?ym=${in3.slice(0, 7)}` } });
      }
      if (late.length) {
        await this.notifyFinance({ type: 'finance:plan-late', title: `Просрочено платежей: ${late.length}`, message: late.slice(0, 5).map(fmt).join('\n'), payload: { link: `/finance/planning?ym=${yesterday.slice(0, 7)}` } });
      }
    } catch (e) {
      this.logger.error(`Напоминания планирования не отправлены: ${(e as Error).message}`);
    }
  }
}
