import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { requireJwtSecret } from './jwt-secret';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireJwtSecret(config.get<string>('JWT_SECRET')),
    });
  }

  async validate(payload: {
    sub: string;
    sid?: string;
    email: string;
    role: string;
    roles?: string[];
  }) {
    // Legacy normalization: токены, выпущенные ДО переезда на новые роли,
    // содержат 'EMPLOYEE'. После миграции БД эти юзеры уже SALES_MANAGER,
    // но их старые токены валидны до истечения (7д). Мапим на лету, чтобы
    // им не пришлось разлогиниваться.
    const normalize = (r?: string | null) =>
      r === 'EMPLOYEE' ? 'SALES_MANAGER' : r ?? undefined;

    // Требуем sid в payload. Токены, выпущенные ДО добавления таблицы
    // Session (см. schema.prisma), не имели sid — они больше не проходят
    // проверку, и сотрудник переавторизуется один раз после деплоя.
    // Это компромисс: одноразовый forced re-login vs. сохранение sec-hole,
    // при котором любой старый JWT остаётся валидным до 30 дней даже после
    // удаления/деактивации пользователя.
    if (!payload.sid) {
      throw new UnauthorizedException('Требуется повторная авторизация');
    }

    // Подгружаем role/roles/CustomRole.permissions свежими из БД на каждом
    // запросе. КРИТИЧНО для безопасности: если оставить role/roles из
    // payload — понижение сотрудника (например ADMIN→SALES_MANAGER или
    // FOUNDER→SALES_MANAGER) не применяется до истечения JWT (до 30 дней),
    // потому что RolesGuard.hasRole()/isFounder() читают user.role/roles.
    // Fail-closed: если юзер удалён/деактивирован/сессия отозвана — 401,
    // а не откат к stale-ролям из токена.
    let dbRole: string | null | undefined;
    let dbRoles: string[] = [];
    let permissions: string[] = [];
    let hasCustomRole = false;
    try {
      const [u, session] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: {
            role: true,
            roles: true,
            isActive: true,
            customRole: { select: { permissions: true, isActive: true } },
          },
        }),
        this.prisma.session.findUnique({
          where: { id: payload.sid },
          select: { userId: true, revokedAt: true },
        }),
      ]);
      if (!u) throw new UnauthorizedException('Пользователь не найден');
      if (u.isActive === false) {
        throw new UnauthorizedException('Аккаунт деактивирован');
      }
      // Сессия удалена / отозвана (logout / принудительно FOUNDER'ом) /
      // принадлежит другому юзеру — токен отклоняем.
      if (!session || session.userId !== payload.sub || session.revokedAt) {
        throw new UnauthorizedException('Сессия отозвана — войдите заново');
      }
      dbRole = u.role;
      dbRoles = u.roles || [];
      if (u.customRole?.isActive) {
        permissions = u.customRole.permissions || [];
        hasCustomRole = true;
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      // БД недоступна — единственный безопасный вариант отклонить запрос:
      // fallback на payload.role открывает окно демоушен-latency (см. выше).
      throw new UnauthorizedException('Проверка сессии временно недоступна');
    }

    return {
      id: payload.sub,
      sub: payload.sub, // для обратной совместимости со старым кодом
      sid: payload.sid,
      email: payload.email,
      role: normalize(dbRole),
      // Множественные роли — основатель раздаёт через /users/:id/roles.
      // FOUNDER неявно имеет доступ ко всему (см. RolesGuard).
      roles: dbRoles.map((r) => normalize(r)).filter((r): r is string => !!r),
      permissions,
      // Флаг для RolesGuard: если у юзера активная кастомная роль —
      // base role (которая в БД как «подложка») не должна давать доступ
      // через @Roles(). Только permissions из custom role + неявные
      // permission-проверки по URL.
      hasCustomRole,
    };
  }
}
