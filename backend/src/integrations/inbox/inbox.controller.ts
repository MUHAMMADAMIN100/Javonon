import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ExternalMessageChannel, ExternalMessageDirection, Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { InboxService } from './inbox.service';

@Controller('integrations/inbox')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
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
