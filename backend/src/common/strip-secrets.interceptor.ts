import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';

/**
 * Вычищает секреты из КАЖДОГО ответа сервера, на любой глубине:
 *  - `password` с bcrypt-хешем ($2a$/$2b$/$2y$…) — хеш пароля студента,
 *    сотрудника или партнёра уходил в ответ вместе с карточкой (Prisma 5.10
 *    не умеет omit, а студент вложен в заявки, сделки, финансы, чат…);
 *  - `tokenVersion` — служебный счётчик отзыва токенов.
 * Одноразовый пароль, который система специально показывает один раз
 * (новый студент, сброс пароля, партнёр), — обычный текст, не хеш, и
 * остаётся в ответе.
 */
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;

function strip(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const v of value) strip(v, seen);
    return;
  }
  // Только обычные объекты: Date, Buffer, Decimal и прочие классы не трогаем.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.password === 'string' && BCRYPT_RE.test(obj.password)) delete obj.password;
  if ('tokenVersion' in obj) delete obj.tokenVersion;
  for (const k of Object.keys(obj)) strip(obj[k], seen);
}

@Injectable()
export class StripSecretsInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      map((data) => {
        strip(data, new WeakSet());
        return data;
      }),
    );
  }
}
