import {
  Body, Controller, Get, Post, Query, UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { InstagramService } from './instagram.service';
import { InstagramSignatureGuard } from '../../common/meta-signature.guard';

@Controller('integrations/instagram')
export class InstagramController {
  constructor(private ig: InstagramService) {}

  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const result = this.ig.verifyChallenge(mode, token, challenge);
    if (result) return result;
    return { ok: false };
  }

  // X-Hub-Signature-256 verification по INSTAGRAM_APP_SECRET. Раньше
  // endpoint принимал любого POST'ера — фейковые DM появлялись в Inbox.
  @Post('webhook')
  @UseGuards(InstagramSignatureGuard)
  inbound(@Body() payload: any) {
    return this.ig.handleIncoming(payload);
  }

  @Post('send')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  send(@Body() body: { igUserId: string; message: string; applicationId?: string; studentId?: string }) {
    return this.ig.sendDM(body.igUserId, body.message, {
      applicationId: body.applicationId, studentId: body.studentId,
    });
  }
}
