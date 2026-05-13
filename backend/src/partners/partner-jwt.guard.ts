import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

/**
 * Гард для эндпоинтов партнёра. Принимает только токены с role === 'PARTNER'.
 *  - Сначала PARTNER_JWT_SECRET (новый), если задан.
 *  - Fallback на JWT_SECRET для совместимости.
 */
@Injectable()
export class PartnerJwtGuard implements CanActivate {
  constructor(private config: ConfigService, private jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const auth: string | undefined =
      req.headers?.authorization || req.headers?.Authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new ForbiddenException('Требуется авторизация партнёра');
    }
    const token = auth.slice(7).trim();

    const partnerSecret = this.config.get<string>('PARTNER_JWT_SECRET');
    const legacy = this.config.get<string>('JWT_SECRET') || 'fallback-secret';

    let payload: any = null;
    if (partnerSecret) {
      try {
        payload = await this.jwt.verifyAsync(token, { secret: partnerSecret });
      } catch {}
    }
    if (!payload) {
      try {
        payload = await this.jwt.verifyAsync(token, { secret: legacy });
      } catch {
        throw new ForbiddenException('Неверный или просроченный токен');
      }
    }

    if (payload.role !== 'PARTNER') {
      throw new ForbiddenException('Эта зона только для партнёров');
    }

    req.user = {
      id: payload.sub,
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
    };
    return true;
  }
}
