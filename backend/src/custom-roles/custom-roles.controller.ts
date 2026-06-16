import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CustomRolesService } from './custom-roles.service';

/**
 * Управление кастомными ролями (ТЗ-доработка). Read-эндпоинты (catalog +
 * list) доступны ADMIN/ACCOUNTANT — им нужно видеть список ролей при
 * создании сотрудника в /users. Mutations (create/update/delete) — только
 * FOUNDER (он один владеет правом раздавать доступы по ТЗ §2).
 */
@Controller('custom-roles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomRolesController {
  constructor(private svc: CustomRolesService) {}

  /** Каталог доступных пермиссий (для UI чекбоксов). */
  @Get('catalog')
  @Roles(Role.FOUNDER, Role.ADMIN, Role.ACCOUNTANT)
  catalog() {
    return this.svc.catalog();
  }

  @Get()
  @Roles(Role.FOUNDER, Role.ADMIN, Role.ACCOUNTANT)
  list() {
    return this.svc.list();
  }

  @Post()
  @Roles(Role.FOUNDER)
  create(@Body() body: { name: string; description?: string; permissions: string[] }) {
    return this.svc.create(body);
  }

  @Patch(':id')
  @Roles(Role.FOUNDER)
  update(@Param('id') id: string, @Body() body: { name?: string; description?: string; permissions?: string[]; isActive?: boolean }) {
    return this.svc.update(id, body);
  }

  @Delete(':id')
  @Roles(Role.FOUNDER)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
