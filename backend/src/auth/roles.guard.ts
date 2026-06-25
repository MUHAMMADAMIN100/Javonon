import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { hasRole, hasPermission, isFounder } from './role-utils';
import { permissionsForRequest } from './permissions';

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

    // FOUNDER — неявный супер-доступ.
    if (isFounder(user)) return true;

    // ТЗ-доработка: если у юзера активная кастомная роль (например «Таргетолог»),
    // base role в БД — техническая «подложка» и НЕ должна давать доступа
    // через @Roles(). Кастомная роль ЗАМЕНЯЕТ базу для целей авторизации:
    // доступ — только по permissions из CustomRole + неявные permission
    // checks по URL ниже. Без этого «Таргетолог» с base SALES_MANAGER
    // получал бы все endpoints @Roles('SALES_MANAGER').
    const skipBaseRole = !!user.hasCustomRole;

    // OR: явная роль из @Roles(...) — только если нет активной custom-роли.
    if (!skipBaseRole && requiredRoles.length > 0 && hasRole(user, ...requiredRoles)) return true;
    // OR: явный permission из @Permissions(...)
    if (requiredPerms.length > 0 && hasPermission(user, ...requiredPerms)) return true;
    // OR: implicit permission — если URL+method покрывается каким-либо
    // permission'ом из PERMISSION_CATALOG, и у юзера он есть. Это путь
    // для custom-роли, чтобы старые эндпоинты с @Roles(...) сразу
    // отвечали на permission-проверку без массового переписывания
    // декораторов на 60+ контроллерах.
    const userPerms = (user.permissions || []) as string[];
    if (userPerms.length > 0) {
      const url = (req.originalUrl || req.url || '').split('?')[0];
      const method = (req.method || 'GET').toUpperCase();
      const implicit = permissionsForRequest(method, url);
      if (implicit.some((p) => userPerms.includes(p))) return true;
    }

    throw new ForbiddenException('Недостаточно прав');
  }
}
