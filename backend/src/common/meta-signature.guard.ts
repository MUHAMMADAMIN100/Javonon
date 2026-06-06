import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Проверка X-Hub-Signature-256 на webhook'ах Meta (WhatsApp Business
 * Cloud API, Instagram Graph). Без неё любой в интернете мог POST'ить
 * на webhook и создавать фейковые ExternalMessage записи (флуд Inbox,
 * подделка истории переписки клиента).
 *
 * Алгоритм:
 *   signature = sha256=hex(hmac-sha256(appSecret, raw-request-body))
 *
 * Сравнение через timingSafeEqual чтобы избежать timing attack'а.
 *
 * Env-имя секрета настраивается аргументом конструктора в подклассе:
 *   - WhatsApp:  WHATSAPP_APP_SECRET (Meta WhatsApp Business)
 *   - Instagram: INSTAGRAM_APP_SECRET (Meta Graph)
 *
 * Если секрет не задан (текущий scaffold state per ТЗ §6 «WhatsApp /
 * Instagram excluded»), guard отказывает всем — fail-closed безопаснее
 * чем silent accept.
 */
@Injectable()
export abstract class MetaSignatureGuard implements CanActivate {
  protected readonly logger = new Logger(this.constructor.name);
  protected abstract envName: string;

  constructor(protected config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const secret = this.config.get<string>(this.envName);
    if (!secret) {
      this.logger.warn(`${this.envName} не задан — webhook заблокирован.`);
      throw new ForbiddenException(`Meta integration not configured (${this.envName})`);
    }

    const provided = req.headers['x-hub-signature-256'] as string | undefined;
    if (!provided || !provided.startsWith('sha256=')) {
      throw new ForbiddenException('Missing X-Hub-Signature-256');
    }

    const raw = req.rawBody as Buffer | undefined;
    if (!raw) {
      this.logger.error('req.rawBody отсутствует — забыли rawBody:true в NestFactory.create?');
      throw new ForbiddenException('Webhook misconfigured');
    }

    const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    const ok = expected.length === provided.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    if (!ok) {
      this.logger.warn(`Invalid Meta signature on ${req.url}`);
      throw new ForbiddenException('Invalid Meta signature');
    }
    return true;
  }
}

@Injectable()
export class WhatsappSignatureGuard extends MetaSignatureGuard {
  protected envName = 'WHATSAPP_APP_SECRET';
}

@Injectable()
export class InstagramSignatureGuard extends MetaSignatureGuard {
  protected envName = 'INSTAGRAM_APP_SECRET';
}
