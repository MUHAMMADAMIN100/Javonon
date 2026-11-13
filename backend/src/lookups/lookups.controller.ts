import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { LookupKind, Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Permissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { LookupInput, LookupsService } from './lookups.service';
import { LOOKUP_KINDS } from './lookup-defaults';

/**
 * Справочники «Лиды → Настройки». Читают все сотрудники (подписи и списки
 * в каждом экране), правят основатель и роль с «Настройки лидов».
 */
@Controller('lookups')
export class LookupsController {
  constructor(private readonly svc: LookupsService) {}

  /** Сайт: направления и страны для формы и каталога, подписи статусов для кабинета. */
  @Get('public')
  publicList() {
    return this.svc.publicList();
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  list() {
    return { items: LOOKUP_KINDS.flatMap((k) => this.svc.items(k)) };
  }

  /** Сколько записей на каждом значении — для экрана настроек и окна удаления. */
  @Get('usage')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  async usage(@Query('kind') kind: LookupKind) {
    const kinds = LOOKUP_KINDS.includes(kind) ? [kind] : LOOKUP_KINDS;
    const out: Record<string, Record<string, number>> = {};
    for (const k of kinds) out[k] = await this.svc.usage(k);
    return out;
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  create(@Body() body: LookupInput, @CurrentUser() me: any) {
    return this.svc.create(body || {}, me);
  }

  @Put('order')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  reorder(@Body() body: { kind: LookupKind; ids: string[] }, @CurrentUser() me: any) {
    return this.svc.reorder(body?.kind, body?.ids, me);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  update(@Param('id') id: string, @Body() body: LookupInput, @CurrentUser() me: any) {
    return this.svc.update(id, body || {}, me);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.FOUNDER)
  @Permissions('settings:lookups')
  remove(@Param('id') id: string, @Query('moveTo') moveTo: string | undefined, @CurrentUser() me: any) {
    return this.svc.remove(id, moveTo || undefined, me);
  }
}
