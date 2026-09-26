import { PrismaService } from '../prisma/prisma.service';
import { REPORTING_CURRENCY } from './reporting-currency';
import { loadCountedPayments } from './manager-bonus-volume';

/**
 * «Продажи» менеджера — ОДНО правило для зарплаты, KPI, рейтинга и профиля.
 *
 *  - deals  — платежи по сделкам, засчитанные менеджеру в бонус: ровно те,
 *             что отбирает loadCountedPayments() (common/manager-bonus-volume):
 *             одобрены основателем, лежат в периоде по месяцу засчёта
 *             (одобрения — для новых, получения денег — для старых строк),
 *             сделка не отменена, транзакция не развёрнута. Сумма — в
 *             сомони: у валютной сделки это сумма в сомони, которую основатель
 *             ввёл при одобрении.
 *  - other  — «Прочие приходы»: ручные доходы по менеджеру (INCOME, не
 *             TUITION_PAYMENT, не удалённые) в TJS — в продажи не входят,
 *             показываются отдельной строкой (как manualSalesAmount в зарплате).
 *  - nonTjs — валютные платежи без суммы в сомони (одобрены до того, как её
 *             стали вводить) и валютные ручные приходы: в суммы TJS не
 *             складываются.
 *
 * Раньше KPI и профиль считали платежи своим запросом, а зарплата — своим:
 * фильтры были скопированы и могли разъехаться. Теперь платежи отбирает одна
 * функция на всех.
 *
 * Считает сразу по многим менеджерам (рейтинг KPI).
 */
export interface ManagerSalesRow {
  kind: 'DEAL' | 'OTHER';
  id: string;
  /** Дата, по которой строка попала в период: для DEAL — момент засчёта. */
  date: Date;
  /** Сумма в `currency`. У валютной сделки с суммой в сомони — уже в TJS. */
  amount: number;
  currency: string;
  category: string;
  comment: string | null;
  payerName: string | null;
  studentId: string | null;
  student: { id: string; fullName: string } | null;
  submissionId?: string | null;
  /** DEAL: когда получены деньги. */
  paidAt?: Date;
  /** DEAL: когда основатель одобрил. */
  approvedAt?: Date | null;
  /** DEAL валютной сделки: исходные сумма и валюта (amount/currency — в сомони). */
  originalAmount?: number;
  originalCurrency?: string;
}

export interface ManagerSales {
  deals: number;
  dealsCount: number;
  other: number;
  otherCount: number;
  nonTjs: Record<string, number>;
  rows: ManagerSalesRow[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function managerSales(
  prisma: PrismaService,
  userIds: string[],
  range: { from?: Date; to?: Date },
): Promise<Map<string, ManagerSales>> {
  const out = new Map<string, ManagerSales>();
  for (const id of userIds) out.set(id, { deals: 0, dealsCount: 0, other: 0, otherCount: 0, nonTjs: {}, rows: [] });
  if (!userIds.length) return out;
  const date = range.from || range.to ? { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) } : undefined;

  const [payments, others] = await Promise.all([
    loadCountedPayments(prisma, userIds, range),
    prisma.transaction.findMany({
      where: {
        managerId: { in: userIds },
        type: 'INCOME',
        category: { not: 'TUITION_PAYMENT' },
        reversedAt: null,
        ...(date && { date }),
      },
      select: {
        id: true, amount: true, currency: true, date: true, category: true, comment: true, payerName: true,
        managerId: true, studentId: true, student: { select: { id: true, fullName: true } },
      },
      orderBy: { date: 'desc' },
    }),
  ]);

  for (const p of payments) {
    const acc = out.get(p.managerId);
    if (!acc) continue;
    const converted = p.currency !== REPORTING_CURRENCY && p.amountTjs !== null;
    if (p.amountTjs !== null) {
      acc.deals += p.amountTjs;
      acc.dealsCount += 1;
    } else {
      acc.nonTjs[p.currency] = round2((acc.nonTjs[p.currency] || 0) + p.amount);
    }
    acc.rows.push({
      kind: 'DEAL',
      id: p.id,
      date: p.countedAt,
      amount: p.amountTjs ?? p.amount,
      currency: p.amountTjs !== null ? REPORTING_CURRENCY : p.currency,
      category: 'TUITION_PAYMENT',
      comment: p.notes,
      payerName: p.student ? null : p.newStudentName,
      studentId: p.studentId,
      student: p.student,
      submissionId: p.submissionId,
      paidAt: p.paidAt,
      approvedAt: p.reviewedAt,
      ...(converted && { originalAmount: p.amount, originalCurrency: p.currency }),
    });
  }
  for (const t of others) {
    const acc = t.managerId ? out.get(t.managerId) : undefined;
    if (!acc) continue;
    if (t.currency === REPORTING_CURRENCY) {
      acc.other += t.amount || 0;
      acc.otherCount += 1;
    } else {
      acc.nonTjs[t.currency] = round2((acc.nonTjs[t.currency] || 0) + (t.amount || 0));
    }
    acc.rows.push({
      kind: 'OTHER', id: t.id, date: t.date, amount: t.amount, currency: t.currency, category: t.category,
      comment: t.comment, payerName: t.payerName, studentId: t.studentId, student: t.student,
    });
  }
  for (const acc of out.values()) {
    acc.deals = round2(acc.deals);
    acc.other = round2(acc.other);
    acc.rows.sort((a, b) => b.date.getTime() - a.date.getTime());
  }
  return out;
}
