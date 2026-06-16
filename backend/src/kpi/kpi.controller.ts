import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { KpiService } from './kpi.service';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';

@Controller('kpi')
@UseGuards(JwtAuthGuard)
export class KpiController {
  constructor(private svc: KpiService) {}

  /** Топ-сотрудники. Видят все. EMPLOYEE видит свою строку выделенной. */
  @Get('leaderboard')
  leaderboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.leaderboard({
      from: from ? tjParseLocalDate(from) : undefined,
      to: to ? tjParseLocalDateEnd(to) : undefined,
    });
  }

  /** Свой KPI — себе. */
  @Get('me')
  me(@CurrentUser() me: any) {
    return this.svc.forUser(me.id);
  }

  /** KPI любого сотрудника — только админ. */
  @Get(':userId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  byUser(@Param('userId') userId: string) {
    return this.svc.forUser(userId);
  }
}
