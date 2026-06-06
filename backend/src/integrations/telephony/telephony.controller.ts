import {
  Body, Controller, Get, Header, Post, Query, UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { TelephonyService } from './telephony.service';
import { TwilioSignatureGuard } from './twilio-signature.guard';

@Controller('integrations/telephony')
export class TelephonyController {
  constructor(private tel: TelephonyService) {}

  /** Выдать access-token для Twilio Voice Device (browser WebRTC). */
  @Get('token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  token(@CurrentUser() me: any) {
    return this.tel.issueAccessToken(me.id);
  }

  /**
   * TwiML endpoint — Twilio дёргает при исходящем звонке через Device.
   * Возвращает XML «куда дозваниваться». ?u=<userId> прокидывается
   * во вложенный recordingStatusCallback URL, чтобы мы знали кому
   * писать в CallLog.
   */
  @Post('voice')
  @Header('Content-Type', 'application/xml')
  voice(
    @Body() body: any,
    @Query('To') toQuery?: string,
    @Query('u') userId?: string,
  ) {
    const to = body?.To || toQuery || '';
    return this.tel.buildOutboundTwiML(to, userId);
  }

  /**
   * Webhook от Twilio со статусом звонка. Auth — X-Twilio-Signature
   * (HMAC-SHA1 от URL+payload). Без guard любой POST создавал бы
   * фейковые CallLog'и для произвольного userId (?u=).
   */
  @Post('call-status')
  @UseGuards(TwilioSignatureGuard)
  callStatus(@Body() body: any, @Query('u') userId?: string) {
    return this.tel.handleCallStatus(body, userId);
  }

  /**
   * Webhook RecordingStatusCallback — приходит после завершения записи.
   * URL сюда передаём в TwiML через recordingStatusCallback. Заполняет
   * CallLog.recordingUrl (по ТЗ §6f).
   *
   * Та же подпись через TwilioSignatureGuard — иначе атакующий мог бы
   * перезаписать recordingUrl у существующего CallLog malicious-ссылкой.
   */
  @Post('recording-status')
  @UseGuards(TwilioSignatureGuard)
  recordingStatus(@Body() body: any) {
    return this.tel.handleRecordingStatus(body);
  }
}
