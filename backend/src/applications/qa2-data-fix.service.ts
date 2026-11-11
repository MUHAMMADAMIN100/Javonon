import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';

/**
 * Разовая правка старых данных после QA-2 (решение заказчика 11.11.2026:
 * «исправить, дубли — списком»). Ничего не удаляет. Каждый шаг идемпотентен —
 * повторный запуск ничего не находит, поэтому метка «уже сделано» не нужна.
 * Сырой SQL: prisma.update проставил бы updatedAt, а по нему считаются окна KPI.
 *
 *  1. Сделки из лида, одобренные до правки: «Успешным» становится исходный лид
 *     (с памятью о прежнем статусе и связью со студентом), сделка ссылается на
 *     него. Лид-дубль, созданный сделкой, помечается — он попадает в список
 *     «Дубли» на экране «Лиды», удаляет его основатель сам.
 *  2. Отменённые сделки: студент без других живых сделок — «В архив»; лид,
 *     созданный такой сделкой, помечается для списка «Дубли».
 *  3. Опоздание «24:xx» (полночь читалась часом 24): приход в 00:00–00:59 по
 *     Душанбе — не опоздание. Начисленные штрафы не трогаем — пишем в журнал.
 *  4. Дедлайны задач, заданные датой без времени старой версией (UTC-полночь,
 *     в CRM — «05:00»), — на конец того же дня по Душанбе.
 *  5. Опечатка «intermadiate» в названиях уровней академии.
 */
const TASK_FIX_CUTOFF = new Date('2026-11-12T00:00:00+05:00');

@Injectable()
export class Qa2DataFixService implements OnApplicationBootstrap {
  private readonly logger = new Logger(Qa2DataFixService.name);

  constructor(private prisma: PrismaService, private activity: ActivityService) {}

  onApplicationBootstrap() {
    setTimeout(() => {
      this.run().catch((e) => this.logger.warn(`Правка старых данных не выполнена: ${(e as Error).message}`));
    }, 8_000);
  }

  private log(details: string, payload: Record<string, unknown>, studentId?: string | null) {
    return this.activity
      .log({ actorId: null, actorName: 'Система', actorRole: 'SYSTEM', action: 'DATA_FIX', studentId: studentId ?? undefined, details, payload }, null)
      .catch(() => undefined);
  }

  async run() {
    const out = { leads: 0, dupMarked: 0, archived: 0, lateness: 0, deadlines: 0, levels: 0 };

    // 1. Сделка из лида → исходный лид «Успешный», дубль помечен.
    const pairs = await this.prisma.$queryRaw<
      Array<{ subId: string; studentId: string; srcId: string; srcStatus: string; srcName: string; dupId: string; dupPending: boolean }>
    >`
      SELECT s.id AS "subId", s."studentId", src.id AS "srcId", src.status::text AS "srcStatus", src."fullName" AS "srcName",
             dup.id AS "dupId", dup."paymentPending" AS "dupPending"
      FROM "SaleSubmission" s
      JOIN "Application" src ON src.id = s."sourceApplicationId" AND src."deletedAt" IS NULL
      JOIN "Application" dup ON dup.id = s."applicationId"
      WHERE s."firstApprovedAt" IS NOT NULL AND s.status <> 'CANCELLED' AND s."studentId" IS NOT NULL
        AND s."applicationId" <> s."sourceApplicationId"
        AND dup."createdBySubmissionId" IS NULL AND dup."statusBeforeDeal" IS NULL
        AND (src."studentId" IS NULL OR src."studentId" = s."studentId")
        AND NOT EXISTS (SELECT 1 FROM "SaleSubmission" o WHERE o."applicationId" = src.id)`;
    for (const p of pairs) {
      await this.prisma.$transaction([
        this.prisma.$executeRaw`
          UPDATE "Application" SET status = 'SUCCESSFUL_LEAD', "statusBeforeDeal" = ${p.srcStatus}::"ApplicationStatus",
                 "studentId" = ${p.studentId}, "paymentPending" = ("paymentPending" OR ${p.dupPending})
          WHERE id = ${p.srcId}`,
        this.prisma.$executeRaw`UPDATE "SaleSubmission" SET "applicationId" = ${p.srcId} WHERE id = ${p.subId}`,
        this.prisma.$executeRaw`UPDATE "Application" SET "createdBySubmissionId" = ${p.subId}, "paymentPending" = false WHERE id = ${p.dupId}`,
      ]);
      out.leads++;
      await this.log(
        `Лид «${p.srcName}» стал «Успешные лиды» по сделке (был «${p.srcStatus}»); лид-дубль, созданный сделкой, — в списке «Дубли»`,
        { entity: 'Application', id: p.srcId, before: { status: p.srcStatus }, submissionId: p.subId, duplicateId: p.dupId },
        p.studentId,
      );
    }

    // 2. Отменённые сделки: дубль помечаем, студента — в архив.
    const cancelled = await this.prisma.$queryRaw<Array<{ subId: string; studentId: string | null; appId: string | null; srcId: string | null }>>`
      SELECT s.id AS "subId", s."studentId", s."applicationId" AS "appId", s."sourceApplicationId" AS "srcId"
      FROM "SaleSubmission" s
      WHERE s.status = 'CANCELLED' AND s."firstApprovedAt" IS NOT NULL`;
    for (const c of cancelled) {
      if (c.appId && c.appId !== c.srcId) {
        const n = await this.prisma.$executeRaw`
          UPDATE "Application" SET "createdBySubmissionId" = ${c.subId}
          WHERE id = ${c.appId} AND "createdBySubmissionId" IS NULL AND "statusBeforeDeal" IS NULL AND "deletedAt" IS NULL
            AND status = 'SUCCESSFUL_LEAD'`;
        out.dupMarked += n;
      }
      if (c.studentId) {
        const live = await this.prisma.saleSubmission.count({
          where: { studentId: c.studentId, status: { not: 'CANCELLED' }, firstApprovedAt: { not: null } },
        });
        if (live === 0) {
          const n = await this.prisma.$executeRaw`
            UPDATE "Student" SET status = 'ARCHIVED'
            WHERE id = ${c.studentId} AND "academyOnly" = false AND status IN ('ACTIVE', 'PAUSED')`;
          if (n) {
            out.archived++;
            await this.log('Студент «В архив»: все его сделки отменены', { entity: 'Student', id: c.studentId, submissionId: c.subId }, c.studentId);
          }
        }
      }
    }

    // 3. Опоздание «24:xx».
    const late = await this.prisma.$queryRaw<Array<{ id: string; userId: string; lateMinutes: number }>>`
      SELECT id, "userId", "lateMinutes" FROM "TimeEntry"
      WHERE "lateMinutes" > 0
        AND extract(hour from (("clockIn" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dushanbe')) = 0`;
    for (const e of late) {
      await this.prisma.$executeRaw`UPDATE "TimeEntry" SET "lateMinutes" = 0 WHERE id = ${e.id}`;
      out.lateness++;
      await this.log(
        `Опоздание ${e.lateMinutes} мин снято: приход после полуночи считался часом «24». Если по нему начислен штраф — проверьте его в «Зарплате».`,
        { entity: 'TimeEntry', id: e.id, userId: e.userId, before: { lateMinutes: e.lateMinutes } },
      );
    }

    // 4. Дедлайны «05:00» от старой версии — конец дня.
    out.deadlines = await this.prisma.$executeRaw`
      UPDATE "Task" SET deadline = deadline + interval '18 hours 59 minutes 59.999 seconds'
      WHERE deadline IS NOT NULL AND "createdAt" < ${TASK_FIX_CUTOFF}
        AND deadline = date_trunc('day', deadline)`;

    // 5. Опечатка в названии уровня академии («intermadiate» → «intermediate»).
    const levels = await this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM "AcademyLevel" WHERE name ~* 'ntermadiate'`;
    for (const l of levels) {
      const fixed = l.name.replace(/ntermadiate/gi, (m) => (m[0] === 'N' ? 'Ntermediate' : 'ntermediate'));
      await this.prisma.$executeRaw`UPDATE "AcademyLevel" SET name = ${fixed} WHERE id = ${l.id}`;
      out.levels++;
      await this.log(`Уровень «${l.name}» переименован в «${fixed}» (опечатка)`, { entity: 'AcademyLevel', id: l.id, before: { name: l.name } });
    }

    if (Object.values(out).some((n) => n > 0)) {
      this.logger.log(`Правка старых данных (QA-2): ${JSON.stringify(out)}`);
    }
    return out;
  }
}
