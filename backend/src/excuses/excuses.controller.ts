import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { ExcusesService } from './excuses.service';

@Controller('excuses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.FOUNDER)
export class ExcusesController {
  constructor(private svc: ExcusesService) {}

  /** Pending — нужно разобрать. */
  @Get('pending')
  pending() {
    return this.svc.listPending();
  }

  /** История с фильтром по статусу/сотруднику. */
  @Get()
  list(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('take') take?: string,
  ) {
    const validStatuses = new Set(['PENDING', 'APPROVED', 'REJECTED']);
    return this.svc.listAll({
      status: validStatuses.has(status as any) ? (status as any) : undefined,
      userId: userId || undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.approve(id, me.id);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.reject(id, me.id);
  }
}
