import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { requireJwtSecret } from '../auth/jwt-secret';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Audit fix (HIGH): rate-limits должны быть per-user, а не per-IP.
 *
 * Проблема стокового ThrottlerGuard: он трекает по req.ip. В офисе за
 * NAT/CGNAT/корпоративным прокси (типовой сценарий для этой ERP —
 * менеджеры сидят на одном офисном WiFi) все SALES_MANAGER +
 * CLIENT_MANAGER + ACCOUNTANT + FOUNDER делят один и тот же 20/min
 * бакет на POST/PATCH /finance/transactions. Как только суммарно 20
 * транзакций за минуту прошли — все получают 429, включая FOUNDER'а,
 * который пытается это чинить. Заявленный anti-bonus-inflation goal
 * («20 правок/мин на пользователя», см. finance.controller.ts) по
 * факту не работал.
 *
 * Решение: субклассим ThrottlerGuard и переопределяем getTracker так,
 * чтобы ключом бакета был user.id (из JWT), а не IP. Для публичных
 * эндпоинтов без авторизации (POST /applications/public, POST
 * /student-auth/login) req.user не будет — там честно падаем на req.ip,
 * что и так корректная стратегия для anonymous rate-limit.
 *
 * ВАЖНО (regression fix): раньше getTracker читал req.user?.id, но
 * UserThrottlerGuard зарегистрирован через APP_GUARD (см. app.module.ts),
 * а JwtAuthGuard навешан на уровне контроллеров через @UseGuards().
 * Nest выполняет глобальные guards ДО controller-scoped, поэтому
 * req.user на этой стадии undefined для 100% запросов, и весь трекинг
 * скатывался обратно к req.ip — то есть офисный NAT-баг оставался.
 * Теперь getTracker сам верифицирует JWT (тем же секретом, что и
 * shouldSkip / uploads-auth) и возвращает user:<sub>. Payload
 * кэшируется на req под символьным ключом, чтобы не верифицировать
 * подпись дважды в рамках одного запроса.
 *
 * `name` в generateKey отделяет бакеты разных @Throttle({ name: ... })
 * друг от друга, поэтому дефолтный (60/min) и per-controller
 * (20/min на finance) не пересекаются между собой — этим занимается
 * сам ThrottlerGuard, тут ничего дополнительно делать не нужно.
 *
 * ---
 *
 * Audit fix (HIGH, «FOUNDER заблокирован на своих же исторических
 * импортах»): elevated роли (FOUNDER / ADMIN / ACCOUNTANT) полностью
 * пропускаются через throttle. Причина — finance.service.ts
 * (validateTransactionDate) специально снимает окно ±3 суток именно
 * для этих ролей: закрытие месяца, восстановление пропущенных платежей,
 * импорт истории из старых Google-таблиц. Но throttle 20/min на POST/PATCH
 * /finance/transactions не имел никакого исключения по роли — импорт
 * 5000 строк упирался в 4+ часа сна вида «отправил → 429 → жди минуту»,
 * а закрытие месяца бухгалтером фактически приходилось делать половину
 * рабочего дня. Date-window exemption в сервисе становился бесполезен:
 * дату задним числом поставить можно, но не успеть внести физически.
 *
 * Проверяем роль напрямую из JWT (payload.role / payload.roles),
 * потому что APP_GUARD выполняется ДО JwtAuthGuard — req.user на этом
 * этапе ещё не заполнен. Секрет и разбор токена — тот же JwtService,
 * что и в UploadsAuthMiddleware. Невалидный/просроченный токен →
 * возвращаем false и throttle применяется как обычно (чтобы атакующий
 * с мусорным Authorization не мог обойти лимит).
 *
 * Bonus-inflation goal сохраняется: SALES_MANAGER / CLIENT_MANAGER
 * НЕ elevated, к ним 20/min по-прежнему применяется на POST/PATCH.
 *
 * ---
 *
 * Audit fix (HIGH, «stale/украденный JWT сохраняет elevated bypass до
 * истечения 7д TTL»): раньше shouldSkip доверял только payload.role /
 * payload.roles из подписи. Последствия:
 *   1. Утёкший FOUNDER-токен (dev-машина, browser storage, Sentry
 *      breadcrumb, скриншот) давал атакующему unlimited-throttle
 *      POST /finance/transactions на все 7 дней жизни токена — 401 не
 *      возникнет, JwtAuthGuard тоже пропускает, потому что подпись валидна.
 *   2. Демоушн (FOUNDER → SALES_MANAGER) или увольнение сотрудника меняет
 *      только строку в БД. Его старый токен продолжает say `role: 'FOUNDER'`
 *      до истечения — и до истечения он может, скажем, накрутить бонусы
 *      правкой транзакций (validateTransactionDate тоже смотрит только на
 *      payload-роль косвенно, но throttle bypass — это уже 5000+ правок/мин
 *      без какого-либо лимита).
 * Fix: после JWT-верификации, если в токене есть elevated роль, идём в БД
 * и пере-читаем актуальные role + roles для payload.sub. Результат кэшируем
 * на несколько секунд (см. ROLE_CHECK_TTL_MS), чтобы легитимный импорт
 * 5000 строк FOUNDER'ом не превращался в 5000 SELECT-ов, но при этом
 * реальный демоушн/увольнение фактически срабатывает в течение секунд,
 * а не 7 дней. JwtStrategy.validate() уже делает похожий DB re-read
 * для custom-role permissions по каждому запросу — консистентно.
 * Если пользователя нет в БД (удалён) или DB недоступна — fail-closed,
 * bypass не даём.
 */
const ELEVATED_ROLES = new Set(['FOUNDER', 'ADMIN', 'ACCOUNTANT']);

// TTL кэша DB-проверки роли. Компромисс: чем короче — тем быстрее фактически
// срабатывает демоушн/увольнение (окно, в которое stale-токен ещё может
// эксплуатировать bypass); чем длиннее — тем меньше SELECT-ов на массовых
// операциях (импорт истории, закрытие месяца). 5 секунд — легитимный импорт
// упирается в rate самого сервиса, не в БД; окно эксплойта — секунды.
const ROLE_CHECK_TTL_MS = 5_000;

// Верхняя граница размера кэша. Кэш держится только для elevated JWT
// (FOUNDER/ADMIN/ACCOUNTANT — их единицы), поэтому лимита в 1000 хватает
// с запасом даже для расширения штата. При переполнении сначала чистим
// просроченные, потом (если не помогло) сбрасываем полностью — дешевле,
// чем LRU без внешних зависимостей.
const ROLE_CACHE_MAX_ENTRIES = 1_000;

// Кэшируем результат верификации JWT на объекте запроса, чтобы shouldSkip
// и getTracker не парсили токен дважды. Symbol — чтобы гарантированно не
// столкнуться с полями, которые кладут другие middleware/guards.
const JWT_CACHE = Symbol('userThrottlerJwtCache');

type JwtPayload = {
  sub?: string;
  role?: string;
  roles?: string[];
  [k: string]: unknown;
};

// null = уже пробовали и токен невалидный/отсутствует. undefined = ещё не пробовали.
type JwtCacheEntry = JwtPayload | null;

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly jwtSecret: string;
  // In-memory кэш DB re-check ролей: userId → { elevated, expiresAt }.
  // Живёт в рамках инстанса процесса. Рейт-лимит бакеты уже шарятся через
  // Postgres (см. PrismaThrottlerStorage в app.module.ts), но этот кэш
  // сознательно per-instance: DB re-check роли — быстрый SELECT, а
  // распределённый кэш ради 5-секундного TTL не оправдан. Разъезд между
  // репликами сходится за ROLE_CHECK_TTL_MS.
  private readonly roleCache = new Map<string, { elevated: boolean; expiresAt: number }>();

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
    config: ConfigService,
    // PrismaModule @Global — импорт в AppModule не нужен, DI резолвит.
    // Нужен для DB re-check роли (см. isElevatedInDb / комментарий на классе).
    private readonly prisma: PrismaService,
  ) {
    super(options, storage, reflector);
    // Тот же секрет, что и вся авторизация (см. jwt.strategy.ts /
    // uploads-auth.middleware.ts). Читаем один раз в конструкторе, чтобы
    // не дёргать ConfigService на каждый запрос.
    this.jwtSecret = requireJwtSecret(config.get<string>('JWT_SECRET'));
  }

  /**
   * Верифицирует Bearer-токен из Authorization и кэширует payload на req.
   * Возвращает null, если токена нет / невалидный / просроченный.
   * Оба хука (shouldSkip + getTracker) вызываются в рамках одного запроса,
   * поэтому кэш экономит одну JWT-верификацию на запрос.
   */
  private verifyJwt(req: Record<string, any> | undefined): JwtPayload | null {
    if (!req) return null;
    const cached = (req as any)[JWT_CACHE] as JwtCacheEntry | undefined;
    if (cached !== undefined) return cached;

    const auth: string | undefined = req?.headers?.authorization;
    if (typeof auth !== 'string') {
      (req as any)[JWT_CACHE] = null;
      return null;
    }
    // Принимаем "Bearer <token>" case-insensitively — некоторые клиенты
    // шлют "bearer " в нижнем регистре, стандарт допускает.
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      (req as any)[JWT_CACHE] = null;
      return null;
    }
    const token = m[1].trim();
    if (!token) {
      (req as any)[JWT_CACHE] = null;
      return null;
    }

    try {
      const payload = this.jwt.verify<JwtPayload>(token, { secret: this.jwtSecret });
      (req as any)[JWT_CACHE] = payload;
      return payload;
    } catch {
      (req as any)[JWT_CACHE] = null;
      return null;
    }
  }

  /**
   * Пропускаем throttle для FOUNDER / ADMIN / ACCOUNTANT.
   * Логика прописана в комментарии на классе. Для всех остальных —
   * стандартный super.shouldSkip() (учитывает @SkipThrottle()).
   */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (await super.shouldSkip(context)) return true;

    const req = context.switchToHttp().getRequest();
    const payload = this.verifyJwt(req);
    // Невалидный/просроченный/отсутствующий токен — НЕ обходим throttle.
    // Пусть JwtAuthGuard ниже по стеку сам вернёт 401; throttle тем временем
    // защитит от brute-force попыток подсунуть мусорный Bearer.
    if (!payload) return false;

    const roles: string[] = [
      payload?.role,
      ...(Array.isArray(payload?.roles) ? payload.roles : []),
    ].filter((r): r is string => typeof r === 'string');
    // Быстрый отсев: если в самом токене нет elevated роли — на bypass
    // рассчитывать нечего, DB-проверку не делаем (и кэш не засоряем
    // записями обычных менеджеров).
    if (!roles.some((r) => ELEVATED_ROLES.has(r))) return false;

    // DB re-check: подтверждаем, что пользователь всё ещё существует и всё
    // ещё имеет elevated роль. Защищает от stale-токена (демоушн/увольнение)
    // и от кражи токена уже де-эскалированного аккаунта. См. комментарий
    // на классе.
    const sub = typeof payload?.sub === 'string' ? payload.sub : undefined;
    if (!sub) return false;
    return this.isElevatedInDb(sub);
  }

  /**
   * Проверяет по свежей БД, что userId всё ещё имеет elevated роль
   * (FOUNDER / ADMIN / ACCOUNTANT). Кэш на ROLE_CHECK_TTL_MS — чтобы
   * массовые операции (импорт из Google-таблиц, закрытие месяца) не
   * упирались в БД на каждой строке.
   *
   * Fail-closed: если пользователь не найден (удалён) ИЛИ БД недоступна —
   * возвращаем false, то есть НЕ обходим throttle. Лучше пусть FOUNDER
   * получит пару 429 во время БД-инцидента, чем attacker с украденным
   * токеном получит unlimited bypass.
   */
  private async isElevatedInDb(userId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.roleCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.elevated;

    let elevated = false;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, roles: true },
      });
      if (user) {
        // Prisma-типы Role[] структурно совместимы со string[] на runtime
        // (это Postgres enum). Приводим к string[] для сравнения с
        // ELEVATED_ROLES без завязки на конкретный импорт enum'а.
        const dbRoles: string[] = [
          user.role as unknown as string,
          ...(((user.roles as unknown as string[]) ?? [])),
        ].filter((r): r is string => typeof r === 'string');
        elevated = dbRoles.some((r) => ELEVATED_ROLES.has(r));
      }
      // user === null → удалённый юзер с ещё живой подписью JWT.
      // elevated остаётся false — bypass не даём.
    } catch {
      // БД недоступна. Fail-closed по причинам выше.
      elevated = false;
    }

    // Простая эвикция: чистим просроченные, при переполнении сбрасываем.
    // Не LRU, но кэш держит только elevated-пользователей (FOUNDER/ADMIN/
    // ACCOUNTANT — единицы), поэтому реального переполнения не будет.
    if (this.roleCache.size >= ROLE_CACHE_MAX_ENTRIES) {
      for (const [k, v] of this.roleCache) {
        if (v.expiresAt <= now) this.roleCache.delete(k);
      }
      if (this.roleCache.size >= ROLE_CACHE_MAX_ENTRIES) this.roleCache.clear();
    }
    this.roleCache.set(userId, { elevated, expiresAt: now + ROLE_CHECK_TTL_MS });
    return elevated;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    // ВАЖНО: полагаться на req.user?.id тут НЕЛЬЗЯ. APP_GUARD (этот класс)
    // выполняется ДО controller-scoped JwtAuthGuard, поэтому req.user
    // будет undefined для 100% запросов и трекинг молча деградировал бы
    // до req.ip — регрессия к NAT-багу, ради которого guard и написан.
    // Верифицируем JWT сами (payload кэшируется, см. verifyJwt).
    const payload = this.verifyJwt(req);
    // JwtStrategy.validate() кладёт в req.user { id: payload.sub, ... },
    // поэтому sub — стабильный ключ пользователя, совпадающий с тем, что
    // видит остальной код.
    const sub = typeof payload?.sub === 'string' ? payload.sub : undefined;
    if (sub) return `user:${sub}`;
    // Fallback: анонимные / невалидно-авторизованные запросы
    // (public applications, student-auth/login, мусорный Bearer).
    // Префикс, чтобы случайно не столкнуться с ключом реального user.id.
    return `ip:${req?.ip ?? 'unknown'}`;
  }
}
