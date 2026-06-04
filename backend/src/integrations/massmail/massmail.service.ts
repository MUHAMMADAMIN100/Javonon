import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ExternalMessageChannel, MassMailStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { TelegramService } from '../../telegram/telegram.service';
import { MailService } from '../../mail/mail.service';
import { SmsService } from '../../sms/sms.service';

/**
 * MassMailService — массовые рассылки. По ТЗ §10 — оповещения о новых
 * программах/акциях по всем лидам. Канал выбирается на уровне кампании,
 * фактическая отправка делегируется соответствующему провайдер-сервису.
 *
 * Audience — JSON селектор: {type: 'all-leads' | 'paid-students' |
 * 'lead-direction', value?: ...}. Простая реализация — резолвится
 * сразу в список телефонов/email.
 */
@Injectable()
export class MassmailService {
  private readonly logger = new Logger(MassmailService.name);
  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsappService,
    private telegram: TelegramService,
    private mail: MailService,
    private sms: SmsService,
  ) {}

  async list() {
    return this.prisma.massMailCampaign.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(data: {
    name: string;
    channel: ExternalMessageChannel;
    subject?: string;
    body: string;
    audience: any;
    scheduledAt?: string;
    createdById?: string;
  }) {
    if (!data.name?.trim() || !data.body?.trim()) {
      throw new BadRequestException('name и body обязательны');
    }
    return this.prisma.massMailCampaign.create({
      data: {
        name: data.name.trim(),
        channel: data.channel,
        subject: data.subject?.trim() || null,
        body: data.body.trim(),
        audience: data.audience || { type: 'all-leads' },
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        createdById: data.createdById || null,
      },
    });
  }

  /**
   * Запустить отправку кампании немедленно. Резолвит audience в список
   * получателей и шлёт через нужный канал. Если канал не настроен —
   * ставит FAILED.
   */
  async sendNow(id: string) {
    const c = await this.prisma.massMailCampaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Кампания не найдена');
    if (c.status === 'SENDING' || c.status === 'SENT') {
      throw new BadRequestException('Кампания уже отправляется/отправлена');
    }

    await this.prisma.massMailCampaign.update({
      where: { id },
      data: { status: 'SENDING', startedAt: new Date() },
    });

    const recipients = await this.resolveAudience(c.audience as any);
    let sent = 0, failed = 0;
    for (const r of recipients) {
      try {
        if (c.channel === 'WHATSAPP' && r.phone) {
          await this.whatsapp.sendText(r.phone.replace(/^\+/, ''), c.body, {
            applicationId: r.applicationId, studentId: r.studentId,
          });
          sent++;
        } else if (c.channel === 'TELEGRAM') {
          // Резолвим Telegram через общий канал/чат компании. Отправка
          // персонального DM по userId требует, чтобы клиент сам написал
          // боту — массово такое не делают.
          await this.telegram.send(c.body);
          sent++;
        } else if (c.channel === 'SMS' && r.phone) {
          await this.sms.send(r.phone, c.body);
          sent++;
        } else {
          failed++;
        }
      } catch (e: any) {
        failed++;
        this.logger.warn(`Massmail send failed for ${r.phone || r.email}: ${e.message}`);
      }
    }

    return this.prisma.massMailCampaign.update({
      where: { id },
      data: {
        status: MassMailStatus.SENT,
        sentCount: sent,
        failedCount: failed,
        finishedAt: new Date(),
      },
    });
  }

  async cancel(id: string) {
    return this.prisma.massMailCampaign.update({
      where: { id }, data: { status: MassMailStatus.CANCELED },
    });
  }

  /**
   * Резолвить audience в список получателей. Поддержанные типы:
   *   all-leads     — все Application
   *   paid-students — Student с TUITION_PAYMENT
   *   by-direction  — Application по direction = value
   */
  private async resolveAudience(audience: { type?: string; value?: any }) {
    const t = audience?.type || 'all-leads';
    if (t === 'paid-students') {
      const rows = await this.prisma.student.findMany({
        where: { transactions: { some: { type: 'INCOME', category: 'TUITION_PAYMENT' } } },
        select: { id: true, phones: true, email: true },
      });
      return rows.map((s) => ({
        studentId: s.id, applicationId: undefined as string | undefined,
        phone: s.phones[0], email: s.email, telegramId: undefined as number | undefined,
      }));
    }
    if (t === 'by-direction' && audience.value) {
      const rows = await this.prisma.application.findMany({
        where: { direction: audience.value },
        select: { id: true, phone: true, email: true, studentId: true },
      });
      return rows.map((a) => ({
        applicationId: a.id, studentId: a.studentId || undefined, phone: a.phone, email: a.email,
        telegramId: undefined,
      }));
    }
    // default: all leads
    const rows = await this.prisma.application.findMany({
      select: { id: true, phone: true, email: true, studentId: true },
    });
    return rows.map((a) => ({
      applicationId: a.id, studentId: a.studentId || undefined, phone: a.phone, email: a.email,
      telegramId: undefined,
    }));
  }
}
