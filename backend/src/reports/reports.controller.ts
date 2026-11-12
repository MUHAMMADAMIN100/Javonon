import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DailyReportsService, DailyReportInput } from '../daily-reports/daily-reports.service';
import { Permissions } from '../auth/permissions.decorator';

/** Строка «take» из адреса → число 1…366 (или undefined). */
function parseTake(raw?: string): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 366) : undefined;
}

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private svc: DailyReportsService) {}

  @Permissions('reports:read', 'reports:create')
  @Get('today')
  today(@CurrentUser() me: any) {
    return this.svc.getToday(me.id);
  }

  @Permissions('reports:read')
  @Get('me')
  myList(
    @CurrentUser() me: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.myList(me.id, { from, to, take: parseTake(take) });
  }

  @Get('all')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  allList(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.adminList({ userId, from, to, take: parseTake(take) ?? 60 });
  }

  @Permissions('reports:create')
  @Post()
  upsert(@CurrentUser() me: any, @Body() body: DailyReportInput) {
    return this.svc.upsert(me.id, body);
  }

  /** Удалить СВОЙ отчёт (QA-3, BUG-06: ошибочный отчёт было не убрать). */
  @Permissions('reports:create')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.removeOwn(id, me.id);
  }
}
