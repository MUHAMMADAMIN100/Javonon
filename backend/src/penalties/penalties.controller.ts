import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PenaltiesService } from './penalties.service';
import { PenaltyReason } from '@prisma/client';
import { tjParseLocalDate, tjParseLocalDateEnd, tjStartOfDay } from '../common/tj-time';

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
    // Парсим как Asia/Dushanbe — без этого 'YYYY-MM-DD' трактуется как
    // UTC-полночь и фильтр промахивается.
    const parseStart = (v: string | undefined, name: string): Date | undefined => {
      if (!v) return undefined;
      const d = tjParseLocalDate(v);
      if (isNaN(d.getTime())) throw new BadRequestException(`${name}: некорректная дата`);
      return d;
    };
    const parseEnd = (v: string | undefined, name: string): Date | undefined => {
      if (!v) return undefined;
      const d = tjParseLocalDateEnd(v);
      if (isNaN(d.getTime())) throw new BadRequestException(`${name}: некорректная дата`);
      return d;
    };
    return this.svc.list({
      userId,
      from: parseStart(from, 'from'),
      to: parseEnd(to, 'to'),
      applied: applied === undefined ? undefined : applied === 'true',
    });
  }

  @Post()
  @Roles('ADMIN', 'ACCOUNTANT')
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
  @Roles('ADMIN', 'ACCOUNTANT')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  /** Ручной запуск авто-генерации штрафов за вчера — чтобы можно было
   *  тыкнуть из CRM. «Вчера» считается по Asia/Dushanbe. */
  @Post('generate-yesterday')
  @Roles('ADMIN', 'ACCOUNTANT')
  async runYesterday() {
    const todayTjStart = tjStartOfDay();
    const yesterday = new Date(todayTjStart.getTime() - 60_000);
    return this.svc.generateLatePenaltiesForDate(yesterday);
  }
}
