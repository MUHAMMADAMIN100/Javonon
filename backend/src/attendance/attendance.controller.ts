import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AttendanceService } from './attendance.service';

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
    const parseDate = (s?: string): Date | undefined => {
      if (!s) return undefined;
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`Некорректная дата: ${s}`);
      return d;
    };
    return this.svc.list({
      userId: userId || undefined,
      from: parseDate(from),
      to: parseDate(to),
      take: take ? parseInt(take, 10) : undefined,
    });
  }
}
