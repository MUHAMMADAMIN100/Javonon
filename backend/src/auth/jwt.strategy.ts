import { Injectable } from '@nestjs/common';
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
    email: string;
    role: string;
    roles?: string[];
  }) {
    // Legacy normalization: токены, выпущенные ДО переезда на новые роли,
    // содержат 'EMPLOYEE'. После миграции БД эти юзеры уже SALES_MANAGER,
    // но их старые токены валидны до истечения (7д). Мапим на лету, чтобы
    // им не пришлось разлогиниваться.
    const normalize = (r?: string) => (r === 'EMPLOYEE' ? 'SALES_MANAGER' : r);

    // Подгружаем CustomRole.permissions свежими из БД — чтобы при изменении
    // custom-роли FOUNDER'ом доступы применялись сразу, без перевыпуска JWT.
    // Selective fields: только то что нужно RolesGuard'у.
    let permissions: string[] = [];
    let hasCustomRole = false;
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          customRole: { select: { permissions: true, isActive: true } },
        },
      });
      if (u?.customRole?.isActive) {
        permissions = u.customRole.permissions || [];
        hasCustomRole = true;
      }
    } catch {
      // Если БД недоступна — лучше пропустить permissions, чем уронить
      // запрос. Базовые роли продолжат работать.
    }

    return {
      id: payload.sub,
      sub: payload.sub, // для обратной совместимости со старым кодом
      email: payload.email,
      role: normalize(payload.role),
      // Множественные роли — основатель раздаёт через /users/:id/roles.
      // FOUNDER неявно имеет доступ ко всему (см. RolesGuard).
      roles: (payload.roles || []).map(normalize),
      permissions,
      // Флаг для RolesGuard: если у юзера активная кастомная роль —
      // base role (которая в БД как «подложка») не должна давать доступ
      // через @Roles(). Только permissions из custom role + неявные
      // permission-проверки по URL.
      hasCustomRole,
    };
  }
}
