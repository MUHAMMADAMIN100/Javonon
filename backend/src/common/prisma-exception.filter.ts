import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';

/**
 * Ошибки базы, которые на самом деле — ошибки пользователя, отдаём понятным
 * ответом, а не «500 Internal Server Error»:
 *  - P2002 (уникальность) → 409 «такая запись уже есть»;
 *  - P2025 (нет записи)   → 404;
 *  - P2003 (внешний ключ) → 409 «запись связана с другими данными».
 * Всё остальное уходит стандартному обработчику Nest (500 без подробностей).
 */
const UNIQUE_FIELD_MESSAGE: Record<string, string> = {
  email: 'Этот email уже используется',
  phone: 'Этот телефон уже используется',
  login: 'Этот логин уже занят',
  code: 'Такой код уже существует',
  slug: 'Такой адрес уже существует',
  name: 'Запись с таким названием уже есть',
};

/**
 * Если Prisma не назвала поле (на Postgres 18 в тексте бывает «(not available)»),
 * а у модели уникально только одно поле — текст по модели.
 */
const UNIQUE_BY_MODEL: Record<string, string> = {
  Student: 'Ученик с таким email уже есть',
  User: 'Сотрудник с таким email уже есть',
};

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(e: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const mapped = this.map(e);
    if (!mapped || host.getType() !== 'http') return super.catch(e, host);
    this.logger.warn(`${e.code}: ${mapped.message} (${JSON.stringify(e.meta ?? {})}) ${e.message.split('\n').pop()}`);
    const res = host.switchToHttp().getResponse();
    res.status(mapped.status).json({ statusCode: mapped.status, message: mapped.message, error: mapped.error });
  }

  private map(e: Prisma.PrismaClientKnownRequestError): { status: number; message: string; error: string } | null {
    if (e.code === 'P2002') {
      const target = e.meta?.target;
      // target бывает пустым — тогда поле / имя ограничения берём из текста
      // ошибки: «…on the fields: (`email`)» или «…on the constraint: `Student_email_key`».
      const fields = Array.isArray(target)
        ? target.map(String)
        : typeof target === 'string'
          ? [target]
          : [...(e.message.match(/`[^`]+`/g) ?? [])].map((x) => x.slice(1, -1));
      const known = fields.map((f) => Object.keys(UNIQUE_FIELD_MESSAGE).find((k) => f === k || f.includes(`_${k}_`) || f.endsWith(`_${k}`)))
        .find(Boolean);
      return {
        status: HttpStatus.CONFLICT,
        message: known
          ? UNIQUE_FIELD_MESSAGE[known]
          : UNIQUE_BY_MODEL[String(e.meta?.modelName)] ?? 'Такая запись уже существует',
        error: 'Conflict',
      };
    }
    if (e.code === 'P2025') {
      return { status: HttpStatus.NOT_FOUND, message: 'Запись не найдена — возможно, её уже удалили', error: 'Not Found' };
    }
    if (e.code === 'P2003') {
      return { status: HttpStatus.CONFLICT, message: 'Запись связана с другими данными — действие невозможно', error: 'Conflict' };
    }
    return null;
  }
}
