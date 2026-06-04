import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * WhatsApp Business Cloud API (Meta).
 *
 * Каркас под интеграцию. Чтобы заработало в продакшене, нужно в env
 * задать:
 *   WHATSAPP_ACCESS_TOKEN    — токен из Meta Business Suite
 *   WHATSAPP_PHONE_NUMBER_ID — id номера WhatsApp Business
 *   WHATSAPP_VERIFY_TOKEN    — произвольная строка, той же подписи
 *                              ожидает Meta при настройке webhook'а
 * Endpoint Meta: https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages
 *
 * Без credentials sendText() лишь логирует попытку. Webhook верификация
 * (GET) и приём (POST) работают и сохраняют входящие сообщения в
 * ExternalMessage — даже без обратной отправки.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('WHATSAPP_ACCESS_TOKEN') &&
      !!this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
  }

  verifyToken(): string | null {
    return this.config.get<string>('WHATSAPP_VERIFY_TOKEN') || null;
  }

  /**
   * Отправить текстовое сообщение клиенту. to — телефон в международном
   * формате без + (например 992907123456).
   */
  async sendText(to: string, body: string, context?: { applicationId?: string; studentId?: string }) {
    const token = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');

    // Запись outbox-сообщения ДО отправки — чтобы видеть попытки в UI.
    const msg = await this.prisma.externalMessage.create({
      data: {
        channel: 'WHATSAPP',
        direction: 'OUT',
        toHandle: to,
        content: body,
        applicationId: context?.applicationId || null,
        studentId: context?.studentId || null,
        status: 'PENDING',
      },
    });

    if (!token || !phoneId) {
      this.logger.warn('WhatsApp not configured — skipping send');
      await this.prisma.externalMessage.update({
        where: { id: msg.id }, data: { status: 'FAILED' },
      });
      throw new BadRequestException('WhatsApp не настроен на сервере');
    }

    try {
      const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body },
        }),
      });
      const data: any = await res.json();
      if (!res.ok) {
        this.logger.warn(`WhatsApp send failed: ${JSON.stringify(data)}`);
        await this.prisma.externalMessage.update({
          where: { id: msg.id }, data: { status: 'FAILED', rawPayload: data },
        });
        throw new BadRequestException(data?.error?.message || 'WhatsApp send failed');
      }
      await this.prisma.externalMessage.update({
        where: { id: msg.id },
        data: {
          status: 'SENT',
          externalId: data?.messages?.[0]?.id,
          sentAt: new Date(),
          rawPayload: data,
        },
      });
      return data;
    } catch (e: any) {
      this.logger.error(`WhatsApp send error: ${e.message}`);
      throw e;
    }
  }

  /** Webhook верификация Meta. */
  verifyChallenge(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === this.verifyToken()) return challenge;
    return null;
  }

  /**
   * Webhook приём входящих сообщений. Сохраняет в ExternalMessage с
   * direction=IN. Если найден существующий клиент с этим телефоном —
   * привязывает к нему.
   */
  async handleIncoming(payload: any) {
    try {
      const entries = payload?.entry || [];
      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const messages = change?.value?.messages || [];
          for (const m of messages) {
            const from = m.from as string;
            const text = m.text?.body || m.image?.caption || `[${m.type}]`;
            const mediaUrl = m.image?.id || m.video?.id || null;

            // Попытка привязать к клиенту по телефону.
            const normalized = `+${from}`;
            const app = await this.prisma.application.findFirst({
              where: { phone: { contains: from.replace(/^\+?/, '') } },
              select: { id: true, studentId: true },
            });

            await this.prisma.externalMessage.create({
              data: {
                channel: 'WHATSAPP',
                direction: 'IN',
                fromHandle: normalized,
                content: text,
                mediaUrl,
                externalId: m.id,
                applicationId: app?.id || null,
                studentId: app?.studentId || null,
                receivedAt: new Date(),
                status: 'DELIVERED',
                rawPayload: m,
              },
            });
          }
        }
      }
      return { ok: true };
    } catch (e: any) {
      this.logger.error(`WhatsApp webhook error: ${e.message}`);
      return { ok: false };
    }
  }
}
