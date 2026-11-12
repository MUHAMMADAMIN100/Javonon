import { Prisma } from '@prisma/client';

/**
 * QA-3 (BUG-13): менеджеры лида и его студента — одно и то же.
 *
 * Назначение менеджера в карточке лида или студента и раньше зеркалилось на
 * вторую сторону. Рассинхрон появлялся в момент СВЯЗЫВАНИЯ: сделку одобрили —
 * студент получал того, кто её оформил, а лид оставался со своим менеджером;
 * студента завели вручную — его лид оставался без менеджера. В итоге менеджер
 * видел 0 студентов, а в KPI «Студентов» у всех был ноль.
 *
 * Правило: пустое место одной стороны заполняется значением другой. Занятое
 * место НЕ переписывается — менять менеджера может только человек.
 */
const SLOTS = ['managerId', 'chinaManagerId'] as const;

export async function alignManagersTx(
  tx: Prisma.TransactionClient,
  applicationId: string | null | undefined,
  studentId: string | null | undefined,
): Promise<void> {
  if (!applicationId || !studentId) return;
  const [app, stu] = await Promise.all([
    tx.application.findUnique({ where: { id: applicationId }, select: { managerId: true, chinaManagerId: true } }),
    tx.student.findUnique({ where: { id: studentId }, select: { managerId: true, chinaManagerId: true } }),
  ]);
  if (!app || !stu) return;
  const toStudent: Record<string, string> = {};
  const toLead: Record<string, string> = {};
  for (const slot of SLOTS) {
    if (app[slot] && !stu[slot]) toStudent[slot] = app[slot] as string;
    else if (!app[slot] && stu[slot]) toLead[slot] = stu[slot] as string;
  }
  if (Object.keys(toStudent).length) await tx.student.update({ where: { id: studentId }, data: toStudent });
  if (Object.keys(toLead).length) await tx.application.update({ where: { id: applicationId }, data: toLead });
}
