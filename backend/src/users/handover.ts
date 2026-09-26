/**
 * ПЕРЕДАЧА ДЕЛ УВОЛЬНЯЕМОГО СОТРУДНИКА.
 *
 * При увольнении (или позже — кнопкой «Передать дела» у уже уволенного)
 * всё, что сотрудник вёл, уходит другим, чтобы ничего не повисло «ничьим»:
 *   • заявки в работе (оба слота менеджера — основной и CN), кроме уже
 *     закрытых успешно: закрытая заявка — это его результат в KPI, её не
 *     переписываем на другого;
 *   • студенты ACTIVE/PAUSED (оба слота) — их ещё обслуживают;
 *   • сделки в работе (ACTIVE) — завершённые и отменённые остаются его
 *     историей продаж; уже одобренные платежи засчитаны ему навсегда
 *     (SubmissionPayment.creditedManagerId), будущие — новому владельцу;
 *   • открытые задачи — где он исполнитель или контролёр;
 *   • активные группы и будущие занятия, где он преподаватель;
 *   • места в схеме распределения выручки.
 *
 * Два режима (решение учредителя — один выбор «Кому передать всё»):
 *   USER — всё одному выбранному действующему сотруднику;
 *   AUTO — заявки и сделки менеджерам по продажам, студенты клиентским
 *          менеджерам (если их нет — менеджерам по продажам), каждому по
 *          наименьшей нагрузке; задачи — тому, кто увольняет; группы и
 *          занятия остаются без преподавателя, места в схеме выручки
 *          освобождаются (подобрать человека туда автоматически нельзя).
 *          Если подходящих менеджеров нет вовсе, запись остаётся без
 *          менеджера — окно увольнения предупреждает об этом заранее.
 *
 * Всё выполняется в транзакции вызывающего (users.service), вместе с
 * isActive=false: «уволен» и «дела переданы» не могут разъехаться.
 */
import { BadRequestException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FINISHED_APPLICATION_STATUSES } from '../common/application-status';

type Db = PrismaService | Prisma.TransactionClient;

export type HandoverMode = 'USER' | 'AUTO';

export interface HandoverCounts {
  applications: number;
  students: number;
  deals: number;
  tasks: number;
  groups: number;
  sessions: number;
  revenueShares: number;
}

type Slot = 'managerId' | 'chinaManagerId';
const SLOTS: Slot[] = ['managerId', 'chinaManagerId'];
const OPEN_STUDENT_STATUSES = ['ACTIVE', 'PAUSED'] as const;

const openApplications = (userId: string, slot: Slot): Prisma.ApplicationWhereInput => ({
  [slot]: userId,
  status: { notIn: FINISHED_APPLICATION_STATUSES },
});
const openStudents = (userId: string, slot: Slot): Prisma.StudentWhereInput => ({
  [slot]: userId,
  status: { in: [...OPEN_STUDENT_STATUSES] },
});
const openDeals = (userId: string): Prisma.SaleSubmissionWhereInput => ({ managerId: userId, status: 'ACTIVE' });
const openTasks = (userId: string): Prisma.TaskWhereInput => ({
  status: { not: 'DONE' },
  OR: [{ assignees: { some: { id: userId } } }, { assignedToId: userId }, { controllerId: userId }],
});
const activeGroups = (userId: string): Prisma.StudyGroupWhereInput => ({ teacherId: userId, status: 'ACTIVE' });
const futureSessions = (userId: string, now: Date): Prisma.ClassSessionWhereInput => ({
  teacherId: userId,
  status: 'SCHEDULED',
  startsAt: { gte: now },
});

/** Что числится за сотрудником — для окна увольнения. */
export async function handoverCounts(db: Db, userId: string): Promise<HandoverCounts> {
  const now = new Date();
  const [apps, students, deals, tasks, groups, sessions, revenueShares] = await Promise.all([
    db.application.count({ where: { OR: SLOTS.map((s) => openApplications(userId, s)) } }),
    db.student.count({ where: { OR: SLOTS.map((s) => openStudents(userId, s)) } }),
    db.saleSubmission.count({ where: openDeals(userId) }),
    db.task.count({ where: openTasks(userId) }),
    db.studyGroup.count({ where: activeGroups(userId) }),
    db.classSession.count({ where: futureSessions(userId, now) }),
    db.revenueBucketItem.count({ where: { userId } }),
  ]);
  return { applications: apps, students, deals, tasks, groups, sessions, revenueShares };
}

export function handoverTotal(c: HandoverCounts): number {
  return c.applications + c.students + c.deals + c.tasks + c.groups + c.sessions + c.revenueShares;
}

/** Действующие сотрудники с одной из ролей (мульти-роли учитываются). */
async function activeWithRoles(db: Db, roles: Role[], excludeId: string) {
  return db.user.findMany({
    where: {
      isActive: true,
      id: { not: excludeId },
      OR: [{ role: { in: roles } }, { roles: { hasSome: roles } }],
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** Сколько менеджеров доступно для режима AUTO — окно предупреждает, если нет. */
export async function autoTargets(db: Db, excludeId: string) {
  const [sales, client] = await Promise.all([
    activeWithRoles(db, ['SALES_MANAGER'], excludeId),
    activeWithRoles(db, ['CLIENT_MANAGER'], excludeId),
  ]);
  return { salesManagers: sales.length, clientManagers: client.length };
}

/**
 * Раздатчик «по наименьшей нагрузке»: next() отдаёт кандидата с минимальной
 * текущей нагрузкой (при равенстве — давнего сотрудника) и прибавляет ему
 * единицу — так пачка записей расходится ровно, а не падает одному.
 */
function leastLoaded(candidates: { id: string }[], load: Map<string, number>) {
  return {
    next(): string | null {
      let best: string | null = null;
      let bestLoad = Infinity;
      for (const c of candidates) {
        const l = load.get(c.id) ?? 0;
        if (l < bestLoad) {
          best = c.id;
          bestLoad = l;
        }
      }
      if (best) load.set(best, bestLoad + 1);
      return best;
    },
  };
}

async function applicationLoad(db: Db, ids: string[], slot: Slot) {
  const rows = await db.application.groupBy({
    by: [slot],
    where: { [slot]: { in: ids }, status: { notIn: FINISHED_APPLICATION_STATUSES } } as Prisma.ApplicationWhereInput,
    _count: { _all: true },
  });
  return new Map(rows.map((r: any) => [r[slot] as string, r._count._all as number]));
}

async function studentLoad(db: Db, ids: string[], slot: Slot) {
  const rows = await db.student.groupBy({
    by: [slot],
    where: { [slot]: { in: ids }, status: { in: [...OPEN_STUDENT_STATUSES] } } as Prisma.StudentWhereInput,
    _count: { _all: true },
  });
  return new Map(rows.map((r: any) => [r[slot] as string, r._count._all as number]));
}

async function dealLoad(db: Db, ids: string[]) {
  const rows = await db.saleSubmission.groupBy({
    by: ['managerId'],
    where: { managerId: { in: ids }, status: 'ACTIVE' },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.managerId as string, r._count._all]));
}

export interface HandoverResult extends HandoverCounts {
  mode: HandoverMode;
  toUserId: string | null;
}

/**
 * Передаёт дела сотрудника `userId`. Вызывать внутри транзакции вместе с
 * увольнением. Проверку получателя делает вызывающий (validateHandoverTarget).
 */
export async function performHandover(
  db: Prisma.TransactionClient,
  userId: string,
  opts: { mode: HandoverMode; toUserId: string | null; actorId: string | null },
): Promise<HandoverResult> {
  const now = new Date();
  const counts = await handoverCounts(db, userId);
  const to = opts.mode === 'USER' ? opts.toUserId : null;

  // ── Заявки, студенты, сделки ──
  if (opts.mode === 'USER') {
    for (const slot of SLOTS) {
      await db.application.updateMany({ where: openApplications(userId, slot), data: { [slot]: to } });
      await db.student.updateMany({ where: openStudents(userId, slot), data: { [slot]: to } });
    }
    await db.saleSubmission.updateMany({ where: openDeals(userId), data: { managerId: to } });
  } else {
    const sales = await activeWithRoles(db, ['SALES_MANAGER'], userId);
    const client = await activeWithRoles(db, ['CLIENT_MANAGER'], userId);
    const anyManager = await activeWithRoles(db, ['SALES_MANAGER', 'CLIENT_MANAGER'], userId);
    const studentPool = client.length ? client : sales;
    const dealPool = sales.length ? sales : client;

    for (const slot of SLOTS) {
      // Основной слот заявки — менеджерам по продажам (как новые лиды);
      // слот CN — любому менеджеру: отдельной роли у CN-менеджера нет.
      const appPool = slot === 'managerId' ? sales : anyManager;
      const appPick = leastLoaded(appPool, await applicationLoad(db, appPool.map((c) => c.id), slot));
      const apps = await db.application.findMany({
        where: openApplications(userId, slot),
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const a of apps) {
        await db.application.update({ where: { id: a.id }, data: { [slot]: appPick.next() } });
      }

      const stPool = slot === 'managerId' ? studentPool : anyManager;
      const stPick = leastLoaded(stPool, await studentLoad(db, stPool.map((c) => c.id), slot));
      const students = await db.student.findMany({
        where: openStudents(userId, slot),
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const s of students) {
        await db.student.update({ where: { id: s.id }, data: { [slot]: stPick.next() } });
      }
    }

    const dealPick = leastLoaded(dealPool, await dealLoad(db, dealPool.map((c) => c.id)));
    const deals = await db.saleSubmission.findMany({
      where: openDeals(userId),
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const d of deals) {
      await db.saleSubmission.update({ where: { id: d.id }, data: { managerId: dealPick.next() } });
    }
  }

  // ── Задачи: получателю (USER) или тому, кто увольняет (AUTO). Без
  // инициатора (системный вызов) задача просто снимается с уволенного. ──
  const taskTo = to ?? opts.actorId ?? null;
  const tasks = await db.task.findMany({
    where: openTasks(userId),
    select: { id: true, assignedToId: true, controllerId: true, assignees: { select: { id: true } } },
  });
  for (const t of tasks) {
    const data: Prisma.TaskUpdateInput = {};
    if (t.assignees.some((a) => a.id === userId)) {
      const addTo = taskTo && !t.assignees.some((a) => a.id === taskTo);
      data.assignees = { disconnect: [{ id: userId }], ...(addTo ? { connect: [{ id: taskTo! }] } : {}) };
    }
    if (t.assignedToId === userId) data.assignedTo = taskTo ? { connect: { id: taskTo } } : { disconnect: true };
    if (t.controllerId === userId) data.controller = taskTo ? { connect: { id: taskTo } } : { disconnect: true };
    await db.task.update({ where: { id: t.id }, data });
  }

  // ── Преподавание и схема выручки: получателю или освободить ──
  await db.studyGroup.updateMany({ where: activeGroups(userId), data: { teacherId: to } });
  await db.classSession.updateMany({ where: futureSessions(userId, now), data: { teacherId: to } });
  await db.revenueBucketItem.updateMany({ where: { userId }, data: { userId: to } });

  return { ...counts, mode: opts.mode, toUserId: to };
}

/** Режим и получатель из тела запроса; по умолчанию — AUTO. */
export function parseHandover(body: any): { mode: HandoverMode; toUserId: string | null } {
  const mode: HandoverMode = body?.mode === 'USER' ? 'USER' : 'AUTO';
  const toUserId = mode === 'USER' && typeof body?.toUserId === 'string' ? body.toUserId.trim() : null;
  if (mode === 'USER' && !toUserId) throw new BadRequestException('Выберите, кому передать дела');
  return { mode, toUserId };
}

/** Получатель должен существовать, работать и не быть самим увольняемым. */
export async function validateHandoverTarget(db: Db, userId: string, toUserId: string | null) {
  if (!toUserId) return;
  if (toUserId === userId) throw new BadRequestException('Нельзя передать дела самому себе');
  const target = await db.user.findUnique({ where: { id: toUserId }, select: { id: true, isActive: true } });
  if (!target) throw new BadRequestException('Сотрудник для передачи дел не найден');
  if (!target.isActive) throw new BadRequestException('Нельзя передать дела уволенному сотруднику');
}
