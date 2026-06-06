import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

/**
 * Проверка X-Twilio-Signature на webhook endpoint'ах. Без неё любой в
 * интернете мог POST'ить на /call-status и /recording-status и:
 *   - создавать фейковые CallLog'и для инфляции KPI
 *   - подставлять фейковые recordingUrl ведущие на malicious файлы
 *
 * Алгоритм Twilio (docs):
 *   sig = base64(hmac-sha1(authToken, fullUrl + sorted(key+value).join('')))
 *
 * Webhooks от Twilio — form-encoded, payload в req.body парсится Nest'ом
 * как объект ключ/значение. Concatenate ключ+значение по алфавиту ключей.
 *
 * Если TWILIO_AUTH_TOKEN не задан (телефония-scaffold без реальной
 * конфигурации), guard ОТКАЗЫВАЕТ всем — лучше блокировать чем дать
 * любому ходить по endpoint'ам.
 */
@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  private readonly logger = new Logger(TwilioSignatureGuard.name);

  constructor(private config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN');
    if (!token) {
      this.logger.warn(
        'TWILIO_AUTH_TOKEN не задан — webhook endpoint заблокирован (раньше принимал любого, теперь требует подпись).',
      );
      throw new ForbiddenException('Twilio integration not configured');
    }

    const signature = req.headers['x-twilio-signature'] as string | undefined;
    if (!signature) {
      throw new ForbiddenException('Missing X-Twilio-Signature');
    }

    // Полный URL включает host + path + query (без fragment). За proxy
    // (Railway) hostname берём из X-Forwarded-Host, протокол из
    // X-Forwarded-Proto. Если не задан — используем то что есть.
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const url = `${proto}://${host}${req.originalUrl || req.url}`;

    // Сортируем ключи payload'а и конкатенируем ключ+значение.
    const params = (req.body || {}) as Record<string, string>;
    const sortedKeys = Object.keys(params).sort();
    const payload = sortedKeys.map((k) => `${k}${params[k]}`).join('');

    const expected = createHmac('sha1', token)
      .update(url + payload)
      .digest('base64');

    if (expected !== signature) {
      this.logger.warn(`Invalid Twilio signature for ${url}`);
      throw new ForbiddenException('Invalid Twilio signature');
    }
    return true;
  }
}
