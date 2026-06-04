import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Twilio Voice — звонок прямо из браузера CRM (WebRTC через Twilio
 * Voice JS SDK). Каркас.
 *
 * Для работы нужны env:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (НЕ AUTH_TOKEN — Voice
 *     SDK требует именно API Key)
 *   TWILIO_TWIML_APP_SID  — TwiML App с настроенным Voice URL,
 *                           указывающий на /integrations/telephony/voice
 *   TWILIO_CALLER_ID      — купленный Twilio номер (E.164)
 *
 * Поток:
 *   1. Фронт запрашивает /telephony/token → JWT для Twilio Device.
 *   2. Twilio Device.connect({To: '+992...'}) — браузерный WebRTC дозвон.
 *   3. Twilio дёргает наш Voice URL → отвечаем TwiML <Dial>{To}</Dial>.
 *   4. Webhook call-status → пишем в CallLog с answeredAt/duration.
 */
@Injectable()
export class TelephonyService {
  private readonly logger = new Logger(TelephonyService.name);
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get('TWILIO_ACCOUNT_SID') &&
      !!this.config.get('TWILIO_API_KEY_SID') &&
      !!this.config.get('TWILIO_API_KEY_SECRET') &&
      !!this.config.get('TWILIO_TWIML_APP_SID');
  }

  /**
   * Сгенерировать Access Token для Twilio Voice Device. Срок жизни 1 час.
   * userId используется как identity — Twilio будет роутить звонки сюда.
   *
   * Внимание: реальная подпись JWT требует пакета `twilio` или ручного
   * HMAC-SHA256 с твилиевской структурой. Здесь — каркас с описанием
   * структуры; реальная подпись добавляется одной строкой при установке
   * `npm i twilio`:
   *   import { jwt } from 'twilio'; const t = new jwt.AccessToken(...).
   */
  async issueAccessToken(userId: string): Promise<{ token: string; identity: string }> {
    if (!this.isConfigured()) {
      throw new BadRequestException('Twilio Voice не настроен');
    }
    const identity = `user-${userId}`;
    // TODO: после `npm i twilio` заменить заглушку на реальный AccessToken.
    this.logger.warn(`Twilio token stub for ${identity} — установите npm i twilio для реальной подписи`);
    return {
      token: '__TWILIO_TOKEN_PLACEHOLDER__',
      identity,
    };
  }

  /**
   * Webhook Voice URL — Twilio вызывает, чтобы получить TwiML инструкцию
   * "куда дальше дозваниваться". Возвращаем XML <Response><Dial>+...</Dial>
   * </Response>.
   */
  buildOutboundTwiML(to: string): string {
    const callerId = this.config.get<string>('TWILIO_CALLER_ID') || '';
    const safeTo = to.replace(/[^\d+]/g, '');
    return `<?xml version="1.0" encoding="UTF-8"?><Response>
      <Dial callerId="${callerId}" answerOnBridge="true">
        <Number>${safeTo}</Number>
      </Dial>
    </Response>`;
  }

  /**
   * Webhook call-status — Twilio шлёт CallSid/CallStatus/Duration/From/To.
   * Используем для логирования в CallLog.
   */
  async handleCallStatus(payload: any, userId?: string) {
    try {
      const status = payload?.CallStatus;
      const duration = parseInt(payload?.CallDuration || '0', 10);
      const direction = payload?.Direction === 'inbound' ? 'INCOMING' : 'OUTGOING';
      const externalId = payload?.CallSid as string;
      const answered = ['completed', 'in-progress'].includes(status);
      // По ТЗ — длительность с момента ответа, не с начала набора. CallDuration
      // Twilio = именно с момента answer, что нам и нужно.
      if (status === 'completed' && userId) {
        await this.prisma.callLog.create({
          data: {
            userId,
            clientName: payload?.To || payload?.From || 'unknown',
            clientPhone: payload?.To || payload?.From || null,
            direction: direction as any,
            outcome: answered ? 'ANSWERED' : 'NO_ANSWER',
            durationSeconds: duration,
            notes: `Twilio CallSid: ${externalId}`,
            occurredAt: new Date(),
          },
        });
      }
      return { ok: true };
    } catch (e: any) {
      this.logger.error(`Twilio webhook error: ${e.message}`);
      return { ok: false };
    }
  }
}
