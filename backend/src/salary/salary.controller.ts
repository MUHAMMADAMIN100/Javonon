import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SalaryService } from './salary.service';

@Controller('salary')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class SalaryController {
  constructor(private svc: SalaryService) {}

  @Get()
  list(@Query('userId') userId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.list({
      userId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get('preview')
  preview(
    @Query('userId') userId: string,
    @Query('periodStart') periodStart: string,
    @Query('periodEnd') periodEnd: string,
    @Query('kpiBonus') kpiBonus?: string,
  ) {
    return this.svc.preview(
      userId,
      new Date(periodStart),
      new Date(periodEnd),
      kpiBonus ? parseFloat(kpiBonus) : 0,
    );
  }

  @Post()
  create(@Body() dto: { userId: string; periodStart: string; periodEnd: string; kpiBonus?: number; comment?: string }) {
    return this.svc.create(dto);
  }

  @Post(':id/pay')
  markPaid(@Param('id') id: string) {
    return this.svc.markPaid(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
