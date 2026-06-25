import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { requireJwtSecret } from '../auth/jwt-secret';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Гард для эндпоинтов студента.
 *  - Сначала пытается верифицировать токен с STUDENT_JWT_SECRET (новый, отдельный).
 *  - Если не удалось — fallback на JWT_SECRET (старые токены, выданные до разделения).
 *  - Принимает только токены с role === 'STUDENT'.
 *  - Проверяет payload.tokenVersion === student.tokenVersion → инвалидирует
 *    старые JWT после смены пароля (sec audit fix).
 */
@Injectable()
export class StudentJwtGuard implements CanActivate {
  constructor(
    private config: ConfigService,
    private jwt: JwtService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const auth: string | undefined =
      req.headers?.authorization || req.headers?.Authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new ForbiddenException('Требуется авторизация студента');
    }
    const token = auth.slice(7).trim();

    const studentSecret = this.config.get<string>('STUDENT_JWT_SECRET');
    // Legacy fallback path: tries main JWT_SECRET. requireJwtSecret
    // refuses a hard-coded value in production (see jwt-secret.ts).
    const legacySecret = requireJwtSecret(this.config.get<string>('JWT_SECRET'));

    let payload: any = null;
    if (studentSecret) {
      try {
        payload = await this.jwt.verifyAsync(token, { secret: studentSecret });
      } catch {
        // не подошёл — пробуем legacy
      }
    }
    if (!payload) {
      try {
        payload = await this.jwt.verifyAsync(token, { secret: legacySecret });
      } catch {
        throw new ForbiddenException('Неверный или просроченный токен');
      }
    }

    if (payload.role !== 'STUDENT') {
      throw new ForbiddenException('Эта зона только для студентов');
    }

    // Token version check — отсекает старые токены после смены пароля.
    // payload.tokenVersion отсутствует у токенов, выпущенных до этой
    // фичи — для них принимаем (legacy). Когда студент сменит пароль,
    // tokenVersion станет 1, и legacy token уже не пройдёт (1 !== undefined→0).
    try {
      const dbStudent = await this.prisma.student.findUnique({
        where: { id: payload.sub },
        select: { tokenVersion: true },
      });
      if (!dbStudent) {
        throw new ForbiddenException('Аккаунт не найден');
      }
      const tokenVer = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
      if (tokenVer !== dbStudent.tokenVersion) {
        throw new ForbiddenException('Токен отозван — войдите заново');
      }
    } catch (e: any) {
      // если БД недоступна — лучше отказать чем пропустить (security-fail-closed)
      if (e instanceof ForbiddenException) throw e;
      throw new ForbiddenException('Ошибка проверки токена');
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
