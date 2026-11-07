import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * «Войти как» — основатель открывает CRM глазами сотрудника, чтобы проверить
 * его права (решение заказчика 07.11.2026). Режим живёт час, все права — как у
 * сотрудника, каждое изменение пишется в журнал от имени основателя.
 */
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;
export const IMPERSONATION_TTL = '1h';

/** Запрос идёт в режиме «Войти как». */
export function isImpersonating(user: any): boolean {
  return !!user?.impersonatorId;
}

/**
 * Изменения, которые от чужого имени делать нельзя: сообщения в чат (их
 * прочитали бы живые люди как слова сотрудника). Чтение разрешено.
 */
@Injectable()
export class NoImpersonationWritesGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const method = String(req?.method || '').toUpperCase();
    if (isImpersonating(req?.user) && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      throw new ForbiddenException('В режиме «Войти как» писать в чат от имени сотрудника нельзя');
    }
    return true;
  }
}
