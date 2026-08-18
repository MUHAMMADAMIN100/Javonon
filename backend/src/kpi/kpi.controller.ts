import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { KpiService } from './kpi.service';
import { parseDate } from '../common/query-date';

@Controller('kpi')
@UseGuards(JwtAuthGuard)
export class KpiController {
  constructor(private svc: KpiService) {}

  /**
   * Топ-сотрудники. Видят все. EMPLOYEE видит свою строку выделенной.
   *
   * Границы периода разбирает общий parseDate (common/query-date.ts) — тот
   * же, что у finance/*, applications/stats и students/stats: 00:00:00.000 и
   * 23:59:59.999 Asia/Dushanbe. Свой инлайновый парсер здесь был четвёртым
   * экземпляром — ровно тем путём, которым в проекте уже разъезжались
   * границы суток. Заодно мусор в query теперь даёт 400, а не Invalid Date,
   * улетающий в Prisma.
   *
   * Без from/to оба значения undefined → KpiService считает за всё время.
   */
  @Get('leaderboard')
  leaderboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.leaderboard({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
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
