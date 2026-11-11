import { PrismaService } from '../prisma/prisma.service';
import { tjLocalDay } from '../common/tj-time';

/**
 * Журнал «Финансы → Активность». Пишется без исключений наружу: сбой журнала
 * не должен ломать саму денежную операцию.
 */
export type ActivityChange = { field: string; before: unknown; after: unknown };

export interface ActivityEntry {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  summary: string;
  meta?: Record<string, unknown>;
  changes?: ActivityChange[];
}

export async function logFinance(prisma: PrismaService | any, a: ActivityEntry) {
  try {
    const actor = a.actorId ? await prisma.user.findUnique({ where: { id: a.actorId }, select: { fullName: true } }) : null;
    await prisma.financeActivity.create({
      data: {
        actorId: a.actorId ?? null,
        actorName: actor?.fullName ?? null,
        action: a.action,
        entity: a.entity,
        entityId: a.entityId ?? null,
        summary: String(a.summary || '').slice(0, 300),
        ...(a.meta && { meta: a.meta as any }),
        ...(a.changes?.length && { changes: a.changes as any }),
      },
    });
  } catch {
    /* журнал — вспомогательный */
  }
}

const norm = (v: unknown) => (v instanceof Date ? tjLocalDay(v) : v === undefined ? null : v);

/** Поля, которые поменялись: [{field, before, after}]. */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]): ActivityChange[] {
  const out: ActivityChange[] = [];
  for (const f of fields) {
    const b = norm(before[f]);
    const a = norm(after[f]);
    if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ field: f, before: b, after: a });
  }
  return out;
}

/** Снимок операции для журнала: имена вместо id. */
export async function txSnapshot(prisma: PrismaService | any, id: string) {
  const t = await prisma.transaction.findUnique({
    where: { id },
    select: {
      id: true, type: true, category: true, amount: true, currency: true, date: true, comment: true,
      paymentChannel: true, productCategoryEnum: true, reversedAt: true,
      account: { select: { name: true } }, manager: { select: { fullName: true } }, student: { select: { fullName: true } },
    },
  }).catch(() => null);
  if (!t) return null;
  return {
    id: t.id, type: t.type, category: t.category, amount: t.amount, currency: t.currency, date: t.date,
    comment: t.comment, paymentChannel: t.paymentChannel, product: t.productCategoryEnum,
    account: t.account?.name ?? null, manager: t.manager?.fullName ?? null, student: t.student?.fullName ?? null,
    reversed: !!t.reversedAt,
  };
}

export const TX_FIELDS = ['type', 'category', 'amount', 'currency', 'date', 'comment', 'account', 'paymentChannel', 'product', 'manager', 'student'];

export function txSummary(t: { comment?: string | null; student?: string | null; amount: number; currency: string }) {
  const who = t.student || t.comment || '';
  return `${who ? `${who} · ` : ''}${t.amount.toLocaleString('ru-RU')} ${t.currency}`;
}
