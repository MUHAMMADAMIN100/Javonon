import {
  Body, Controller, Get, Header, Post, Query, UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { TelephonyService } from './telephony.service';

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
   * Возвращает XML «куда дозваниваться».
   */
  @Post('voice')
  @Header('Content-Type', 'application/xml')
  voice(@Body() body: any, @Query('To') toQuery?: string) {
    const to = body?.To || toQuery || '';
    return this.tel.buildOutboundTwiML(to);
  }

  /** Webhook от Twilio со статусом звонка. Auth — query-token (?u=<userId>). */
  @Post('call-status')
  callStatus(@Body() body: any, @Query('u') userId?: string) {
    return this.tel.handleCallStatus(body, userId);
  }
}
