import { BadRequestException, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Permissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { ExcusesService, type LatenessFilter } from './excuses.service';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';
import { canSeeData, maskStaffEmails } from '../common/redact';

@Controller('excuses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.FOUNDER)
// Кастомная роль с этим правом тоже (см. RolesGuard: «только основатель»).
@Permissions('excuses:read', 'excuses:approve')
export class ExcusesController {
  constructor(private svc: ExcusesService) {}

  /** Pending — нужно разобрать. */
  @Get('pending')
  async pending(@CurrentUser() me: any) {
    return maskStaffEmails(me, (await this.svc.listPending()) as any[]);
  }

  /**
   * «История» — все опоздания с фильтрами и итогами.
   * from/to — «YYYY-MM-DD» по Душанбе (включительно), status — approved |
   * not_approved | pending (пусто — все), page с 1, pageSize до 100.
   */
  @Get('history')
  async history(
    @CurrentUser() me: any,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !day.test(from)) || (to && !day.test(to))) {
      throw new BadRequestException('Дата — в формате ГГГГ-ММ-ДД');
    }
    const fromAt = from ? tjParseLocalDate(from) : undefined;
    const toAt = to ? tjParseLocalDateEnd(to) : undefined;
    if ((fromAt && isNaN(fromAt.getTime())) || (toAt && isNaN(toAt.getTime()))) {
      throw new BadRequestException('Некорректная дата');
    }
    if (fromAt && toAt && toAt < fromAt) throw new BadRequestException('Дата «по» раньше даты «с»');
    const statuses = new Set<LatenessFilter>(['approved', 'not_approved', 'pending']);
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize || '10', 10) || 10));
    const res = await this.svc.history({
      userId: userId || undefined,
      from: fromAt,
      to: toAt,
      status: statuses.has(status as LatenessFilter) ? (status as LatenessFilter) : undefined,
      page: p,
      pageSize: size,
    });
    const items = maskStaffEmails(me, res.items);
    // Штрафы коллег — деньги из «Зарплат и окладов» роли.
    if (canSeeData(me, 'visibility:staff-pay')) return { ...res, items };
    return {
      ...res,
      items: items.map((it) => ({ ...it, penalty: null })),
      totals: { ...res.totals, penalties: null },
      payHidden: true,
    };
  }

  /** История с фильтром по статусу/сотруднику. */
  @Get()
  async list(
    @CurrentUser() me: any,
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('take') take?: string,
  ) {
    const validStatuses = new Set(['PENDING', 'APPROVED', 'REJECTED']);
    return maskStaffEmails(me, (await this.svc.listAll({
      status: validStatuses.has(status as any) ? (status as any) : undefined,
      userId: userId || undefined,
      take: take ? parseInt(take, 10) : undefined,
    })) as any[]);
  }

  @Permissions('excuses:approve')
  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.approve(id, me.id);
  }

  @Permissions('excuses:approve')
  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.reject(id, me.id);
  }

  @Permissions('excuses:approve')
  @Post(':id/approve-lunch')
  approveLunch(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.approveLunch(id, me.id);
  }

  @Permissions('excuses:approve')
  @Post(':id/reject-lunch')
  rejectLunch(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.rejectLunch(id, me.id);
  }
}
