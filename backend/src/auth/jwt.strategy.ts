import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') || 'fallback-secret',
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
    return {
      id: payload.sub,
      sub: payload.sub, // для обратной совместимости со старым кодом
      email: payload.email,
      role: normalize(payload.role),
      // Множественные роли — основатель раздаёт через /users/:id/roles.
      // FOUNDER неявно имеет доступ ко всему (см. RolesGuard).
      roles: (payload.roles || []).map(normalize),
    };
  }
}
