import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { TimeTrackingService } from './time-tracking.service';

@Controller('time')
@UseGuards(JwtAuthGuard)
export class TimeTrackingController {
  constructor(private svc: TimeTrackingService) {}

  @Get('today')
  today(@CurrentUser() me: any) {
    return this.svc.getToday(me.id);
  }

  @Get('history')
  history(
    @CurrentUser() me: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.history(me.id, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Post('clock-in')
  clockIn(@CurrentUser() me: any) {
    return this.svc.clockIn(me.id);
  }

  @Post('lunch-out')
  lunchOut(@CurrentUser() me: any) {
    return this.svc.lunchOut(me.id);
  }

  @Post('lunch-in')
  lunchIn(@CurrentUser() me: any) {
    return this.svc.lunchIn(me.id);
  }

  @Post('clock-out')
  clockOut(@CurrentUser() me: any) {
    return this.svc.clockOut(me.id);
  }

  @Get('team')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  teamStatus() {
    return this.svc.teamStatus();
  }
}
