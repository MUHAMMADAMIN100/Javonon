import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { hasRole, hasPermission, isFounder } from './role-utils';

/**
 * Кто проходит на адрес.
 *
 *  • Основатель — всегда.
 *  • Сотрудник с ролью (своей или ролью должности, user.hasCustomRole) —
 *    ТОЛЬКО по правам роли: должность в БД для него лишь «подложка» и
 *    через @Roles ничего не открывает. На адресе должны быть названы права
 *    (@Permissions); нет их — адрес для роли закрыт. Раньше роль проходила
 *    ещё «неявно»: любое право раздела по префиксу адреса, и «Заявки —
 *    создание» пускало на удаление. С 19.10.2026 так нельзя.
 *  • Сотрудник без роли — по должности (@Roles), как раньше. Адрес, где
 *    названы только права, без @Roles, — открыт любой должности: права
 *    ограничивают лишь сотрудников с ролью.
 *
 * Те же @Permissions проверяет JwtAuthGuard — на контроллерах, где этого
 * гарда нет.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) || [];
    const requiredPerms = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) || [];

    // Нет ни ролей, ни пермиссий → защита эндпоинта не требуется.
    if (requiredRoles.length === 0 && requiredPerms.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Недостаточно прав');

    if (isFounder(user)) return true;

    if (user.hasCustomRole) {
      if (requiredPerms.length > 0 && hasPermission(user, ...requiredPerms)) return true;
      throw new ForbiddenException('Недостаточно прав');
    }

    if (requiredRoles.length === 0) return true;
    if (hasRole(user, ...requiredRoles)) return true;
    throw new ForbiddenException('Недостаточно прав');
  }
}
