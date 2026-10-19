import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { KpiService } from './kpi.service';
import { parseDate } from '../common/query-date';
import { Permissions } from '../auth/permissions.decorator';
import { canSeeData } from '../common/redact';

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
  @Permissions('kpi:read')
  @Get('leaderboard')
  async leaderboard(@CurrentUser() me: any, @Query('from') from?: string, @Query('to') to?: string) {
    const rows = await this.svc.leaderboard({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
    });
    // Чужие суммы продаж — «Деньги компании», чужие ставки и бонусы —
    // «Зарплаты и оклады»; свою строку сотрудник видит целиком.
    const money = canSeeData(me, 'visibility:company-money');
    const pay = canSeeData(me, 'visibility:staff-pay');
    if (money && pay) return rows;
    return rows.map((r: any) => {
      if (r.id === me?.id) return r;
      const out = { ...r };
      if (!money) Object.assign(out, { salesAmount: null, otherIncome: null, nonTjsSales: {}, moneyHidden: true });
      if (!pay) Object.assign(out, { bonusPercent: null, bonusProgress: undefined, payHidden: true });
      return out;
    });
  }

  /** Свой KPI — себе. */
  @Get('me')
  me(@CurrentUser() me: any) {
    return this.svc.forUser(me.id);
  }

  /**
   * Подробности по строке рейтинга за тот же период: студенты, платежи,
   * заявки. Доступ (руководство — любого, сотрудник — себя) проверяет
   * сервис: правило зависит от того, КОГО открывают, а не только от роли.
   */
  @Get(':userId/details')
  async details(
    @Param('userId') userId: string,
    @CurrentUser() me: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const d: any = await this.svc.details(userId, { from: parseDate(from, 'from'), to: parseDate(to, 'to', true) }, me);
    if (userId === me?.id) return d;
    // Чужие подробности: суммы продаж — «Деньги компании», оплаты студентов — «Деньги клиентов».
    const out = { ...d };
    if (!canSeeData(me, 'visibility:company-money')) {
      out.sales = (d.sales || []).map((s: any) => ({ ...s, amount: null, originalAmount: null }));
      out.otherCurrencySales = (d.otherCurrencySales || []).map((s: any) => ({ ...s, amount: null, originalAmount: null }));
      out.totals = { ...d.totals, salesAmount: null, otherIncome: null };
      out.moneyHidden = true;
    }
    if (!canSeeData(me, 'visibility:client-money')) {
      out.students = (d.students || []).map((s: any) => ({ ...s, paidTotal: null }));
      out.clientMoneyHidden = true;
    }
    return out;
  }

  /** KPI любого сотрудника — только админ. */
  @Get(':userId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  @Permissions('kpi:details')
  byUser(@Param('userId') userId: string) {
    return this.svc.forUser(userId);
  }
}
