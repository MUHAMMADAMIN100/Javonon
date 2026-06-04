import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { SmsService } from '../../sms/sms.service';
import { PrismaService } from '../../prisma/prisma.service';

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

  @Post('send')
  async send(
    @Body() body: { to: string; message: string; applicationId?: string; studentId?: string },
  ) {
    if (!body.to?.trim() || !body.message?.trim()) {
      throw new BadRequestException('to и message обязательны');
    }
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
