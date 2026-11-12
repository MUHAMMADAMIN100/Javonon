import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ExternalMessageChannel, ExternalMessageDirection, Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { InboxService } from './inbox.service';
import { Permissions } from '../../auth/permissions.decorator';

@Controller('integrations/inbox')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
@Permissions('inbox:read')
export class InboxController {
  constructor(private svc: InboxService) {}

  @Get()
  list(
    @Query('channel') channel?: ExternalMessageChannel,
    @Query('direction') direction?: ExternalMessageDirection,
    @Query('applicationId') applicationId?: string,
    @Query('studentId') studentId?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.list({
      channel, direction, applicationId, studentId,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  /**
   * Какие каналы подключены (QA-3, BUG-20). Раньше пустые «Входящие» отсылали в
   * «Настройки», где каналов нет: подключение делает разработчик (ключи
   * сервера). Экран теперь показывает честный статус каждого канала. Ключи
   * наружу не уходят — только «да / нет».
   */
  @Get('channels')
  channels() {
    const has = (...names: string[]) => names.every((n) => !!(process.env[n] || '').trim());
    const sms = (process.env.SMS_PROVIDER || '').toLowerCase().trim();
    return {
      WHATSAPP: has('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'),
      INSTAGRAM: has('IG_PAGE_ACCESS_TOKEN', 'IG_ACCOUNT_ID'),
      TELEGRAM: has('TELEGRAM_BOT_TOKEN'),
      SMS:
        (sms === 'smsru' && has('SMSRU_API_ID')) ||
        (sms === 'twilio' && has('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN')) ||
        (sms === 'payom' && has('PAYOM_TOKEN')),
    };
  }

  @Get('threads')
  threads(@Query('channel') channel?: ExternalMessageChannel, @Query('take') take?: string) {
    return this.svc.threads({
      channel, take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('thread')
  thread(
    @Query('channel') channel: ExternalMessageChannel,
    @Query('handle') handle: string,
  ) {
    return this.svc.thread(channel, handle);
  }
}
