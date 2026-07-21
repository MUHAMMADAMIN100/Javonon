import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, RevenueBucketKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { CreateBucketDto } from './dto/create-bucket.dto';
import { UpdateBucketDto } from './dto/update-bucket.dto';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';

/**
 * Actor контекст для мутаций схемы распределения. Тот же shape, что
 * FinanceActor: id — из JWT, role — попадает в ActivityLog.actorRole,
 * чтобы FOUNDER мог отфильтровать /activity по «REVENUE_SCHEME_RESET
 * от FOUNDER». Опциональный, потому что внутренние вызывающие
 * (сид, тесты) actor'а не имеют — для них пишем 'SYSTEM'.
 */
export type RevenueSchemeActor = {
  id?: string | null;
  role?: string | null;
};

/**
 * Дефолтная схема с картинки FOUNDER'а. Сеется однократно при первом
 * запуске (см. onModuleInit) и повторно при POST /admin/revenue-scheme/reset.
 * Идемпотентно: при seed'е сначала проверяем count()==0; при reset —
 * стираем текущий bucket-tree активной схемы и заново создаём items.
 *
 * amountCents считаем как «сомони × 100» — совпадает с копеечной моделью
 * фронта (см. финансовые формы, где 1 000 000 сомони = 100_000_000 копеек).
 */
type SeedBucket = {
  name: string;
  kind: RevenueBucketKind;
  color: string;
  percent: number | null;
  items: Array<{ name: string; amountCents: number | null }>;
};
const DEFAULT_SCHEME: SeedBucket[] = [
  { name: 'Благотворительность', kind: 'PERCENTAGE', color: '#ffffff', percent: 10, items: [] },
  { name: 'Налоги',              kind: 'PERCENTAGE', color: '#ef4444', percent: 10, items: [] },
  { name: 'Отдел продаж',        kind: 'PERCENTAGE', color: '#f59e0b', percent: 10, items: [] },
  {
    name: 'Маркетинг',
    kind: 'PERCENTAGE',
    color: '#3b82f6',
    percent: 5,
    items: [
      { name: 'Таргет', amountCents: null },
      { name: 'Съёмка и монтаж Reels', amountCents: null },
    ],
  },
  {
    name: 'Фонд развития',
    kind: 'PERCENTAGE',
    color: '#ffffff',
    percent: 5,
    items: [
      { name: 'Оборудование', amountCents: null },
      { name: 'Техника', amountCents: null },
      { name: 'Оформление', amountCents: null },
    ],
  },
  {
    name: 'Фонд оплаты труда',
    kind: 'FIXED_SUM',
    color: '#ef4444',
    percent: null,
    items: [
      { name: 'Alijon', amountCents: 1000000 },
      { name: 'Ahmadshoh', amountCents: 200000 },
      { name: 'DilMuhammad', amountCents: 200000 },
      { name: 'Khurshed', amountCents: 350000 },
      { name: 'Saida', amountCents: 150000 },
      { name: 'Komil', amountCents: 350000 },
      { name: 'Dilnoza', amountCents: 100000 },
      { name: 'Farrukh', amountCents: 100000 },
    ],
  },
  {
    name: 'Себестоимость услуги',
    kind: 'FIXED_SUM',
    color: '#f59e0b',
    percent: null,
    items: [
      { name: 'Аренда', amountCents: 500000 },
      { name: 'Аренда 2', amountCents: 250000 },
      { name: 'Академия (6 месяцев)', amountCents: 420000 },
      { name: 'Сертификат IELTS', amountCents: 250000 },
      { name: 'Подача документов', amountCents: 500000 },
    ],
  },
];

@Injectable()
export class RevenueSchemeService implements OnModuleInit {
  private readonly logger = new Logger(RevenueSchemeService.name);

  constructor(
    private prisma: PrismaService,
    // ActivityService — аудит мутаций схемы. Без записи в ActivityLog
    // reset() тихо сносил весь Фонд оплаты труда с именованными
    // зарплатами, а /activity показывал пустоту — единственный след
    // оставался в Postgres WAL / Prisma logs. Тот же pattern
    // best-effort через .catch(() => undefined) что и в FinanceService:
    // падение аудита не должно откатывать саму мутацию.
    private activity: ActivityService,
  ) {}

  /**
   * Идемпотентный seed при старте. Если хоть одна RevenueScheme в БД
   * уже есть — no-op (не хотим перетереть отредактированное FOUNDER'ом
   * значение при redeploy'е). Первый деплой создаёт дефолт с картинки.
   */
  async onModuleInit() {
    try {
      const count = await this.prisma.revenueScheme.count();
      if (count > 0) return;
      await this.seedDefault();
      this.logger.log('Дефолтная схема распределения выручки создана');
    } catch (e) {
      // Если Prisma-migration ещё не прогналась (Railway `db push` может
      // отстать от кода) — не падаем: следующий рестарт после миграции
      // отработает нормально.
      this.logger.warn(`Не удалось засеедить RevenueScheme: ${(e as Error).message}`);
    }
  }

  /**
   * Активная схема со всеми buckets/items, отсортированная по order
   * (и по createdAt как tie-breaker для стабильного порядка при равных
   * order — например после seed'а, где order у всех = 0).
   */
  async getActive() {
    const scheme = await this.prisma.revenueScheme.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      include: {
        buckets: {
          // Вторичная сортировка по name/id — стабилизирует порядок для
          // легаси-данных, где ещё могут остаться дубликаты order
          // (уникальный индекс добавили позже, до миграции таких
          // строк не отфильтровать). Для свежих данных tie-breaker
          // никогда не срабатывает — @@unique гарантирует, что order
          // в рамках схемы уникален.
          orderBy: [{ order: 'asc' }, { name: 'asc' }, { id: 'asc' }],
          include: {
            items: {
              orderBy: [{ order: 'asc' }, { name: 'asc' }, { id: 'asc' }],
              include: {
                user: { select: { id: true, fullName: true } },
              },
            },
          },
        },
      },
    });
    if (!scheme) {
      // Если по какой-то причине (первый запрос до onModuleInit / гонка)
      // схемы нет — сеем сейчас и возвращаем свежую.
      await this.seedDefault();
      return this.getActive();
    }
    return scheme;
  }

  // ===================== Buckets =====================

  async createBucket(dto: CreateBucketDto, actor: RevenueSchemeActor = {}) {
    const scheme = await this.getActiveOrThrow();
    this.validateBucketKindPercent(dto.kind, dto.percent ?? null);
    // Retry-loop нужен, потому что nextBucketOrder читает max(order)
    // ВНЕ транзакции с изоляцией, поэтому два параллельных POST'а
    // могут получить одинаковый candidateOrder. Уникальный индекс
    // (schemeId, order) поймает второго — здесь мы это ловим и
    // прыгаем в свежий хвост. То же самое ловит явный dto.order,
    // если он уже занят — молчаливая перезапись расклада FOUNDER'а
    // была бы хуже, чем placement «в конец».
    const created = await this.createBucketWithRetry(scheme.id, dto);
    // Аудит: без REVENUE_BUCKET_CREATE FOUNDER не мог бы ответить
    // «кто и когда добавил bucket "Новая статья" в схему распределения».
    // Best-effort — падение аудита не должно откатывать саму запись.
    this.activity
      .log({
        actorId: actor.id ?? null,
        actorRole: actor.role || 'SYSTEM',
        action: 'REVENUE_BUCKET_CREATE',
        details: `Bucket «${created.name}» создан (${created.kind}${created.percent !== null ? `, ${created.percent}%` : ''})`,
        payload: {
          schemeId: scheme.id,
          bucketId: created.id,
          name: created.name,
          kind: created.kind,
          color: created.color,
          percent: created.percent,
          order: created.order,
        },
      })
      .catch(() => undefined);
    return created;
  }

  private async createBucketWithRetry(schemeId: string, dto: CreateBucketDto) {
    const MAX_ATTEMPTS = 5;
    let order = dto.order ?? (await this.nextBucketOrder(schemeId));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.revenueBucket.create({
          data: {
            schemeId,
            kind: dto.kind,
            name: dto.name,
            color: dto.color ?? null,
            percent: dto.kind === 'PERCENTAGE' ? (dto.percent ?? 0) : null,
            order,
          },
        });
      } catch (e) {
        if (this.isOrderUniqueConflict(e)) {
          // Слот занят — берём свежий max+1 и ретраим.
          order = await this.nextBucketOrder(schemeId);
          continue;
        }
        throw e;
      }
    }
    throw new BadRequestException('Не удалось выделить свободный слот для bucket, попробуйте ещё раз');
  }

  async updateBucket(id: string, dto: UpdateBucketDto, actor: RevenueSchemeActor = {}) {
    // BEFORE-снимок нужен для audit-payload: без него UPDATE тихо переписал
    // бы percent (драйвит distribution()) без следа «сколько было».
    const bucket = await this.prisma.revenueBucket.findUnique({ where: { id } });
    if (!bucket) throw new NotFoundException('Bucket не найден');
    // Валидируем percent по фактическому kind (kind менять запрещено —
    // см. DTO). Явный null от FOUNDER = «убрать процент» — для FIXED_SUM
    // это ок, для PERCENTAGE — нет.
    if (dto.percent !== undefined) {
      this.validateBucketKindPercent(bucket.kind, dto.percent);
    }
    const updated = await this.prisma.revenueBucket.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.percent !== undefined && { percent: dto.percent }),
        ...(dto.order !== undefined && { order: dto.order }),
      },
    });
    this.activity
      .log({
        actorId: actor.id ?? null,
        actorRole: actor.role || 'SYSTEM',
        action: 'REVENUE_BUCKET_UPDATE',
        details: `Bucket «${bucket.name}» → «${updated.name}» изменён`,
        payload: {
          schemeId: bucket.schemeId,
          bucketId: id,
          before: {
            name: bucket.name,
            kind: bucket.kind,
            color: bucket.color,
            percent: bucket.percent,
            order: bucket.order,
          },
          after: {
            name: updated.name,
            kind: updated.kind,
            color: updated.color,
            percent: updated.percent,
            order: updated.order,
          },
          patch: dto,
        },
      })
      .catch(() => undefined);
    return updated;
  }

  async deleteBucket(id: string, actor: RevenueSchemeActor = {}) {
    // Тянем bucket с items — весь снимок удалённого содержимого
    // попадёт в audit-payload. Особенно критично для FIXED_SUM с
    // именованными зарплатами: без before восстанавливать пришлось бы
    // из Postgres WAL.
    const bucket = await this.prisma.revenueBucket.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!bucket) throw new NotFoundException('Bucket не найден');
    await this.prisma.revenueBucket.delete({ where: { id } });
    this.activity
      .log({
        actorId: actor.id ?? null,
        actorRole: actor.role || 'SYSTEM',
        action: 'REVENUE_BUCKET_DELETE',
        details: `Bucket «${bucket.name}» удалён (${bucket.items.length} позиций)`,
        payload: {
          schemeId: bucket.schemeId,
          bucketId: id,
          before: {
            name: bucket.name,
            kind: bucket.kind,
            color: bucket.color,
            percent: bucket.percent,
            order: bucket.order,
            items: bucket.items.map((it) => ({
              id: it.id,
              name: it.name,
              amountCents: it.amountCents,
              order: it.order,
              userId: it.userId,
            })),
          },
        },
      })
      .catch(() => undefined);
    return { deleted: true };
  }

  // ===================== Items =====================

  async createItem(bucketId: string, dto: CreateItemDto, actor: RevenueSchemeActor = {}) {
    const bucket = await this.prisma.revenueBucket.findUnique({ where: { id: bucketId } });
    if (!bucket) throw new NotFoundException('Bucket не найден');
    this.validateItemAmountByKind(bucket.kind, dto.amountCents ?? null);
    if (dto.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: dto.userId },
        select: { id: true },
      });
      if (!user) throw new BadRequestException('Указанный сотрудник не найден');
    }
    // См. коммент в createBucket: retry-loop страхует от гонки на
    // (bucketId, order) — уникальный индекс её ловит.
    const created = await this.createItemWithRetry(bucketId, dto);
    this.activity
      .log({
        actorId: actor.id ?? null,
        actorRole: actor.role || 'SYSTEM',
        action: 'REVENUE_ITEM_CREATE',
        details: `Позиция «${created.name}» добавлена в bucket «${bucket.name}»`,
        payload: {
          schemeId: bucket.schemeId,
          bucketId,
          bucketName: bucket.name,
          bucketKind: bucket.kind,
          itemId: created.id,
          name: created.name,
          amountCents: created.amountCents,
          order: created.order,
          userId: created.userId,
        },
      })
      .catch(() => undefined);
    return created;
  }

  private async createItemWithRetry(bucketId: string, dto: CreateItemDto) {
    const MAX_ATTEMPTS = 5;
    let order = dto.order ?? (await this.nextItemOrder(bucketId));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.revenueBucketItem.create({
          data: {
            bucketId,
            name: dto.name,
            amountCents: dto.amountCents ?? null,
            order,
            userId: dto.userId ?? null,
          },
          include: { user: { select: { id: true, fullName: true } } },
        });
      } catch (e) {
        if (this.isOrderUniqueConflict(e)) {
          order = await this.nextItemOrder(bucketId);
          continue;
        }
        throw e;
      }
    }
    throw new BadRequestException('Не удалось выделить свободный слот для позиции, попробуйте ещё раз');
  }

  async updateItem(id: string, dto: UpdateItemDto, actor: RevenueSchemeActor = {}) {
    const item = await this.prisma.revenueBucketItem.findUnique({
      where: { id },
      include: { bucket: true },
    });
    if (!item) throw new NotFoundException('Позиция не найдена');
    if (dto.amountCents !== undefined) {
      this.validateItemAmountByKind(item.bucket.kind, dto.amountCents);
    }
    if (dto.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: dto.userId },
        select: { id: true },
      });
      if (!user) throw new BadRequestException('Указанный сотрудник не найден');
    }
    const updated = await this.prisma.revenueBucketItem.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.amountCents !== undefined && { amountCents: dto.amountCents }),
        ...(dto.order !== undefined && { order: dto.order }),
        ...(dto.userId !== undefined && { userId: dto.userId }),
      },
      include: { user: { select: { id: true, fullName: true } } },
    });
    // Before-payload критичен для FIXED_SUM позиций (именованные
    // зарплаты в ФОТ): без него amountCents тихо переписывался бы
    // без следа «сколько было до», а bonus-споры пришлось бы
    // расследовать только по WAL.
    this.activity
      .log({
        actorId: actor.id ?? null,
        actorRole: actor.role || 'SYSTEM',
        action: 'REVENUE_ITEM_UPDATE',
        details: `Позиция «${item.name}» → «${updated.name}» изменена (bucket «${item.bucket.name}»)`,
        payload: {
          schemeId: item.bucket.schemeId,
          bucketId: item.bucketId,
          bucketName: item.bucket.name,
          bucketKind: item.bucket.kind,
          itemId: id,
          before: {
            name: item.name,
            amountCents: item.amountCents,
            order: item.order,
            userId: item.userId,
          },
          after: {
            name: updated.name,
            amountCents: updated.amountCents,
            order: updated.order,
            userId: updated.userId,
          },
          patch: dto,
        },
      })
      .catch(() => undefined);
    return updated;
  }

  async deleteItem(id: string, actor: RevenueSchemeActor = {}) {
    const item = await this.prisma.revenueBucketItem.findUnique({
      where: { id },
      include: { bucket: true },
    });
    if (!item) throw new NotFoundException('Позиция не найдена');
    await this.prisma.revenueBucketItem.delete({ where: { id } });
    this.activity
      .log({
        actorId: actor.id ?? null,
        actorRole: actor.role || 'SYSTEM',
        action: 'REVENUE_ITEM_DELETE',
        details: `Позиция «${item.name}» удалена из bucket «${item.bucket.name}»`,
        payload: {
          schemeId: item.bucket.schemeId,
          bucketId: item.bucketId,
          bucketName: item.bucket.name,
          bucketKind: item.bucket.kind,
          itemId: id,
          before: {
            name: item.name,
            amountCents: item.amountCents,
            order: item.order,
            userId: item.userId,
          },
        },
      })
      .catch(() => undefined);
    return { deleted: true };
  }

  // ===================== Reset =====================

  /**
   * Стирает buckets/items текущей активной схемы (cascade на items) и
   * пересеевает дефолт с картинки. Одна транзакция, чтобы промежуточное
   * состояние «пустая схема» не утекло на фронт при параллельном GET'е.
   *
   * Аудит (HIGH): reset сносит ВЕСЬ Фонд оплаты труда с именованными
   * зарплатами. Раньше не оставлял ни строки в ActivityLog — если бы
   * FOUNDER-токен утёк или сам FOUNDER случайно нажал Reset,
   * восстанавливать пришлось бы из Postgres WAL. Сейчас логируем
   * REVENUE_SCHEME_RESET с полным before-payload (buckets+items),
   * чтобы ревьюер видел исходное состояние — включая amountCents
   * по каждой позиции ФОТ.
   */
  async reset(actor: RevenueSchemeActor = {}) {
    // BEFORE-снимок делаем ВНЕ $transaction, чтобы (а) отдельным
    // read'ом получить include с items не завися от изоляции, (б) даже
    // если сама транзакция откатится, у нас всё равно есть чистый
    // snapshot — но логируем только после успешного commit'а, чтобы
    // на /activity не появлялись фантомные reset'ы для откатов.
    const beforeSnapshot = await this.prisma.revenueScheme.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      include: {
        buckets: {
          orderBy: [{ order: 'asc' }],
          include: {
            items: { orderBy: [{ order: 'asc' }] },
          },
        },
      },
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const active = await tx.revenueScheme.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      if (active) {
        // Delete buckets — items снесутся onDelete: Cascade.
        await tx.revenueBucket.deleteMany({ where: { schemeId: active.id } });
        await this.seedIntoScheme(tx, active.id);
        return tx.revenueScheme.findUnique({
          where: { id: active.id },
          include: {
            buckets: {
              orderBy: [{ order: 'asc' }],
              include: {
                items: {
                  orderBy: [{ order: 'asc' }],
                  include: { user: { select: { id: true, fullName: true } } },
                },
              },
            },
          },
        });
      }
      // Активной схемы нет — просто сеем как при первом запуске.
      await this.seedDefaultInTx(tx);
      return tx.revenueScheme.findFirst({
        where: { isActive: true },
        include: {
          buckets: {
            orderBy: [{ order: 'asc' }],
            include: {
              items: {
                orderBy: [{ order: 'asc' }],
                include: { user: { select: { id: true, fullName: true } } },
              },
            },
          },
        },
      });
    });

    // Только после успешного commit'а — write в ActivityLog.
    // before-payload: полный снимок buckets+items ДО reset'а. Best-effort:
    // падение аудита не должно бросить исключение уже после commit'а, —
    // пользователь получит успех, а /activity просто не увидит следа.
    this.activity
      .log({
        actorId: actor.id ?? null,
        actorRole: actor.role || 'SYSTEM',
        action: 'REVENUE_SCHEME_RESET',
        details: beforeSnapshot
          ? `Схема распределения сброшена к дефолту (было ${beforeSnapshot.buckets.length} bucket'ов, ${beforeSnapshot.buckets.reduce((n, b) => n + b.items.length, 0)} позиций)`
          : 'Схема распределения инициализирована дефолтом (активной схемы не было)',
        payload: {
          schemeId: beforeSnapshot?.id ?? null,
          before: beforeSnapshot
            ? {
                schemeId: beforeSnapshot.id,
                name: beforeSnapshot.name,
                buckets: beforeSnapshot.buckets.map((b) => ({
                  id: b.id,
                  name: b.name,
                  kind: b.kind,
                  color: b.color,
                  percent: b.percent,
                  order: b.order,
                  items: b.items.map((it) => ({
                    id: it.id,
                    name: it.name,
                    amountCents: it.amountCents,
                    order: it.order,
                    userId: it.userId,
                  })),
                })),
              }
            : null,
        },
      })
      .catch(() => undefined);

    return result;
  }

  // ===================== Internals =====================

  private async getActiveOrThrow() {
    const scheme = await this.prisma.revenueScheme.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!scheme) throw new NotFoundException('Активная схема распределения не найдена');
    return scheme;
  }

  private validateBucketKindPercent(kind: RevenueBucketKind, percent: number | null | undefined) {
    if (kind === 'PERCENTAGE') {
      if (percent === null || percent === undefined) {
        throw new BadRequestException('Для PERCENTAGE percent обязателен (0..100)');
      }
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
        throw new BadRequestException('percent должен быть целым 0..100');
      }
    } else {
      if (percent !== null && percent !== undefined) {
        throw new BadRequestException('Для FIXED_SUM percent должен быть null');
      }
    }
  }

  private validateItemAmountByKind(kind: RevenueBucketKind, amountCents: number | null | undefined) {
    if (kind === 'FIXED_SUM') {
      if (amountCents === null || amountCents === undefined) {
        throw new BadRequestException('Для позиции FIXED_SUM amountCents обязателен');
      }
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        throw new BadRequestException('amountCents должен быть положительным целым');
      }
    } else {
      // PERCENTAGE items — только лейблы; amountCents должен быть null.
      if (amountCents !== null && amountCents !== undefined) {
        throw new BadRequestException('Для позиции PERCENTAGE amountCents должен быть null');
      }
    }
  }

  /**
   * P2002 по нашему уникальному индексу (schemeId, order) /
   * (bucketId, order). Prisma кладёт список колонок в meta.target
   * (стринг-массив или строка — зависит от драйвера); проверяем оба.
   * Всё, что не P2002 — пробрасываем как есть.
   */
  private isOrderUniqueConflict(e: unknown): boolean {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (e.code !== 'P2002') return false;
    const target = (e.meta as { target?: unknown } | undefined)?.target;
    if (Array.isArray(target)) {
      return target.includes('order');
    }
    if (typeof target === 'string') {
      return target.includes('order');
    }
    // meta без target — считаем, что это наш индекс (в create*
    // других уникальных ограничений сейчас нет).
    return true;
  }

  private async nextBucketOrder(schemeId: string): Promise<number> {
    const last = await this.prisma.revenueBucket.findFirst({
      where: { schemeId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    return (last?.order ?? -1) + 1;
  }

  private async nextItemOrder(bucketId: string): Promise<number> {
    const last = await this.prisma.revenueBucketItem.findFirst({
      where: { bucketId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    return (last?.order ?? -1) + 1;
  }

  private async seedDefault() {
    await this.prisma.$transaction(async (tx) => {
      await this.seedDefaultInTx(tx);
    });
  }

  private async seedDefaultInTx(tx: Prisma.TransactionClient) {
    const scheme = await tx.revenueScheme.create({
      data: {
        name: 'Основная схема',
        isActive: true,
      },
    });
    await this.seedIntoScheme(tx, scheme.id);
  }

  private async seedIntoScheme(tx: Prisma.TransactionClient, schemeId: string) {
    for (let i = 0; i < DEFAULT_SCHEME.length; i++) {
      const b = DEFAULT_SCHEME[i];
      const bucket = await tx.revenueBucket.create({
        data: {
          schemeId,
          kind: b.kind,
          name: b.name,
          color: b.color,
          percent: b.kind === 'PERCENTAGE' ? b.percent : null,
          order: i,
        },
      });
      for (let j = 0; j < b.items.length; j++) {
        const it = b.items[j];
        await tx.revenueBucketItem.create({
          data: {
            bucketId: bucket.id,
            name: it.name,
            amountCents: it.amountCents,
            order: j,
          },
        });
      }
    }
  }
}
