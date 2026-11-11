import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubmissionsService } from '../submissions/submissions.service';
import { isFounder, roleAllows } from '../auth/role-utils';
import { tjEndOfDay, tjEndOfMonth, tjLocalDay, tjParseLocalDate, tjStartOfDay } from '../common/tj-time';
import { monthStartOf } from './finance-accounts.service';

/**
 * Финансы → «Доход» (часть 2, 10.11.2026): четыре направления — Контракты
 * (сделки и их этапы оплат), Академия, Мастер-классы, Прочее.
 *
 * Направление операции — productCategoryEnum; у старых оплат без него
 * (TUITION_PAYMENT) — «Контракты», остальное — «Прочее» (как на «Обзоре»).
 *
 * Сумма в сомони у оплаты в другой валюте — то, что основатель указал при
 * одобрении (SubmissionPayment.amountTjs), или сумма, легшая на счёт в
 * сомони (accountAmount). Без них оплата идёт отдельной строкой в своей валюте.
 *
 * «Ждём» по сделке — непогашенная часть этапов со сроком до конца месяца
 * (просроченные из прошлых месяцев тоже). Этап гасится только целиком
 * накопленной суммой одобренных платежей (InstallmentsService.settleStagesTx),
 * поэтому непогашенная часть этапа = накопленная сумма этапов − одобрено.
 */

export type Direction = 'CONTRACT' | 'ACADEMY' | 'MASTERCLASS' | 'OTHER';
export const DIRECTIONS: Direction[] = ['CONTRACT', 'ACADEMY', 'MASTERCLASS', 'OTHER'];

const round2 = (n: number) => Math.round(n * 100) / 100;
const add = (m: Record<string, number>, cur: string, v: number) => {
  m[cur] = round2((m[cur] ?? 0) + v);
};
const DAY = 86_400_000;

export interface AcceptPaymentDto {
  amount?: unknown;
  paidAt?: string;
  accountId?: string;
  amountTjs?: unknown;
  receiptUrls?: string[];
  notes?: string;
}

export function directionOf(t: { productCategoryEnum: string | null; category: string }): Direction {
  if (t.productCategoryEnum && (DIRECTIONS as string[]).includes(t.productCategoryEnum)) return t.productCategoryEnum as Direction;
  return t.category === 'TUITION_PAYMENT' ? 'CONTRACT' : 'OTHER';
}

function money(val: unknown, field: string): number {
  const n = typeof val === 'string' ? Number(val.replace(/\s/g, '').replace(',', '.')) : Number(val);
  if (val === undefined || val === null || val === '' || !Number.isFinite(n) || n <= 0) {
    throw new BadRequestException(`${field}: введите сумму больше нуля`);
  }
  if (n > 100_000_000) throw new BadRequestException(`${field}: слишком большая сумма`);
  return round2(n);
}

@Injectable()
export class FinanceIncomeService {
  constructor(
    private prisma: PrismaService,
    private submissions: SubmissionsService,
  ) {}

  async income(ym: string) {
    const from = monthStartOf(ym);
    const to = tjEndOfMonth(from);
    const todayStart = tjStartOfDay(new Date());
    const today = tjLocalDay(new Date());

    // ── оплаты месяца по направлениям ──
    const txs = await this.prisma.transaction.findMany({
      where: { type: 'INCOME', reversedAt: null, date: { gte: from, lte: to } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, amount: true, currency: true, date: true, category: true, productCategoryEnum: true,
        comment: true, payerName: true, accountAmount: true, paymentChannel: true,
        student: { select: { id: true, fullName: true } },
        account: { select: { id: true, name: true, currency: true, color: true } },
      },
    });
    const foreignIds = txs.filter((t) => t.currency !== 'TJS').map((t) => t.id);
    const tjsById = new Map<string, number>();
    if (foreignIds.length) {
      const pays = await this.prisma.submissionPayment.findMany({
        where: { financeTransactionId: { in: foreignIds }, amountTjs: { not: null } },
        select: { financeTransactionId: true, amountTjs: true },
      });
      for (const p of pays) if (p.financeTransactionId && p.amountTjs != null) tjsById.set(p.financeTransactionId, p.amountTjs);
    }
    const tjsOf = (t: (typeof txs)[number]): number | null => {
      if (t.currency === 'TJS') return t.amount;
      if (tjsById.has(t.id)) return tjsById.get(t.id)!;
      if (t.accountAmount != null && t.account?.currency === 'TJS') return t.accountAmount;
      return null;
    };

    const dirs = new Map<Direction, { key: Direction; tjs: number; foreign: Record<string, number>; count: number }>();
    for (const k of DIRECTIONS) dirs.set(k, { key: k, tjs: 0, foreign: {}, count: 0 });
    const received = { byCurrency: {} as Record<string, number>, tjs: 0, noRate: {} as Record<string, number>, count: 0 };
    const rows: Array<{
      id: string; direction: Direction; date: Date; amount: number; currency: string; tjs: number | null;
      who: string | null; studentId: string | null; comment: string | null;
      account: { id: string; name: string; currency: string; color: string | null } | null;
    }> = [];
    for (const t of txs) {
      const dir = directionOf(t);
      const d = dirs.get(dir)!;
      const v = tjsOf(t);
      d.count++;
      if (v != null) d.tjs = round2(d.tjs + v);
      else add(d.foreign, t.currency, t.amount);
      if (dir === 'CONTRACT') {
        received.count++;
        add(received.byCurrency, t.currency, t.amount);
        if (v != null) received.tjs = round2(received.tjs + v);
        else add(received.noRate, t.currency, t.amount);
      }
      rows.push({
        id: t.id, direction: dir, date: t.date, amount: t.amount, currency: t.currency, tjs: v,
        who: t.student?.fullName || t.payerName || null, studentId: t.student?.id ?? null,
        comment: t.comment, account: t.account,
      });
    }

    // ── сделки: ждём оплату / оплачено в месяце ──
    const subs = await this.prisma.saleSubmission.findMany({
      where: {
        OR: [
          { status: 'ACTIVE', paymentStages: { some: { status: { not: 'PAID' }, dueDate: { lte: to } } } },
          // Отменённая сделка — деньги возвращены, в «оплачено» её нет.
          { status: { not: 'CANCELLED' }, payments: { some: { status: 'APPROVED', paidAt: { gte: from, lte: to } } } },
        ],
      },
      select: {
        id: true, totalAmount: true, currency: true, status: true, newStudentName: true,
        student: { select: { id: true, fullName: true } },
        program: { select: { name: true, country: true, university: true } },
        manager: { select: { id: true, fullName: true } },
        paymentStages: { orderBy: { order: 'asc' }, select: { order: true, amount: true, dueDate: true, status: true } },
        payments: { orderBy: { paidAt: 'asc' }, select: { id: true, amount: true, paidAt: true, status: true } },
      },
    });

    const waiting = { byCurrency: {} as Record<string, number>, overdue: {} as Record<string, number>, deals: 0, overdueDeals: 0 };
    const overdueList: Array<{ submissionId: string; name: string; days: number; amount: number; currency: string }> = [];
    const contractRows: any[] = [];
    for (const s of subs) {
      const cur = (s.currency || 'TJS').toUpperCase();
      const approved = s.payments.filter((p) => p.status === 'APPROVED');
      const pending = s.payments.filter((p) => p.status === 'PENDING');
      const A = round2(approved.reduce((x, p) => x + p.amount, 0));
      let cum = 0;
      let dueStage: { order: number; dueDate: Date; uncovered: number } | null = null;
      let firstOverdue: Date | null = null;
      let wait = 0;
      let over = 0;
      let nextDue: Date | null = null;
      for (const st of s.paymentStages) {
        cum = round2(cum + st.amount);
        if (st.status === 'PAID') continue;
        const uncovered = round2(Math.min(st.amount, Math.max(0, cum - A)));
        if (uncovered <= 0.005) continue;
        if (!dueStage) dueStage = { order: st.order, dueDate: st.dueDate, uncovered };
        if (!nextDue) nextDue = st.dueDate;
        if (s.status === 'ACTIVE' && st.dueDate <= to) {
          wait = round2(wait + uncovered);
          if (st.dueDate < todayStart) {
            over = round2(over + uncovered);
            if (!firstOverdue) firstOverdue = st.dueDate;
          }
        }
      }
      const inMonth = approved.filter((p) => p.paidAt >= from && p.paidAt <= to);
      const paidInMonth = round2(inMonth.reduce((x, p) => x + p.amount, 0));
      const group = wait > 0 ? 'waiting' : inMonth.length ? 'paid' : null;
      if (!group) continue;
      const name = s.student?.fullName || s.newStudentName || '—';
      if (wait > 0) {
        add(waiting.byCurrency, cur, wait);
        waiting.deals++;
      }
      if (over > 0) {
        add(waiting.overdue, cur, over);
        waiting.overdueDeals++;
        overdueList.push({
          submissionId: s.id, name, currency: cur, amount: over,
          days: Math.max(1, Math.round((todayStart.getTime() - tjStartOfDay(firstOverdue!).getTime()) / DAY)),
        });
      }
      const dueDay = dueStage ? tjLocalDay(dueStage.dueDate) : null;
      contractRows.push({
        submissionId: s.id,
        group,
        name,
        studentId: s.student?.id ?? null,
        program: s.program ? [s.program.country, s.program.name].filter(Boolean).join(' · ') : null,
        manager: s.manager ? { id: s.manager.id, name: s.manager.fullName } : null,
        total: s.totalAmount,
        currency: cur,
        status: s.status,
        stagesCount: s.paymentStages.length,
        stageOrder: dueStage ? dueStage.order : null,
        paidTotal: A,
        left: round2(Math.max(0, s.totalAmount - A)),
        payments: approved.map((p) => ({ amount: p.amount, date: tjLocalDay(p.paidAt) })),
        dueDate: dueDay,
        dueDays: dueDay ? Math.round((Date.parse(dueDay) - Date.parse(today)) / DAY) : null,
        dueAmount: dueStage ? dueStage.uncovered : null,
        waiting: wait,
        overdue: over,
        paidInMonth,
        lastPaidAt: inMonth.length ? tjLocalDay(inMonth[inMonth.length - 1].paidAt) : null,
        nextDueDate: nextDue ? tjLocalDay(nextDue) : null,
        pendingCount: pending.length,
        pendingSum: round2(pending.reduce((x, p) => x + p.amount, 0)),
      });
    }
    // ждём — по сроку (просроченные первыми), оплачено — по дате оплаты
    contractRows.sort((a, b) =>
      a.group !== b.group
        ? (a.group === 'waiting' ? -1 : 1)
        : a.group === 'waiting'
          ? String(a.dueDate).localeCompare(String(b.dueDate))
          : String(b.lastPaidAt).localeCompare(String(a.lastPaidAt)),
    );
    overdueList.sort((a, b) => b.days - a.days);

    // ── ждут одобрения (все действующие сделки, не только месяц) ──
    const pendingPays = await this.prisma.submissionPayment.findMany({
      where: { status: 'PENDING', submission: { status: 'ACTIVE' } },
      select: { amount: true, submission: { select: { currency: true } } },
    });
    const pending = { count: pendingPays.length, byCurrency: {} as Record<string, number> };
    for (const p of pendingPays) add(pending.byCurrency, (p.submission.currency || 'TJS').toUpperCase(), p.amount);

    const footer = { deals: contractRows.length, total: {} as Record<string, number>, paidInMonth: {} as Record<string, number>, waiting: waiting.byCurrency };
    for (const r of contractRows) {
      add(footer.total, r.currency, r.total);
      if (r.paidInMonth) add(footer.paidInMonth, r.currency, r.paidInMonth);
    }

    return {
      ym,
      from: tjLocalDay(from),
      to: tjLocalDay(to),
      today,
      directions: DIRECTIONS.map((k) => dirs.get(k)!),
      contracts: { waiting, received, pending, overdue: overdueList, rows: contractRows, footer },
      payments: rows.filter((r) => r.direction !== 'CONTRACT'),
    };
  }

  /**
   * «Принять оплату» по сделке из Финансов: платёж с указанным счётом. Кто
   * может одобрять платежи — одобряет сразу (доход встаёт на счёт, этапы
   * гасятся, комиссия партнёру — как при обычном одобрении). Остальные —
   * платёж ждёт одобрения основателя, счёт уже предвыбран.
   */
  async acceptContractPayment(me: any, submissionId: string, dto: AcceptPaymentDto) {
    const sub = await this.prisma.saleSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, currency: true, status: true, managerId: true },
    });
    if (!sub) throw new NotFoundException('Сделка не найдена');
    if (sub.status !== 'ACTIVE') throw new BadRequestException('Сделка закрыта — оплату принять нельзя');
    const amount = money(dto?.amount, 'Сумма');
    if (!dto?.accountId) throw new BadRequestException('Выберите счёт, на который пришли деньги');
    const acc = await this.prisma.financeAccount.findUnique({ where: { id: dto.accountId } });
    if (!acc) throw new BadRequestException('Счёт не найден');
    if (acc.archived) throw new BadRequestException(`Счёт «${acc.name}» в архиве — выберите другой`);
    const cur = (sub.currency || 'TJS').toUpperCase();
    const foreign = cur !== 'TJS';
    if (acc.currency !== cur && !(foreign && acc.currency === 'TJS')) {
      throw new BadRequestException(`Счёт «${acc.name}» в ${acc.currency}, а сделка в ${cur} — выберите счёт в ${cur}${foreign ? ' или в сомони' : ''}`);
    }
    let paidAt = tjStartOfDay(new Date());
    if (dto.paidAt) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dto.paidAt))) throw new BadRequestException('Дата оплаты в формате ГГГГ-ММ-ДД');
      paidAt = tjParseLocalDate(String(dto.paidAt));
      if (Number.isNaN(paidAt.getTime())) throw new BadRequestException('Неверная дата оплаты');
    }
    if (paidAt > tjEndOfDay(new Date())) throw new BadRequestException('Дата оплаты не может быть в будущем');

    const canApprove =
      roleAllows(me, 'submissions:approve', () => isFounder(me)) && (sub.managerId !== me.id || isFounder(me));
    // Сумма в сомони: для одобрения сделки не в сомони обязательна; на счёт в
    // сомони ложится именно она.
    let amountTjs: number | null = null;
    if (foreign && (canApprove || acc.currency === 'TJS' || (dto.amountTjs !== undefined && dto.amountTjs !== null && dto.amountTjs !== ''))) {
      amountTjs = money(dto.amountTjs, 'Сумма в сомони');
    }
    const receipts = Array.isArray(dto.receiptUrls) ? dto.receiptUrls.filter((u) => typeof u === 'string' && u).slice(0, 10) : [];
    const method = acc.kind === 'CASH' ? 'CASH' : 'TRANSFER';
    const payment = await this.submissions.addPayment(
      me.id,
      submissionId,
      {
        amount,
        paymentMethod: method as any,
        paidAt: tjLocalDay(paidAt),
        ...(method === 'CASH' ? { depositProofUrls: receipts } : { receiptUrls: receipts }),
        notes: typeof dto.notes === 'string' ? dto.notes.slice(0, 1000) : undefined,
      },
      { anyDeal: true, receiptsOptional: true, accountId: acc.id },
    );
    if (amountTjs != null && !canApprove) {
      await this.prisma.submissionPayment.update({ where: { id: payment.id }, data: { amountTjs } });
    }
    if (!canApprove) return { status: 'PENDING' as const, paymentId: payment.id };
    try {
      await this.submissions.approvePayment(payment.id, me.id, { amountTjs, allowed: true, accountId: acc.id });
    } catch (e) {
      // Одобрение не прошло — платёж не должен остаться висеть «на одобрении».
      await this.prisma.submissionPayment.deleteMany({ where: { id: payment.id, status: 'PENDING' } });
      throw e;
    }
    return { status: 'APPROVED' as const, paymentId: payment.id };
  }
}
