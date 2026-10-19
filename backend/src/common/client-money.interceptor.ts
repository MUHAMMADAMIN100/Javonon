import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import { canSeeData, hideMoney, hideMoneyList } from './redact';

/**
 * «Деньги клиентов» (Настройки → Роли → Видимость данных): сотруднику с
 * ролью без этого пункта ответ уходит без сумм и чеков (common/redact.ts).
 * Вешается на адреса чтения сделок и оплат студента.
 */
@Injectable()
export class ClientMoneyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const user = context.switchToHttp().getRequest()?.user;
    if (canSeeData(user, 'visibility:client-money')) return next.handle();
    return next.handle().pipe(map((data) => (Array.isArray(data) ? hideMoneyList(data) : hideMoney(data))));
  }
}
