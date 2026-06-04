import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { SettingsService } from './settings.service';
import { isFounder } from '../auth/role-utils';

/**
 * Все настраиваемые параметры компании. Чтение — авторизованный
 * сотрудник; модификация — только FOUNDER. Реализовано декораторами
 * на каждом методе (PUT/POST/PATCH/DELETE требуют FOUNDER).
 */
@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private svc: SettingsService) {}

  // ----- Work Schedule -----

  /**
   * Получить график. userId не задан = дефолт компании.
   * Сотрудник может посмотреть только свой график (или дефолт). FOUNDER
   * — любой.
   */
  @Get('schedule')
  getSchedule(@Query('userId') userId: string | undefined, @CurrentUser() me: any) {
    let target = userId || null;
    if (target && target !== me.id && !isFounder(me)) {
      throw new BadRequestException('Доступ только к своему графику');
    }
    return this.svc.getSchedule(target);
  }

  @Put('schedule')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  upsertSchedule(@Body() body: { userId?: string | null; days: any[] }) {
    return this.svc.upsertSchedule(body.userId ?? null, body.days);
  }

  // ----- Penalty Rules -----

  @Get('penalty-rules')
  listPenaltyRules() {
    return this.svc.listPenaltyRules();
  }

  @Post('penalty-rules')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  createPenaltyRule(@Body() body: any) {
    return this.svc.createPenaltyRule(body);
  }

  @Patch('penalty-rules/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  updatePenaltyRule(@Param('id') id: string, @Body() body: any) {
    return this.svc.updatePenaltyRule(id, body);
  }

  @Delete('penalty-rules/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  deletePenaltyRule(@Param('id') id: string) {
    return this.svc.deletePenaltyRule(id);
  }

  // ----- Work Location -----

  @Get('work-location')
  getActiveLocation() {
    return this.svc.getActiveLocation();
  }

  @Get('work-locations')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  listLocations() {
    return this.svc.listLocations();
  }

  @Post('work-locations')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  createLocation(@Body() body: any) {
    return this.svc.createLocation(body);
  }

  @Patch('work-locations/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  updateLocation(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateLocation(id, body);
  }

  @Delete('work-locations/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  deleteLocation(@Param('id') id: string) {
    return this.svc.deleteLocation(id);
  }
}
