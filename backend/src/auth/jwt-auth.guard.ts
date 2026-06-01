import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any) {
    // Нет / невалидный / просроченный токен → 401, чтобы axios interceptor
    // во фронте поймал, очистил localStorage и редиректнул на /login.
    // Раньше тут был 403 — фронт его игнорировал и пользователь залипал
    // на пустой странице с баннером «нет соединения» (см. client.ts).
    if (err || !user) throw err || new UnauthorizedException('Требуется авторизация');
    // Авторизован, но это студент пытается зайти в зону сотрудников → 403.
    if (user.role === 'STUDENT') {
      throw new ForbiddenException('Эта зона только для сотрудников');
    }
    return user;
  }
}
