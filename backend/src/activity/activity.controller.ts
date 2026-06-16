import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActivityService, ActivityAction } from './activity.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';

@Controller('activity')
@UseGuards(JwtAuthGuard)
export class ActivityController {
  constructor(private activity: ActivityService) {}

  @Get()
  list(
    @Query('actorId') actorId?: string,
    @Query('studentId') studentId?: string,
    @Query('action') action?: ActivityAction,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.activity.list({
      actorId,
      studentId,
      action,
      from: from ? tjParseLocalDate(from) : undefined,
      to: to ? tjParseLocalDateEnd(to) : undefined,
      take: take ? Number(take) : undefined,
    });
  }
}
