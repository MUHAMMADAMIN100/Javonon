import {
  Body, Controller, Get, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { WhatsappService } from './whatsapp.service';

@Controller('integrations/whatsapp')
export class WhatsappController {
  constructor(private wa: WhatsappService) {}

  // Webhook verification (Meta делает GET с hub.challenge)
  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const result = this.wa.verifyChallenge(mode, token, challenge);
    if (result) return result;
    return { ok: false };
  }

  // Webhook inbound — без auth (Meta не передаёт JWT).
  @Post('webhook')
  inbound(@Body() payload: any, @Req() _req: Request) {
    return this.wa.handleIncoming(payload);
  }

  // Ручная отправка — из CRM. Только staff.
  @Post('send')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  send(
    @Body() body: { to: string; message: string; applicationId?: string; studentId?: string },
  ) {
    return this.wa.sendText(body.to, body.message, {
      applicationId: body.applicationId,
      studentId: body.studentId,
    });
  }
}
