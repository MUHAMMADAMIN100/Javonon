import { ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { hasPermission, isFounder, isTeacherOnly } from './role-utils';
import { teacherMayRequest } from './teacher-scope';
import { PERMISSIONS_KEY } from './permissions.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  handleRequest(err: any, user: any, _info?: any, context?: ExecutionContext) {
    // Нет / невалидный / просроченный токен → 401, чтобы axios interceptor
    // во фронте поймал, очистил localStorage и редиректнул на /login.
    // Раньше тут был 403 — фронт его игнорировал и пользователь залипал
    // на пустой странице с баннером «нет соединения» (см. client.ts).
    if (err || !user) throw err || new UnauthorizedException('Требуется авторизация');
    // Авторизован, но это студент пытается зайти в зону сотрудников → 403.
    if (user.role === 'STUDENT') {
      throw new ForbiddenException('Эта зона только для сотрудников');
    }
    // Учителю академии открыт только белый список (auth/teacher-scope.ts).
    if (isTeacherOnly(user) && context) {
      const req = context.switchToHttp().getRequest();
      if (!teacherMayRequest(req?.method, req?.originalUrl || req?.url || '')) {
        throw new ForbiddenException('Учителю доступна только Академия');
      }
    }
    // Права роли на адресе (@Permissions). Здесь, а не только в RolesGuard:
    // половина контроллеров живёт под одним JwtAuthGuard, и без этой
    // проверки сотрудник с ролью проходил бы туда, где галочки у него нет.
    // Сотрудника без роли права не касаются — его ведёт должность.
    if (context && user.hasCustomRole && !isFounder(user)) {
      const perms = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (perms?.length && !hasPermission(user, ...perms)) {
        throw new ForbiddenException('Недостаточно прав');
      }
    }
    return user;
  }
}
