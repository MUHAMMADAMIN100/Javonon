import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ReportsService } from './reports.service';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private svc: ReportsService) {}

  @Get('today')
  today(@CurrentUser() me: any) {
    return this.svc.todayForUser(me.id);
  }

  @Get('me')
  myList(
    @CurrentUser() me: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.list(me.id, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('all')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  allList(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.list(userId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Post()
  upsert(
    @CurrentUser() me: any,
    @Body() body: {
      date?: string;
      callsCount?: number;
      meetingsCount?: number;
      applicationsContacted?: number;
      salesCount?: number;
      salesAmount?: number;
      activitySummary?: string;
      challenges?: string;
    },
  ) {
    return this.svc.upsertDaily(me.id, body.date ? new Date(body.date) : new Date(), body);
  }
}
