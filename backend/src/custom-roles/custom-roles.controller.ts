import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CustomRolesService } from './custom-roles.service';

/**
 * Управление кастомными ролями (ТЗ-доработка: «FOUNDER в /settings может
 * создавать новые роли с произвольными доступами»). Доступно только
 * FOUNDER'у (RolesGuard всё равно пропустит FOUNDER неявно, но явно
 * указываем @Roles, чтобы намерение было видно в коде).
 */
@Controller('custom-roles')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.FOUNDER)
export class CustomRolesController {
  constructor(private svc: CustomRolesService) {}

  /** Каталог доступных пермиссий (для UI чекбоксов). */
  @Get('catalog')
  catalog() {
    return this.svc.catalog();
  }

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() body: { name: string; description?: string; permissions: string[] }) {
    return this.svc.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; description?: string; permissions?: string[]; isActive?: boolean }) {
    return this.svc.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
