import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AttendanceService } from './attendance.service';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';

@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.FOUNDER)
export class AttendanceController {
  constructor(private svc: AttendanceService) {}

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    // Парсим как Asia/Dushanbe — UI «Сегодня» присылает локальное
    // YYYY-MM-DD; UTC-парс делает фильтр кривым (день съезжает).
    const parseStart = (s?: string): Date | undefined => {
      if (!s) return undefined;
      const d = tjParseLocalDate(s);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`Некорректная дата: ${s}`);
      return d;
    };
    const parseEnd = (s?: string): Date | undefined => {
      if (!s) return undefined;
      const d = tjParseLocalDateEnd(s);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`Некорректная дата: ${s}`);
      return d;
    };
    return this.svc.list({
      userId: userId || undefined,
      from: parseStart(from),
      to: parseEnd(to),
      take: take ? parseInt(take, 10) : undefined,
    });
  }
}
