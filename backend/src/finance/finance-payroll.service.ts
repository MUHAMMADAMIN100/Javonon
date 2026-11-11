import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SalaryService } from '../salary/salary.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { tjEndOfDay, tjEndOfMonth, tjLocalDay, tjParseLocalDate } from '../common/tj-time';
import { monthStartOf } from './finance-accounts.service';

/**
 * Финансы → Расход → «Зарплата» (часть 2, 10.11.2026). Расчёт — как в
 * Javonon (SalaryService: часы, процент с продаж по сетке, переработка,
 * KPI-бонус, штрафы). Здесь — удобства из Sabt: авансы со счёта, выплата
 * остатка со счёта и датой, закрытие месяца, история сотрудника.
 *
 * Месяц ведомости — месяц НАЧИСЛЕНИЯ: зарплату за октябрь платят в ноябре.
 * Аванс — расход «Зарплата» (salaryKind ADVANCE, salaryYm = месяц) — уходит со
 * счёта сразу и уменьшает «к выплате». Выплата — SalaryService.markPaid:
 * фиксирует запись и выплачивает остаток за вычетом авансов.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const currentYm = () => tjLocalDay(new Date()).slice(0, 7);
function addYm(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function parseDay(val: unknown): Date {
  if (!val) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(val))) throw new BadRequestException('Дата в формате ГГГГ-ММ-ДД');
  const d = tjParseLocalDate(String(val));
  if (d > tjEndOfDay(new Date())) throw new BadRequestException('Дата не может быть в будущем');
  return d;
}

@Injectable()
export class FinancePayrollService {
  constructor(
    private prisma: PrismaService,
    private salary: SalaryService,
    private realtime: RealtimeGateway,
  ) {}

  private changed() {
    this.realtime.emitFinanceStaff('finance:accounts', {});
    this.realtime.emitFinanceStaff('transaction:new', {});
  }

  /** Основной открытый месяц: прошлый, если не закрыт; иначе текущий. */
  async defaultYm() {
    const prev = addYm(currentYm(), -1);
    const closed = await this.prisma.financePayrollMonth.findUnique({ where: { ym: prev } });
    return closed ? currentYm() : prev;
  }

  // QA-2: «Расход» открывался ~8 с — summary, plan и chart одной страницы
  // каждый заново пересчитывали всю ведомость. Теперь три одновременных запроса
  // делят один расчёт (живёт 2 с); любая операция в «Финансах» его сбрасывает.
  private sheetCache = new Map<string, { at: number; p: Promise<any> }>();
  invalidateSheet() {
    this.sheetCache.clear();
  }

  async sheet(ymRaw?: string) {
    const ym = ymRaw || (await this.defaultYm());
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const hit = this.sheetCache.get(ym);
    if (hit && Date.now() - hit.at < 2_000) return hit.p;
    const p = this.buildSheet(ym);
    this.sheetCache.set(ym, { at: Date.now(), p });
    p.catch(() => this.sheetCache.delete(ym));
    return p;
  }

  private async buildSheet(ym: string) {
    const start = monthStartOf(ym);
    const end = tjEndOfMonth(start);
    const [{ rows }, closedRow, salaryTx, users] = await Promise.all([
      this.salary.previewAll(start, end),
      this.prisma.financePayrollMonth.findUnique({ where: { ym } }),
      this.prisma.transaction.findMany({
        where: { type: 'EXPENSE', category: 'SALARY', reversedAt: null, salaryYm: ym },
        orderBy: { date: 'asc' },
        select: { id: true, amount: true, date: true, managerId: true, salaryKind: true, comment: true, account: { select: { id: true, name: true } } },
      }),
      this.prisma.user.findMany({ select: { id: true, customRole: { select: { name: true } } } }),
    ]);
    // Должность — название своей роли сотрудника (если есть).
    const positionOf = new Map<string, string | null>(users.map((u) => [u.id, u.customRole?.name ?? null]));
    const byUser = new Map<string, typeof salaryTx>();
    for (const t of salaryTx) {
      if (!t.managerId) continue;
      const list = byUser.get(t.managerId) ?? [];
      list.push(t);
      byUser.set(t.managerId, list);
    }
    const out = (rows as any[])
      .filter((r) => (r.netAmount ?? 0) > 0.005 || r.record || byUser.has(r.userId))
      .map((r) => {
        const net = round2(Math.max(0, r.record ? r.record.netAmount : r.netAmount) || 0);
        const txs = byUser.get(r.userId) ?? [];
        const advancesList = txs.filter((t) => t.salaryKind === 'ADVANCE');
        const advances = round2(advancesList.reduce((x, t) => x + t.amount, 0));
        const paidOut = round2(txs.filter((t) => t.salaryKind === 'PAYOUT').reduce((x, t) => x + t.amount, 0));
        const isPaid = r.record?.status === 'PAID';
        const toPay = isPaid ? 0 : round2(Math.max(0, net - advances));
        const extra = round2(Math.max(0, net - (r.baseAmount || 0) - (r.bonusAmount || 0) + (r.penalties || 0)));
        return {
          userId: r.userId,
          name: r.user?.fullName ?? '—',
          role: r.user?.role ?? null,
          position: positionOf.get(r.userId) ?? null,
          isActive: r.user?.isActive ?? true,
          hasRate: !!r.hasRate,
          hours: round2((r.workedMinutes || 0) / 60),
          lateMinutes: r.lateMinutes || 0,
          base: round2(r.baseAmount || 0),
          sales: round2(r.salesAmount || 0),
          bonus: round2(r.bonusAmount || 0),
          bonusPercent: r.bonusPercent ?? null,
          extra,
          penalties: round2(r.penalties || 0),
          penaltiesPending: r.penaltiesPending || 0,
          net,
          advances,
          advancesList: advancesList.map((t) => ({ id: t.id, amount: t.amount, date: tjLocalDay(t.date), account: t.account, comment: t.comment })),
          paidOut,
          toPay,
          status: isPaid ? 'paid' : net - advances <= 0.005 && net > 0 ? 'covered' : net <= 0.005 ? 'zero' : 'due',
          paidAt: r.record?.status === 'PAID' && r.record.paidAt ? tjLocalDay(new Date(r.record.paidAt)) : null,
          record: r.record ? { id: r.record.id, status: r.record.status } : null,
        };
      })
      .sort((a, b) => b.net - a.net);
    const cards = {
      accrued: round2(out.reduce((x, r) => x + r.net, 0)),
      advances: round2(out.reduce((x, r) => x + r.advances, 0)),
      paid: round2(out.filter((r) => r.status === 'paid').reduce((x, r) => x + r.net, 0)),
      paidCount: out.filter((r) => r.status === 'paid').length,
      toPay: round2(out.reduce((x, r) => x + r.toPay, 0)),
      employees: out.length,
    };
    const allDone = out.every((r) => r.status === 'paid' || r.status === 'zero');
    return {
      ym,
      payUntil: `${addYm(ym, 1)}-10`,
      closed: !!closedRow,
      closedAt: closedRow ? tjLocalDay(closedRow.closedAt) : null,
      canClose: !closedRow && allDone && out.length > 0,
      cards,
      rows: out,
    };
  }

  private async assertOpen(ym: string) {
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    const closed = await this.prisma.financePayrollMonth.findUnique({ where: { ym } });
    if (closed) throw new BadRequestException('Зарплатный месяц закрыт — сначала переоткройте его');
  }

  private async account(accountId: unknown) {
    if (!accountId) throw new BadRequestException('Выберите счёт');
    const acc = await this.prisma.financeAccount.findUnique({ where: { id: String(accountId) } });
    if (!acc || acc.archived) throw new BadRequestException('Счёт не найден или в архиве');
    if (acc.currency !== 'TJS') throw new BadRequestException(`Зарплата в сомони — счёт «${acc.name}» в ${acc.currency}`);
    return acc;
  }

  /** Аванс: расход «Зарплата» со счёта сразу, уменьшает «к выплате» месяца. */
  async giveAdvance(me: { id: string }, dto: { userId?: string; ym?: string; amount?: unknown; accountId?: string; date?: string; note?: string }) {
    this.invalidateSheet();
    const ym = String(dto?.ym || '');
    await this.assertOpen(ym);
    if (!dto.userId) throw new BadRequestException('Выберите сотрудника');
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true, fullName: true } });
    if (!user) throw new NotFoundException('Сотрудник не найден');
    const amount = Number(String(dto.amount ?? '').replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Сумма аванса больше нуля');
    if (amount > 1_000_000) throw new BadRequestException('Сумма слишком большая');
    const start = monthStartOf(ym);
    const paid = await this.prisma.salaryRecord.findFirst({
      where: { userId: user.id, status: 'PAID', periodStart: { gte: start, lte: tjEndOfMonth(start) } },
      select: { id: true },
    });
    if (paid) throw new BadRequestException('Зарплата за этот месяц уже выплачена — аванс не нужен');
    const acc = await this.account(dto.accountId);
    const note = typeof dto.note === 'string' ? dto.note.trim().slice(0, 300) : '';
    if (/[<>]/.test(note)) throw new BadRequestException('Комментарий: знаки < и > нельзя');
    const created = await this.prisma.transaction.create({
      data: {
        type: 'EXPENSE',
        category: 'SALARY',
        amount: round2(amount),
        currency: 'TJS',
        managerId: user.id,
        date: parseDay(dto.date),
        comment: note ? `Аванс — ${note}` : 'Аванс',
        accountId: acc.id,
        salaryYm: ym,
        salaryKind: 'ADVANCE',
        recordedById: me.id,
      },
    });
    this.changed();
    return created;
  }

  /** «Выплатить»: фиксирует расчёт месяца (если ещё нет) и выплачивает остаток за вычетом авансов. */
  async pay(me: { id: string }, dto: { userId?: string; ym?: string; accountId?: string; date?: string }) {
    this.invalidateSheet();
    const ym = String(dto?.ym || '');
    await this.assertOpen(ym);
    if (!dto.userId) throw new BadRequestException('Выберите сотрудника');
    const acc = await this.account(dto.accountId);
    const date = parseDay(dto.date);
    const start = monthStartOf(ym);
    const end = tjEndOfMonth(start);
    let rec = await this.prisma.salaryRecord.findFirst({
      where: { userId: dto.userId, periodStart: { gte: start, lte: end } },
      orderBy: { createdAt: 'desc' },
    });
    if (!rec) {
      await this.salary.create({ userId: dto.userId, periodStart: tjLocalDay(start), periodEnd: tjLocalDay(end) });
      rec = await this.prisma.salaryRecord.findFirst({ where: { userId: dto.userId, periodStart: { gte: start, lte: end } }, orderBy: { createdAt: 'desc' } });
    }
    if (!rec) throw new BadRequestException('Не удалось рассчитать зарплату');
    if (rec.status === 'PAID') throw new BadRequestException('Зарплата за этот месяц уже выплачена');
    const res = await this.salary.markPaid(rec.id, { accountId: acc.id, date, recordedById: me.id });
    this.changed();
    return res;
  }

  async close(me: { id: string }, ymRaw: unknown) {
    this.invalidateSheet();
    const ym = String(ymRaw || '');
    await this.assertOpen(ym);
    const sheet = await this.sheet(ym);
    if (!sheet.canClose) throw new BadRequestException('Сначала выплатите всем — потом месяц можно закрыть');
    await this.prisma.financePayrollMonth.create({ data: { ym, closedById: me.id } });
    this.changed();
    return { ok: true, nextYm: await this.defaultYm() };
  }

  async reopen(ymRaw: unknown) {
    this.invalidateSheet();
    const ym = String(ymRaw || '');
    if (!YM_RE.test(ym)) throw new BadRequestException('Месяц в формате ГГГГ-ММ');
    await this.prisma.financePayrollMonth.deleteMany({ where: { ym } });
    this.changed();
    return { ok: true };
  }

  /** История сотрудника: последние 12 месяцев — начислено, авансы, выплачено и когда. */
  async history(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, fullName: true } });
    if (!user) throw new NotFoundException('Сотрудник не найден');
    const [records, txs] = await Promise.all([
      this.prisma.salaryRecord.findMany({
        where: { userId },
        orderBy: { periodStart: 'desc' },
        take: 12,
        select: { id: true, periodStart: true, periodEnd: true, netAmount: true, status: true, paidAt: true },
      }),
      this.prisma.transaction.findMany({
        where: { managerId: userId, category: 'SALARY', type: 'EXPENSE', reversedAt: null, salaryYm: { not: null } },
        select: { amount: true, salaryYm: true, salaryKind: true },
      }),
    ]);
    const adv = new Map<string, number>();
    for (const t of txs) if (t.salaryKind === 'ADVANCE' && t.salaryYm) adv.set(t.salaryYm, round2((adv.get(t.salaryYm) ?? 0) + t.amount));
    return {
      user: { id: user.id, name: user.fullName },
      rows: records.map((r) => {
        const ym = tjLocalDay(r.periodStart).slice(0, 7);
        return { ym, net: r.netAmount, advances: adv.get(ym) ?? 0, status: r.status, paidAt: r.paidAt ? tjLocalDay(r.paidAt) : null };
      }),
    };
  }
}
