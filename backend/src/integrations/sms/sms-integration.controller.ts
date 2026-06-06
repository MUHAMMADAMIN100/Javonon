import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { SmsService } from '../../sms/sms.service';
import { PrismaService } from '../../prisma/prisma.service';

// E.164-совместимая проверка телефона. Раньше отсутствовала — staff
// мог отправить SMS на любую строку (провайдер биллит за попытку).
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;
// Стандартный SMS = 160 символов; multipart до 1600. Раньше cap'а не
// было — 100kb сообщение биллится провайдером по символьно.
const MAX_SMS_LENGTH = 1600;

/**
 * Тонкая обёртка над SmsService для интеграционного использования
 * из Inbox (ответ на входящее SMS). Также пишет outbox-сообщение в
 * ExternalMessage, чтобы отправленное появилось в ленте переписки.
 */
@Controller('integrations/sms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
export class SmsIntegrationController {
  constructor(private sms: SmsService, private prisma: PrismaService) {}

  // 20 SMS/мин/IP — compromised staff не сможет слать тысячи. Глобальный
  // 60/min слишком мягкий когда каждое SMS = реальные деньги.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('send')
  async send(
    @Body() body: { to: string; message: string; applicationId?: string; studentId?: string },
  ) {
    const to = (body.to || '').trim();
    const message = (body.message || '').trim();
    if (!to || !message) {
      throw new BadRequestException('to и message обязательны');
    }
    if (!PHONE_RE.test(to)) {
      throw new BadRequestException('to должен быть телефоном в формате +992...');
    }
    if (message.length > MAX_SMS_LENGTH) {
      throw new BadRequestException(`Сообщение слишком длинное (макс. ${MAX_SMS_LENGTH} символов)`);
    }
    body.to = to;
    body.message = message;
    const msg = await this.prisma.externalMessage.create({
      data: {
        channel: 'SMS',
        direction: 'OUT',
        toHandle: body.to.trim(),
        content: body.message.trim(),
        applicationId: body.applicationId || null,
        studentId: body.studentId || null,
        status: 'PENDING',
      },
    });
    const ok = await this.sms.send(body.to.trim(), body.message.trim());
    await this.prisma.externalMessage.update({
      where: { id: msg.id },
      data: {
        status: ok ? 'SENT' : 'FAILED',
        sentAt: ok ? new Date() : null,
      },
    });
    if (!ok) throw new BadRequestException('SMS не отправлено (провайдер не настроен или ошибка)');
    return { ok: true };
  }
}
