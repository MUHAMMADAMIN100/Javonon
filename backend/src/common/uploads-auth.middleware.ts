import { Injectable, NestMiddleware, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { requireJwtSecret } from '../auth/jwt-secret';

/**
 * Audit fix #11 (HIGH, PII leak): /uploads/* раньше раздавался ServeStaticModule
 * без какой-либо проверки JWT — любой со ссылкой (через access-логи / Telegram /
 * Referer / browser history) мог скачать паспорт, контракт или чек. UUID-имена
 * защищали только от перебора и НЕ являются access control.
 *
 * Этот middleware вешается на префикс /uploads/* и требует валидный JWT:
 *   - либо Authorization: Bearer <token>
 *   - либо ?token=<jwt> в query (нужно потому что <a href> и <img src> не умеют
 *     слать кастомные заголовки; фронт подставляет токен в URL — см. absUrl()).
 *
 * Студентам отказываем явно: их JWT валиден, но раздел сотрудников / документов
 * сделок не для них. Совпадает с поведением JwtAuthGuard.handleRequest().
 *
 * Это «быстрая альтернатива» из суггеста аудита (vs. полноценный
 * GET /files/:id с проверкой managerId — это потребовало бы рефакторить
 * хранение url'ов по сущностям; средняя планка можно докрутить позже).
 */
@Injectable()
export class UploadsAuthMiddleware implements NestMiddleware {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.secret = requireJwtSecret(config.get<string>('JWT_SECRET'));
  }

  use(req: Request, _res: Response, next: NextFunction) {
    // 1. Достаём токен из Authorization или ?token=
    let token: string | undefined;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      token = auth.slice('Bearer '.length).trim();
    }
    if (!token && typeof req.query.token === 'string') {
      token = req.query.token;
    }
    if (!token) {
      throw new UnauthorizedException('Требуется авторизация для доступа к файлу');
    }

    // 2. Верифицируем подпись + срок жизни. Любой парс/верификейшн error → 401.
    let payload: any;
    try {
      payload = this.jwt.verify(token, { secret: this.secret });
    } catch {
      throw new UnauthorizedException('Невалидный или просроченный токен');
    }

    // 3. Студенты не имеют доступа к staff-зоне (см. JwtAuthGuard).
    const role = payload?.role;
    const roles: string[] = Array.isArray(payload?.roles) ? payload.roles : [];
    const allRoles = [role, ...roles].filter(Boolean) as string[];
    if (allRoles.includes('STUDENT') && !allRoles.some((r) => r !== 'STUDENT')) {
      throw new ForbiddenException('Эта зона только для сотрудников');
    }

    next();
  }
}
