import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { OffersService } from './offers.service';

@Controller('offers')
@UseGuards(JwtAuthGuard)
export class OffersController {
  constructor(private offers: OffersService) {}

  /** Текущая активная оферта + статус подписи для вызывающего сотрудника. */
  @Get('current')
  current(@CurrentUser() me: any) {
    return this.offers.current(me.id);
  }

  /** Подписать оферту. Идемпотентно. */
  @Post(':id/sign')
  sign(@Param('id') id: string, @CurrentUser() me: any, @Req() req: Request) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      undefined;
    const userAgent = req.headers['user-agent'] as string | undefined;
    return this.offers.sign(me.id, id, { ip, userAgent });
  }

  /** Список всех версий — FOUNDER/ADMIN. */
  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  list() {
    return this.offers.list();
  }

  /** Создать новую версию (старая для этой ЖЕ роли станет inactive). FOUNDER/ADMIN. */
  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  create(@Body() body: { title?: string; content: string; role?: Role | null }) {
    return this.offers.createNew(body);
  }

  /** Редактировать текущую версию (только если ещё никто не подписал). */
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  patch(@Param('id') id: string, @Body() body: { title?: string; content?: string }) {
    return this.offers.patch(id, body);
  }

  /** Все подписи под версией — для аудита. FOUNDER/ADMIN. */
  @Get(':id/signatures')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  signatures(@Param('id') id: string) {
    return this.offers.signatures(id);
  }

  /**
   * Удалить версию (D в CRUD по ТЗ §1). Запрещено если есть подписи —
   * это audit trail который трогать нельзя. Service автоматически
   * поднимает предыдущую версию активной, если удалили активную.
   */
  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  remove(@Param('id') id: string) {
    return this.offers.remove(id);
  }
}
