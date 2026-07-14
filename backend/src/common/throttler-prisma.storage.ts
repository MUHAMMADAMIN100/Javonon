import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';

// ThrottlerStorageRecord из @nestjs/throttler НЕ ре-экспортирован из index
// (см. node_modules/@nestjs/throttler/dist/index.d.ts) — только через deep
// import, а он ломается на минорных апах. Тип маленький и стабильный (это
// возвращаемое значение ThrottlerStorage.increment), поэтому декларируем
// локально и не завязываемся на внутреннюю раскладку пакета.
type ThrottlerStorageRecord = {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
};

/**
 * Audit fix (HIGH, multi-replica rate-limit inflation + reset-on-deploy):
 *
 * Проблема: дефолтный @nestjs/throttler держит бакеты в in-memory Map внутри
 * ThrottlerStorageService (node_modules/@nestjs/throttler/dist/throttler.service.js:11).
 * Два последствия на Railway с scale > 1:
 *   1. Каждая реплика — свой Map. LB round-robin'ит запросы, поэтому реальный
 *      лимит = declared_limit × N_pods. Anti-bonus-inflation guard в
 *      finance.controller.ts (20 POST/min) на 3 подах превращается в 60/min
 *      тихо и незаметно — тестировать это на локале нельзя.
 *   2. Любой redeploy (Railway их 10+/день) обнуляет все счётчики. Brute-force
 *      protection на POST /student-auth/login (10/15min) и POST /applications/public
 *      (5/min) ресетится на каждом push'е — злоумышленник получает окно неограни-
 *      ченного brute'а на каждой отправке в main.
 *
 * Каноничный fix — Redis-backed storage (`@nest-lab/throttler-storage-redis`),
 * но Redis-клиент в проекте не установлен и добавлять новую зависимость
 * задачей запрещено. Шарим бакеты через уже используемый Postgres: одна
 * маленькая таблица `ThrottleHit`, атомарный UPSERT с CASE-выражениями
 * повторяет семантику in-memory ThrottlerStorageService (window rollover,
 * suppress-increment-while-blocked, block-application), одной round-trip'ой,
 * без внешних race'ов (row-level lock у Postgres при INSERT ... ON CONFLICT
 * DO UPDATE снимает lost-update).
 *
 * Постгрес разделяет счётчики между всеми репликами → лимиты фактически
 * действуют, и rows переживают redeploy → brute-force protection не ресетится.
 *
 * Fallback: если Postgres недоступен, деградируем к in-memory (легаси-поведение
 * per-replica). Иначе rate-limit развалится в fail-open «пропускай всё», что
 * хуже, чем немного заниженные лимиты на одну реплику во время инцидента.
 * После первого сбоя приостанавливаем DB-попытки на 30 секунд (circuit-break),
 * чтобы не бомбить лежащий постгрес каждым запросом и не заваливать логи.
 */
@Injectable()
export class PrismaThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(PrismaThrottlerStorage.name);

  // In-memory fallback на случай недоступности Postgres. Семантика упрощена
  // (без прицельной синхронизации между репликами — по определению) — этого
  // достаточно для аварийной деградации до момента восстановления БД.
  private readonly fallback = new Map<
    string,
    { totalHits: number; expiresAt: number; blockedUntil: number }
  >();

  // Circuit-break. После сбоя $queryRaw пропускаем БД-путь до этой отметки —
  // рейт-лимитер продолжает работать per-replica, БД не бомбим.
  private dbSuspendedUntil = 0;

  constructor(private readonly prisma: PrismaService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    if (this.dbSuspendedUntil > now) {
      return this.incrementFallback(key, ttl, limit, blockDuration, now);
    }
    try {
      const record = await this.incrementInDb(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
        now,
      );
      // Opportunistic GC мёртвых окон. ~0.2% запросов запускают sweep
      // строк, у которых и окно, и блок уже истекли > минуты назад.
      // Отдельный cron не заводим ради одной таблицы — по трафику ERP
      // (сотни запросов/минуту) этой частоты хватает, чтобы удерживать
      // размер таблицы в единицах тысяч строк.
      if (Math.random() < 0.002) {
        this.prisma
          .$executeRaw`
            DELETE FROM "ThrottleHit"
            WHERE "expiresAt" < ${new Date(now - 60_000)}
              AND ("blockedUntil" IS NULL OR "blockedUntil" < ${new Date(now)})
          `.catch(() => undefined);
      }
      return record;
    } catch (err) {
      this.logger.error(
        `Prisma throttler storage failed, falling back to in-memory for 30s: ${
          (err as Error).message
        }`,
      );
      this.dbSuspendedUntil = now + 30_000;
      return this.incrementFallback(key, ttl, limit, blockDuration, now);
    }
  }

  private async incrementInDb(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
    now: number,
  ): Promise<ThrottlerStorageRecord> {
    const expiresAt = new Date(now + ttl);
    const nowTs = new Date(now);
    // Атомарный UPSERT: одной операцией создаём строку, инкрементим, сбрасываем
    // окно если истекло, и НЕ трогаем счётчик если запрос пришёл во время
    // активного блока. Совместимо с in-memory ThrottlerStorageService.increment
    // (см. throttler.service.js:48-79):
    //   - если !isBlocked → fireHitCount (мы: инкремент);
    //   - если окно истекло и блок снят → reset (мы: totalHits=1, expiresAt=new);
    //   - если окно истекло, но блок ещё висит → возвращаем blocked без
    //     инкремента (мы: totalHits/expiresAt/blockedUntil сохраняем как есть).
    const rows = await this.prisma.$queryRaw<
      Array<{ totalHits: number; expiresAt: Date; blockedUntil: Date | null }>
    >`
      INSERT INTO "ThrottleHit" ("key", "throttlerName", "totalHits", "expiresAt", "blockedUntil", "updatedAt")
      VALUES (${key}, ${throttlerName}, 1, ${expiresAt}, NULL, NOW())
      ON CONFLICT ("key") DO UPDATE SET
        "totalHits" = CASE
          WHEN "ThrottleHit"."blockedUntil" IS NOT NULL
               AND "ThrottleHit"."blockedUntil" > ${nowTs}
            THEN "ThrottleHit"."totalHits"
          WHEN "ThrottleHit"."expiresAt" <= ${nowTs}
            THEN 1
          ELSE "ThrottleHit"."totalHits" + 1
        END,
        "expiresAt" = CASE
          WHEN "ThrottleHit"."blockedUntil" IS NOT NULL
               AND "ThrottleHit"."blockedUntil" > ${nowTs}
            THEN "ThrottleHit"."expiresAt"
          WHEN "ThrottleHit"."expiresAt" <= ${nowTs}
            THEN EXCLUDED."expiresAt"
          ELSE "ThrottleHit"."expiresAt"
        END,
        "blockedUntil" = CASE
          WHEN "ThrottleHit"."blockedUntil" IS NOT NULL
               AND "ThrottleHit"."blockedUntil" > ${nowTs}
            THEN "ThrottleHit"."blockedUntil"
          WHEN "ThrottleHit"."expiresAt" <= ${nowTs}
            THEN NULL
          ELSE "ThrottleHit"."blockedUntil"
        END,
        "throttlerName" = EXCLUDED."throttlerName",
        "updatedAt" = NOW()
      RETURNING "totalHits", "expiresAt", "blockedUntil"
    `;
    const row = rows[0];
    if (!row) {
      // Такого быть не должно — INSERT ... ON CONFLICT DO UPDATE RETURNING
      // всегда возвращает строку. Защитная ветка на случай, если Prisma
      // поменяет поведение RETURNING в будущих версиях.
      throw new Error('ThrottleHit upsert returned no row');
    }
    let blockedUntilMs = row.blockedUntil ? row.blockedUntil.getTime() : 0;
    // Если инкремент вывел totalHits за лимит и блок ещё не проставлен —
    // ставим отдельным UPDATE. `limit` не запихиваем в UPSERT CASE'ом
    // сознательно: параметр int в тексте raw-SQL в комбинации с CASE
    // приводит к нюансам типизации на стороне Postgres (int/bigint), и
    // отдельный UPDATE читается заметно проще. Один лишний round-trip
    // случается только на переходе через лимит (обычно раз в окно).
    if (row.totalHits > limit && blockedUntilMs <= now) {
      const blockUntil = new Date(now + blockDuration);
      await this.prisma.$executeRaw`
        UPDATE "ThrottleHit"
        SET "blockedUntil" = ${blockUntil}, "updatedAt" = NOW()
        WHERE "key" = ${key}
          AND ("blockedUntil" IS NULL OR "blockedUntil" <= ${nowTs})
      `;
      blockedUntilMs = blockUntil.getTime();
    }
    const isBlocked = blockedUntilMs > now;
    return {
      totalHits: row.totalHits,
      timeToExpire: Math.max(
        0,
        Math.ceil((row.expiresAt.getTime() - now) / 1000),
      ),
      isBlocked,
      timeToBlockExpire: isBlocked
        ? Math.ceil((blockedUntilMs - now) / 1000)
        : 0,
    };
  }

  private incrementFallback(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    now: number,
  ): ThrottlerStorageRecord {
    let rec = this.fallback.get(key);
    if (!rec) {
      rec = { totalHits: 0, expiresAt: 0, blockedUntil: 0 };
      this.fallback.set(key, rec);
    }
    // window rollover: и окно, и блок оба истекли → новое окно
    if (rec.blockedUntil <= now && rec.expiresAt <= now) {
      rec.totalHits = 0;
      rec.expiresAt = now + ttl;
      rec.blockedUntil = 0;
    }
    if (rec.blockedUntil > now) {
      // Всё ещё под блоком — не инкрементим (совместимо с in-memory сервисом).
      return {
        totalHits: rec.totalHits,
        timeToExpire: Math.max(0, Math.ceil((rec.expiresAt - now) / 1000)),
        isBlocked: true,
        timeToBlockExpire: Math.ceil((rec.blockedUntil - now) / 1000),
      };
    }
    rec.totalHits += 1;
    if (rec.totalHits > limit) {
      rec.blockedUntil = now + blockDuration;
    }
    const isBlocked = rec.blockedUntil > now;
    // Мягкий cap на размер fallback-мапы — на случай, если Postgres пролежит
    // долго и уникальных ключей накопятся десятки тысяч. Полностью очищаем
    // при переполнении (per-instance деградация всё равно, точность не важна).
    if (this.fallback.size > 10_000) this.fallback.clear();
    return {
      totalHits: rec.totalHits,
      timeToExpire: Math.max(0, Math.ceil((rec.expiresAt - now) / 1000)),
      isBlocked,
      timeToBlockExpire: isBlocked
        ? Math.ceil((rec.blockedUntil - now) / 1000)
        : 0,
    };
  }
}
