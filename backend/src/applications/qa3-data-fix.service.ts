import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';

/**
 * Разовая правка старых данных после QA-3 (решения заказчика 12.11.2026).
 * Ничего не удаляет. Каждый шаг идемпотентен — повторный запуск ничего не
 * находит, метка «уже сделано» не нужна. Сырой SQL: prisma.update проставил бы
 * updatedAt, а по нему считаются окна KPI. Каждое изменение — в журнале
 * действий («Исправление данных»).
 *
 *  1. Две и больше записей рабочего дня у сотрудника за одну дату (до правки
 *     «Начать работу» после «Закончить день» создавало вторую запись).
 *     Опоздание считается один раз — по первому приходу: у повторных записей
 *     того же дня опоздание обнуляется, штраф по ним больше не начисляется.
 *     Лишние, ещё не учтённые в зарплате штрафы «за опоздание» за этот день
 *     аннулируются (сумма 0 и пометка в описании) — остаётся не больше одного,
 *     и только если первый приход действительно был опозданием без принятой
 *     причины.
 *  2. Студенты без менеджера получают менеджера своего лида (TJ и CN).
 */
const LATE_THRESHOLD_MIN = 10;
const VOID_NOTE = ' · аннулирован: повторная запись того же рабочего дня';

type DayEntry = {
  id: string;
  userId: string;
  day: string;
  clockIn: Date;
  lateMinutes: number;
  lateExcuseStatus: string | null;
  latePenaltyApplied: boolean;
};

@Injectable()
export class Qa3DataFixService implements OnApplicationBootstrap {
  private readonly logger = new Logger(Qa3DataFixService.name);

  constructor(private prisma: PrismaService, private activity: ActivityService) {}

  onApplicationBootstrap() {
    setTimeout(() => {
      this.run().catch((e) => this.logger.warn(`Правка старых данных QA-3 не выполнена: ${(e as Error).message}`));
    }, 14_000);
  }

  private log(details: string, payload: Record<string, unknown>, studentId?: string | null) {
    return this.activity
      .log({ actorId: null, actorName: 'Система', actorRole: 'SYSTEM', action: 'DATA_FIX', studentId: studentId ?? undefined, details, payload }, null)
      .catch(() => undefined);
  }

  async run() {
    const out = { dayEntries: 0, penaltiesVoided: 0, studentsTj: 0, studentsCn: 0 };

    // ── 1. Повторные записи рабочего дня ──
    // Колонки времени — timestamp БЕЗ пояса, в них UTC: сначала «это UTC»,
    // потом перевод в Душанбе. Одно «AT TIME ZONE 'Asia/Dushanbe'» прочитало бы
    // UTC-время как местное и сдвинуло день на 5 часов не в ту сторону.
    const rows = await this.prisma.$queryRaw<DayEntry[]>`
      SELECT t.id, t."userId", to_char((t."clockIn" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD') AS day,
             t."clockIn", t."lateMinutes", t."lateExcuseStatus"::text AS "lateExcuseStatus", t."latePenaltyApplied"
      FROM "TimeEntry" t
      JOIN (
        SELECT "userId", (("clockIn" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dushanbe')::date AS d
        FROM "TimeEntry" GROUP BY 1, 2 HAVING count(*) > 1
      ) g ON g."userId" = t."userId" AND g.d = ((t."clockIn" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dushanbe')::date
      ORDER BY t."userId", t."clockIn"`;
    const groups = new Map<string, DayEntry[]>();
    for (const r of rows) {
      const key = `${r.userId}|${r.day}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const list of groups.values()) {
      const [first, ...later] = list;
      for (const e of later) {
        if (e.lateMinutes <= 0 && e.latePenaltyApplied) continue;
        await this.prisma.$executeRaw`UPDATE "TimeEntry" SET "lateMinutes" = 0, "latePenaltyApplied" = true WHERE id = ${e.id}`;
        out.dayEntries++;
        await this.log(
          `Рабочий день ${first.day}: повторная запись того же дня — опоздание ${e.lateMinutes} мин не считается (опоздание одно, по первому приходу)`,
          { entity: 'TimeEntry', id: e.id, userId: e.userId, day: first.day, before: { lateMinutes: e.lateMinutes }, firstEntryId: first.id },
        );
      }
      // Штрафы «за опоздание» этого дня: не больше одного и только по первому приходу.
      const firstIsPenalized =
        first.lateMinutes >= LATE_THRESHOLD_MIN && first.lateExcuseStatus !== 'APPROVED' && first.lateExcuseStatus !== 'PENDING';
      const penalties = await this.prisma.$queryRaw<Array<{ id: string; amount: number; details: string; applied: boolean }>>`
        SELECT id, amount, details, applied FROM "Penalty"
        WHERE "userId" = ${first.userId} AND reason = 'LATE_ARRIVAL' AND date = ${first.day}::date AND amount > 0
        ORDER BY "createdAt"`;
      const keep = firstIsPenalized
        ? (penalties.find((p) => p.details.includes(`Опоздание ${first.lateMinutes} мин`)) ?? penalties[0])?.id
        : undefined;
      for (const p of penalties) {
        if (p.id === keep) continue;
        if (p.applied) {
          // Уже учтён в выплаченной зарплате — не трогаем, только фиксируем.
          await this.log(
            `Штраф ${p.amount} за ${first.day} начислен по повторной записи дня и уже учтён в зарплате — оставлен, проверьте вручную`,
            { entity: 'Penalty', id: p.id, userId: first.userId, day: first.day, applied: true },
          );
          // Пометка в описании делает шаг идемпотентным: второй раз в журнал не пишем.
          await this.prisma.$executeRaw`UPDATE "Penalty" SET details = details || ' · проверить: повторная запись дня' WHERE id = ${p.id} AND details NOT LIKE '%повторная запись%'`;
          continue;
        }
        await this.prisma.$executeRaw`UPDATE "Penalty" SET amount = 0, details = details || ${VOID_NOTE} WHERE id = ${p.id}`;
        out.penaltiesVoided++;
        await this.log(
          `Штраф ${p.amount} за ${first.day} аннулирован: начислен по повторной записи того же рабочего дня`,
          { entity: 'Penalty', id: p.id, userId: first.userId, day: first.day, before: { amount: p.amount } },
        );
      }
    }

    // ── 2. Студент без менеджера → менеджер его лида ──
    for (const slot of ['managerId', 'chinaManagerId'] as const) {
      const col = slot === 'managerId' ? 'managerId' : 'chinaManagerId';
      // Имя колонки — из фиксированного списка выше, не из ввода.
      const found = await this.prisma.$queryRawUnsafe<Array<{ id: string; fullName: string; toId: string; toName: string; appId: string }>>(
        `SELECT s.id, s."fullName", a."${col}" AS "toId", u."fullName" AS "toName", a.id AS "appId"
         FROM "Student" s
         JOIN LATERAL (
           SELECT a.id, a."${col}" FROM "Application" a
           JOIN "User" m ON m.id = a."${col}" AND m."isActive" = true
           WHERE a."studentId" = s.id AND a."deletedAt" IS NULL AND a."${col}" IS NOT NULL
           ORDER BY (a.status = 'SUCCESSFUL_LEAD') DESC, a."createdAt" DESC
           LIMIT 1
         ) a ON true
         JOIN "User" u ON u.id = a."${col}"
         WHERE s."${col}" IS NULL`,
      );
      for (const f of found) {
        const n = await this.prisma.$executeRawUnsafe(
          `UPDATE "Student" SET "${col}" = $1 WHERE id = $2 AND "${col}" IS NULL`,
          f.toId,
          f.id,
        );
        if (!n) continue;
        if (slot === 'managerId') out.studentsTj++;
        else out.studentsCn++;
        await this.log(
          `Студенту «${f.fullName}» назначен ${slot === 'managerId' ? 'менеджер' : 'китайский менеджер'} его лида — ${f.toName} (раньше не был назначен)`,
          { entity: 'Student', id: f.id, field: slot, before: null, after: f.toId, applicationId: f.appId },
          f.id,
        );
      }
    }

    if (Object.values(out).some((n) => n > 0)) {
      this.logger.log(
        `QA-3, правка старых данных: записей дня — ${out.dayEntries}, штрафов аннулировано — ${out.penaltiesVoided}, ` +
          `студентам назначен менеджер — ${out.studentsTj}, китайский менеджер — ${out.studentsCn}`,
      );
    }
    return out;
  }
}
