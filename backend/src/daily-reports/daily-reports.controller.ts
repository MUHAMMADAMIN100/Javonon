import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { DailyReportsService, DailyReportInput } from './daily-reports.service';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';

@Controller('daily-reports')
@UseGuards(JwtAuthGuard)
export class DailyReportsController {
  constructor(private svc: DailyReportsService) {}

  /** Сегодняшний отчёт (для UI «Дневной отчёт» в кабинете сотрудника). */
  @Get('today')
  today(@CurrentUser() me: any) {
    return this.svc.getToday(me.id);
  }

  /** Моя история отчётов. */
  @Get('mine')
  mine(
    @CurrentUser() me: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.myList(me.id, {
      from: from ? tjParseLocalDate(from) : undefined,
      to: to ? tjParseLocalDateEnd(to) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  /** Создать/обновить (upsert) отчёт. */
  @Post()
  upsert(@CurrentUser() me: any, @Body() body: DailyReportInput) {
    return this.svc.upsert(me.id, body);
  }

  /** Удалить — свой; ADMIN может любой. */
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.remove(id, me.id, me.role);
  }

  /** ADMIN: список всех отчётов с фильтрами. */
  @Get()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  adminList(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.adminList({
      userId,
      from: from ? tjParseLocalDate(from) : undefined,
      to: to ? tjParseLocalDateEnd(to) : undefined,
    });
  }
}
