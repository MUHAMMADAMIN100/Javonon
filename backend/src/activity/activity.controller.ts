import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActivityService, ActivityAction } from './activity.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { canSeePartnerAttribution } from '../auth/role-utils';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';

// Журнал действий видит только основатель (решение заказчика): там суммы,
// удаления и чужие действия. RolesGuard: @Roles(FOUNDER) без @Permissions —
// кастомная роль сюда не проходит (см. «только основатель» в RolesGuard).
@Controller('activity')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.FOUNDER)
export class ActivityController {
  constructor(private activity: ActivityService) {}

  @Get()
  list(
    @CurrentUser() me: any,
    @Query('actorId') actorId?: string,
    @Query('studentId') studentId?: string,
    @Query('action') action?: ActivityAction,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.activity.list({
      actorId,
      studentId,
      action,
      from: from ? tjParseLocalDate(from) : undefined,
      to: to ? tjParseLocalDateEnd(to) : undefined,
      take: take ? Number(take) : undefined,
      // Эндпоинт закрыт только JwtAuthGuard, поэтому SALES_MANAGER может
      // дёрнуть его напрямую в обход фронтового гейта в Activity.tsx.
      // Партнёрские строки журнала (PARTNER_SENSITIVE_ACTIONS) содержат имя
      // партнёра и сумму — их нельзя отдавать тем, кому эти же данные
      // вырезаны из карточек сделки/студента/заявки. Гейт тот же самый
      // canSeePartnerAttribution (а НЕ isElevated), иначе носитель кастомной
      // роли с технической подложкой ADMIN прочитал бы здесь ровно то, что
      // ему вырезали в students/applications/submissions.
      viewerCanSeePartnerData: canSeePartnerAttribution(me),
    });
  }
}
