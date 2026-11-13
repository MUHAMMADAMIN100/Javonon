import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Permissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { LeadFieldInput, LeadFieldsService } from './lead-fields.service';

/**
 * Свои поля анкеты лида («Лиды → Настройки → Поля анкеты»). Читают все
 * сотрудники (поля видны в формах и карточках), правят основатель и роль
 * с «Настройки лидов».
 */
@Controller('lead-fields')
@UseGuards(JwtAuthGuard)
export class LeadFieldsController {
  constructor(private readonly svc: LeadFieldsService) {}

  @Get()
  list() {
    return { items: this.svc.list() };
  }

  @Get('usage')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  usage() {
    return this.svc.usage();
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  create(@Body() body: LeadFieldInput, @CurrentUser() me: any) {
    return this.svc.create(body || {}, me);
  }

  @Put('order')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  reorder(@Body() body: { ids: string[] }, @CurrentUser() me: any) {
    return this.svc.reorder(body?.ids, me);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  update(@Param('id') id: string, @Body() body: LeadFieldInput, @CurrentUser() me: any) {
    return this.svc.update(id, body || {}, me);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.remove(id, me);
  }
}
