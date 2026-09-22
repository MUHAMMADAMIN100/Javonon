import { PrismaService } from '../prisma/prisma.service';
import { REPORTING_CURRENCY } from './reporting-currency';

/**
 * «Продажи» менеджера — ОДНО правило для зарплаты, KPI, рейтинга и профиля.
 *
 *  - deals  — одобренные платежи по сделкам (SubmissionPayment APPROVED) в
 *             TJS за период по дате оплаты (paidAt), сделка не отменена,
 *             связанная транзакция не удалена; платёж засчитан менеджеру,
 *             которому он зачислен при одобрении (creditedManagerId), а для
 *             старых строк без снапшота — владельцу сделки. Ровно так
 *             считается база бонуса в зарплате (common/manager-bonus-volume).
 *  - other  — «Прочие приходы»: ручные доходы по менеджеру (INCOME, не
 *             TUITION_PAYMENT, не удалённые) в TJS — в продажи не входят,
 *             показываются отдельной строкой (как manualSalesAmount в зарплате).
 *  - nonTjs — то и другое в прочих валютах: в суммы TJS не складываются.
 *
 * Раньше KPI и профиль суммировали ВСЕ приходы менеджера, а зарплата — только
 * одобренные платежи по сделкам: у одного человека за один месяц цифры на
 * двух экранах расходились.
 *
 * Считает сразу по многим менеджерам за 3 запроса (рейтинг KPI).
 */
export interface ManagerSalesRow {
  kind: 'DEAL' | 'OTHER';
  id: string;
  date: Date;
  amount: number;
  currency: string;
  category: string;
  comment: string | null;
  payerName: string | null;
  studentId: string | null;
  student: { id: string; fullName: string } | null;
  submissionId?: string | null;
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
    prisma.submissionPayment.findMany({
      where: {
        status: 'APPROVED',
        ...(date && { paidAt: date }),
        submission: { status: { not: 'CANCELLED' } },
        OR: [
          { creditedManagerId: { in: userIds } },
          { creditedManagerId: null, submission: { managerId: { in: userIds } } },
        ],
      },
      select: {
        id: true, amount: true, paidAt: true, financeTransactionId: true, creditedManagerId: true, notes: true,
        submission: {
          select: {
            id: true, managerId: true, currency: true, studentId: true, newStudentName: true,
            student: { select: { id: true, fullName: true } },
          },
        },
      },
      orderBy: { paidAt: 'desc' },
    }),
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

  // Платёж, чья транзакция удалена (отмена), в продажи не входит.
  const linked = payments.map((p) => p.financeTransactionId).filter((x): x is string => !!x);
  const reversed = new Set<string>();
  if (linked.length) {
    const rows = await prisma.transaction.findMany({ where: { id: { in: linked }, reversedAt: { not: null } }, select: { id: true } });
    for (const r of rows) reversed.add(r.id);
  }

  for (const p of payments) {
    if (p.financeTransactionId && reversed.has(p.financeTransactionId)) continue;
    const who = p.creditedManagerId ?? p.submission.managerId;
    const acc = who ? out.get(who) : undefined;
    if (!acc) continue;
    const cur = p.submission.currency || REPORTING_CURRENCY;
    if (cur === REPORTING_CURRENCY) {
      acc.deals += p.amount || 0;
      acc.dealsCount += 1;
    } else {
      acc.nonTjs[cur] = round2((acc.nonTjs[cur] || 0) + (p.amount || 0));
    }
    acc.rows.push({
      kind: 'DEAL', id: p.id, date: p.paidAt, amount: p.amount, currency: cur, category: 'TUITION_PAYMENT',
      comment: p.notes ?? null, payerName: p.submission.student ? null : p.submission.newStudentName ?? null,
      studentId: p.submission.studentId, student: p.submission.student, submissionId: p.submission.id,
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
