import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { hasRole, isFounder } from './role-utils';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('Недостаточно прав');

    // FOUNDER — неявный супер-доступ: не нужно перечислять во всех @Roles(...).
    if (isFounder(user)) return true;

    // Проверяем и основную роль (user.role), и дополнительные (user.roles[]).
    if (hasRole(user, ...required)) return true;

    throw new ForbiddenException('Недостаточно прав');
  }
}
