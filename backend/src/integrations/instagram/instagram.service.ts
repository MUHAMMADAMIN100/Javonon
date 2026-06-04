import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Instagram Messaging через Meta Graph API.
 *
 * Каркас. Для работы в продакшене нужно:
 *   IG_PAGE_ACCESS_TOKEN   — long-lived токен страницы Facebook,
 *                            связанной с Instagram Business аккаунтом.
 *   IG_ACCOUNT_ID          — Instagram Business Account ID.
 *   IG_VERIFY_TOKEN        — произвольная строка для верификации webhook.
 *
 * Endpoint отправки: https://graph.facebook.com/v18.0/me/messages
 *   с recipient = { id: ig_scoped_user_id }
 */
@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('IG_PAGE_ACCESS_TOKEN') &&
      !!this.config.get<string>('IG_ACCOUNT_ID');
  }

  verifyChallenge(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === this.config.get<string>('IG_VERIFY_TOKEN')) return challenge;
    return null;
  }

  async sendDM(igUserId: string, body: string, context?: { applicationId?: string; studentId?: string }) {
    const token = this.config.get<string>('IG_PAGE_ACCESS_TOKEN');
    const msg = await this.prisma.externalMessage.create({
      data: {
        channel: 'INSTAGRAM',
        direction: 'OUT',
        toHandle: igUserId,
        content: body,
        applicationId: context?.applicationId || null,
        studentId: context?.studentId || null,
        status: 'PENDING',
      },
    });
    if (!token) {
      this.logger.warn('Instagram not configured — skipping send');
      await this.prisma.externalMessage.update({ where: { id: msg.id }, data: { status: 'FAILED' } });
      throw new BadRequestException('Instagram не настроен');
    }
    try {
      const res = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: igUserId },
          message: { text: body },
        }),
      });
      const data: any = await res.json();
      if (!res.ok) {
        await this.prisma.externalMessage.update({
          where: { id: msg.id }, data: { status: 'FAILED', rawPayload: data },
        });
        throw new BadRequestException(data?.error?.message || 'Instagram send failed');
      }
      await this.prisma.externalMessage.update({
        where: { id: msg.id },
        data: { status: 'SENT', externalId: data?.message_id, sentAt: new Date(), rawPayload: data },
      });
      return data;
    } catch (e: any) {
      this.logger.error(`Instagram send error: ${e.message}`);
      throw e;
    }
  }

  /** Webhook от Meta — приходят DM в Instagram-чат компании. */
  async handleIncoming(payload: any) {
    try {
      const entries = payload?.entry || [];
      for (const entry of entries) {
        const messaging = entry?.messaging || [];
        for (const m of messaging) {
          if (!m?.message?.text && !m?.message?.attachments) continue;
          const senderId = m.sender?.id as string;
          const text = m.message?.text || (m.message?.attachments?.[0]?.type ? `[${m.message.attachments[0].type}]` : '');
          await this.prisma.externalMessage.create({
            data: {
              channel: 'INSTAGRAM',
              direction: 'IN',
              fromHandle: senderId,
              content: text,
              externalId: m.message?.mid,
              receivedAt: m.timestamp ? new Date(m.timestamp) : new Date(),
              status: 'DELIVERED',
              rawPayload: m,
            },
          });
        }
      }
      return { ok: true };
    } catch (e: any) {
      this.logger.error(`Instagram webhook error: ${e.message}`);
      return { ok: false };
    }
  }
}
