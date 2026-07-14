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
 */
const ELEVATED_ROLES = new Set(['FOUNDER', 'ADMIN', 'ACCOUNTANT']);

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly jwtSecret: string;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    super(options, storage, reflector);
    // Тот же секрет, что и вся авторизация (см. jwt.strategy.ts /
    // uploads-auth.middleware.ts). Читаем один раз в конструкторе, чтобы
    // не дёргать ConfigService на каждый запрос.
    this.jwtSecret = requireJwtSecret(config.get<string>('JWT_SECRET'));
  }

  /**
   * Пропускаем throttle для FOUNDER / ADMIN / ACCOUNTANT.
   * Логика прописана в комментарии на классе. Для всех остальных —
   * стандартный super.shouldSkip() (учитывает @SkipThrottle()).
   */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (await super.shouldSkip(context)) return true;

    const req = context.switchToHttp().getRequest();
    const auth: string | undefined = req?.headers?.authorization;
    if (typeof auth !== 'string') return false;
    // Принимаем "Bearer <token>" case-insensitively — некоторые клиенты
    // шлют "bearer " в нижнем регистре, стандарт допускает.
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    const token = m[1].trim();
    if (!token) return false;

    let payload: any;
    try {
      payload = this.jwt.verify(token, { secret: this.jwtSecret });
    } catch {
      // Невалидный/просроченный токен — НЕ обходим throttle. Пусть JwtAuthGuard
      // ниже по стеку сам вернёт 401; throttle тем временем защитит от
      // brute-force попыток подсунуть мусорный Bearer.
      return false;
    }

    const roles: string[] = [
      payload?.role,
      ...(Array.isArray(payload?.roles) ? payload.roles : []),
    ].filter((r): r is string => typeof r === 'string');
    return roles.some((r) => ELEVATED_ROLES.has(r));
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    // JwtStrategy.validate() возвращает объект с полем `id` — оно и есть
    // стабильный ключ пользователя. `sub` там же лежит как алиас, но `id`
    // используется по всему коду (CurrentUser + guards), поэтому берём его.
    const userId: string | undefined = req?.user?.id;
    if (userId) return `user:${userId}`;
    // Fallback: анонимные запросы (public applications, student-auth/login).
    // Префикс, чтобы случайно не столкнуться с ключом реального user.id.
    return `ip:${req?.ip ?? 'unknown'}`;
  }
}
