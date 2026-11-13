import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  LEAD_STATUS_MIGRATION_ENV,
  isLeadStatusRowMigrationEnabled,
} from '../common/application-status';
import { AUDITED_MODELS, requestContext, staffActorOf } from '../common/request-context';

const SOFT_DELETE_READS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'groupBy', 'aggregate']);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // Заявки из корзины (deletedAt) не попадают ни в один список, счётчик,
    // KPI и отчёт — одним правилом, а не условием в каждом из ~40 запросов.
    // Запрос, который сам упоминает deletedAt (экран «Удалённые»,
    // восстановление), фильтр не трогает.
    this.$use(async (params, next) => {
      if (params.model === 'Application' && SOFT_DELETE_READS.has(params.action)) {
        params.args = params.args ?? {};
        const where = params.args.where ?? {};
        if (!('deletedAt' in where)) params.args.where = { ...where, deletedAt: null };
      }
      return next(params);
    });
    // Журнал действий: создания и удаления важных записей (лиды, студенты,
    // сделки, платежи, партнёры, группы, курсы, звонки, задачи, программы,
    // сотрудники…) — одним правилом здесь, а не вызовом в каждом сервисе.
    // Событие лишь откладывается в контекст запроса; в журнал оно уйдёт после
    // ответа и только если запрос успешен (main.ts) — откат не оставит следа.
    this.$use(async (params, next) => {
      const ctx = requestContext.getStore();
      if (!ctx || !params.model || !AUDITED_MODELS.has(params.model) || !staffActorOf(ctx.req)) {
        return next(params);
      }
      const model = params.model;
      if (params.action === 'create' || params.action === 'delete') {
        const row = await next(params);
        if (row && typeof row === 'object') ctx.events.push({ kind: params.action, model, row });
        return row;
      }
      // Мягкие удаления: лид — в корзину (deletedAt), сотрудник — «Уволить»
      // (isActive). Считаем только настоящую смену состояния.
      const data = params.action === 'update' ? params.args?.data ?? {} : null;
      const softKey = model === 'Application' ? 'deletedAt' : model === 'User' ? 'isActive' : null;
      if (!data || !softKey || !(softKey in data)) return next(params);
      const raw = data[softKey];
      const value = raw && typeof raw === 'object' && 'set' in raw ? raw.set : raw;
      const before: any = await (this as any)[model === 'User' ? 'user' : 'application']
        .findUnique({ where: params.args.where, select: { [softKey]: true } })
        .catch(() => null);
      const row = await next(params);
      if (before && row && typeof row === 'object') {
        if (model === 'Application') {
          const was = !!before.deletedAt;
          if (!was && value) ctx.events.push({ kind: 'delete', model, row });
          else if (was && !value) ctx.events.push({ kind: 'restore', model, row });
        } else if (typeof value === 'boolean' && before.isActive !== value) {
          ctx.events.push({ kind: value ? 'restore' : 'fire', model, row });
        }
      }
      return row;
    });
    await this.$connect();
    await this.migrateLegacyStatuses();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Страховка: подчищает два самых старых статуса заявок. По умолчанию НЕ
   * ДЕЛАЕТ НИЧЕГО — нужен явный MIGRATE_LEAD_STATUSES.
   *
   * ⚠️ Почему опт-ин, хотя это «всего лишь страховка». Хук висит на
   * onModuleInit, то есть отрабатывает внутри NestFactory.create() — ДО
   * `app.listen()` в main.ts. Пока новый процесс не слушает порт, Railway
   * продолжает отдавать трафик ПРЕДЫДУЩЕМУ контейнеру. Его сгенерённый
   * Prisma-клиент знает только старый набор значений enum'а, и первая же
   * строка, переведённая здесь в IN_PROCESSING/SUCCESSFUL_LEAD, ломает ему
   * десериализацию: 500 на GET /applications, /applications/stats, /students,
   * /kpi/leaderboard и student-auth `me`. Причём этот хук выполняется на
   * КАЖДОМ буте, а не только на деплое смены схемы, — то есть без флага он
   * подкладывал бы эту мину под каждый рестарт, пока в БД есть легаси-строки.
   *
   * Читать легаси-строки новый код умеет и без переноса (компат-списки в
   * src/common/application-status.ts), так что откладывание миграции ничего
   * не ломает — оно только оставляет данные неприбранными.
   *
   * Полную миграцию делает prisma/migrate-lead-statuses.ts (все восемь старых
   * значений, с логами по бакетам) — он гейтится тем же флагом. Здесь остаётся
   * исторический хвост из двух значений на случай окружения, где скрипт не
   * отработал; порядок раскатки описан в DEPLOY.md.
   *
   * Раньше эти два значения переезжали на DOCS_REVIEW/ENROLLED — то есть на
   * значения, которые сами уже стали легаси. Теперь целимся сразу в актуальный
   * набор квалификации лида, иначе хук воскрешал бы старые статусы после того,
   * как их вычистил скрипт.
   *
   * Только сырой SQL. Application.updatedAt помечен `@updatedAt`, и Prisma
   * проставляет его клиентски на каждом updateMany (DB-триггера нет). Прогон
   * через клиент переписывал бы updatedAt мигрируемым строкам на дату старта
   * процесса — а по этой колонке считаются KPI-окна (kpi.service
   * applicationsEnrolled, users.service enrolledMonth → kpiAchievedPct) и
   * отбор «без движения 7+ дней» в cron.service.stalePipeline.
   * UPDATE ниже трогает только status; см. prisma/migrate-lead-statuses.ts.
   */
  private async migrateLegacyStatuses() {
    if (!isLeadStatusRowMigrationEnabled()) {
      // debug, а не log: на каждом буте здорового окружения это шум.
      this.logger.debug(
        `Перенос легаси-статусов пропущен: ${LEAD_STATUS_MIGRATION_ENV} не выставлена. ` +
          'Легаси-строки читаются компат-списками (src/common/application-status.ts).',
      );
      return;
    }

    // status::text вместо каста параметра к enum'у: когда легаси-значения
    // выпилят из ApplicationStatus, каст бросил бы ошибку, а сравнение с
    // текстом просто не найдёт строк — ровно то поведение, что нужно.
    const buckets: { from: string; to: string }[] = [
      { from: 'IN_PROGRESS', to: 'IN_PROCESSING' },
      { from: 'COMPLETED', to: 'SUCCESSFUL_LEAD' },
    ];
    try {
      const moved: string[] = [];
      for (const { from, to } of buckets) {
        const count = await this.$executeRawUnsafe(
          `UPDATE "Application" SET status = $1 WHERE status = $2`,
          to,
          from,
        );
        if (count > 0) moved.push(`${from}→${to}=${count}`);
      }
      if (moved.length > 0) {
        this.logger.log(`Migrated legacy statuses: ${moved.join(', ')}`);
      }
    } catch (err) {
      this.logger.warn(`Status migration skipped: ${(err as Error).message}`);
    }
  }
}
