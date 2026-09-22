import { Injectable, NestMiddleware, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { requireJwtSecret } from '../auth/jwt-secret';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Доступ к /uploads/* (паспорта, контракты, чеки).
 *
 * Принимается:
 *   - Authorization: Bearer <основной токен> — для запросов из кода (fetch);
 *   - ?ft=<файловый токен> — для <a href> / <img src>, которые не умеют слать
 *     заголовки. Файловый токен выдаёт GET /auth/file-token: живёт 10 минут,
 *     подписан ОТДЕЛЬНЫМ ключом и годится только для файлов.
 *
 * Раньше в ссылку клали основной токен (?token=, живёт 30 дней) — он
 * оседал в логах, истории и Referer, а проверялась только подпись: файлы
 * открывались и после увольнения, и после отзыва сессии. Теперь при каждой
 * выдаче файла проверяется, что сессия не отозвана и сотрудник действует
 * (результат кэшируется на 30 секунд, чтобы не бить в базу на каждую
 * картинку). Основной токен в адресе (?token=) больше не принимается.
 *
 * Студентам — отказ: раздел сотрудников / документов сделок не для них.
 */
export const FILE_TOKEN_TTL_SEC = 10 * 60;
export function fileTokenSecret(jwtSecret: string) {
  return `${jwtSecret}::uploads-file-token`;
}

const CHECK_TTL_MS = 30_000;

@Injectable()
export class UploadsAuthMiddleware implements NestMiddleware {
  private readonly secret: string;
  private readonly fileSecret: string;
  private readonly checked = new Map<string, number>();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.secret = requireJwtSecret(config.get<string>('JWT_SECRET'));
    this.fileSecret = fileTokenSecret(this.secret);
  }

  async use(req: Request, _res: Response, next: NextFunction) {
    let payload: any;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        payload = this.jwt.verify(auth.slice('Bearer '.length).trim(), { secret: this.secret });
      } catch {
        throw new UnauthorizedException('Невалидный или просроченный токен');
      }
      if (payload?.typ === 'file') throw new UnauthorizedException('Невалидный токен');
    } else if (typeof req.query.ft === 'string') {
      try {
        payload = this.jwt.verify(req.query.ft, { secret: this.fileSecret });
      } catch {
        throw new UnauthorizedException('Ссылка на файл устарела — обновите страницу');
      }
      if (payload?.typ !== 'file') throw new UnauthorizedException('Невалидный токен');
    } else {
      throw new UnauthorizedException('Требуется авторизация для доступа к файлу');
    }

    const role = payload?.role;
    const roles: string[] = Array.isArray(payload?.roles) ? payload.roles : [];
    const allRoles = [role, ...roles].filter(Boolean) as string[];
    if (allRoles.includes('STUDENT') && !allRoles.some((r) => r !== 'STUDENT')) {
      throw new ForbiddenException('Эта зона только для сотрудников');
    }

    await this.assertSessionAlive(payload?.sub, payload?.sid);
    next();
  }

  /** Сессия не отозвана, сотрудник не уволен (кэш 30 с). */
  private async assertSessionAlive(userId?: string, sid?: string) {
    if (!userId || !sid) throw new UnauthorizedException('Сессия не найдена — войдите заново');
    const key = `${userId}:${sid}`;
    const until = this.checked.get(key);
    if (until && until > Date.now()) return;
    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
      this.prisma.session.findUnique({ where: { id: sid }, select: { userId: true, revokedAt: true } }),
    ]);
    if (!user || user.isActive === false) throw new UnauthorizedException('Аккаунт деактивирован');
    if (!session || session.userId !== userId || session.revokedAt) {
      throw new UnauthorizedException('Сессия отозвана — войдите заново');
    }
    if (this.checked.size > 5000) this.checked.clear();
    this.checked.set(key, Date.now() + CHECK_TTL_MS);
  }
}
