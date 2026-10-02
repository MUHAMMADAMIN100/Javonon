import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SalaryService } from './salary.service';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';

@Controller('salary')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class SalaryController {
  constructor(private svc: SalaryService) {}

  @Get()
  list(@Query('userId') userId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.list({
      userId,
      // Парсим как Asia/Dushanbe — UI присылает 'YYYY-MM-DD', а
      // new Date(s) даёт UTC-полночь, которая в Душанбе уже 05:00 след. дня.
      from: from ? tjParseLocalDate(from) : undefined,
      to: to ? tjParseLocalDateEnd(to) : undefined,
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
      tjParseLocalDate(periodStart),
      tjParseLocalDateEnd(periodEnd),
      kpiBonus ? parseFloat(kpiBonus) : 0,
    );
  }

  /** Таблица зарплат: все работающие сотрудники за период. */
  @Get('preview-all')
  previewAll(
    @Query('periodStart') periodStart: string,
    @Query('periodEnd') periodEnd: string,
  ) {
    return this.svc.previewAll(tjParseLocalDate(periodStart), tjParseLocalDateEnd(periodEnd));
  }

  @Post()
  create(@Body() dto: { userId: string; periodStart: string; periodEnd: string; kpiBonus?: number; comment?: string }) {
    return this.svc.create(dto);
  }

  @Post(':id/pay')
  markPaid(@Param('id') id: string) {
    return this.svc.markPaid(id);
  }

  /** «Было → станет» для всех невыплаченных записей периода — без сохранения. */
  @Get('recalculate-preview')
  recalculatePreviewAll(@Query('periodStart') periodStart: string, @Query('periodEnd') periodEnd: string) {
    const [from, to] = parsePeriod(periodStart, periodEnd);
    return this.svc.recalculatePreviewAll(from, to);
  }

  /** Пересчитать все невыплаченные записи периода по текущим данным. */
  @Post('recalculate-all')
  recalculateAll(@Body() body: { periodStart: string; periodEnd: string }) {
    const [from, to] = parsePeriod(body?.periodStart, body?.periodEnd);
    return this.svc.recalculateAll(from, to);
  }

  @Get(':id/recalculate-preview')
  recalculatePreview(@Param('id') id: string) {
    return this.svc.recalculatePreview(id);
  }

  @Post(':id/recalculate')
  recalculate(@Param('id') id: string) {
    return this.svc.recalculate(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}

/** Период «YYYY-MM-DD — YYYY-MM-DD» по Душанбе; мусор — 400, а не 500. */
function parsePeriod(start?: string, end?: string): [Date, Date] {
  const from = tjParseLocalDate(String(start ?? ''));
  const to = tjParseLocalDateEnd(String(end ?? ''));
  if (!start || !end || isNaN(from.getTime()) || isNaN(to.getTime()) || to < from) {
    throw new BadRequestException('Некорректный период');
  }
  return [from, to];
}
