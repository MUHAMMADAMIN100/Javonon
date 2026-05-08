import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PenaltiesService } from './penalties.service';
import { PenaltyReason } from '@prisma/client';

@Controller('penalties')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class PenaltiesController {
  constructor(private svc: PenaltiesService) {}

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('applied') applied?: string,
  ) {
    // QA-fix #47: безопасный парсинг дат.
    const parseDate = (v: string | undefined, name: string): Date | undefined => {
      if (!v) return undefined;
      const d = new Date(v);
      if (isNaN(d.getTime())) throw new BadRequestException(`${name}: некорректная дата`);
      return d;
    };
    return this.svc.list({
      userId,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      applied: applied === undefined ? undefined : applied === 'true',
    });
  }

  @Post()
  @Roles('ADMIN')
  create(
    @Body() body: { userId: string; reason?: PenaltyReason; amount: number; details: string; date?: string },
  ) {
    return this.svc.createManual(body.userId, {
      reason: body.reason || 'CUSTOM',
      amount: body.amount,
      details: body.details,
      date: body.date,
    });
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  /** Ручной запуск авто-генерации штрафов за вчера — чтобы можно было тыкнуть из CRM. */
  @Post('generate-yesterday')
  @Roles('ADMIN')
  async runYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return this.svc.generateLatePenaltiesForDate(yesterday);
  }
}
