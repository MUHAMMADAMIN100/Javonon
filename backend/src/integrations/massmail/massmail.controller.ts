import {
  Body, Controller, Delete, Get, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { MassmailService } from './massmail.service';
import { CreateMassmailDto } from './dto/massmail.dto';
import { Permissions } from '../../auth/permissions.decorator';

@Controller('integrations/massmail')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.ACCOUNTANT)
@Permissions('massmail:read')
export class MassmailController {
  constructor(private mm: MassmailService) {}

  @Get()
  list() { return this.mm.list(); }

  @Permissions('massmail:create')
  @Post()
  create(@Body() body: CreateMassmailDto, @CurrentUser() me: any) {
    return this.mm.create({ ...body, createdById: me.id });
  }

  @Permissions('massmail:send')
  @Post(':id/send')
  sendNow(@Param('id') id: string) {
    return this.mm.sendNow(id);
  }

  @Permissions('massmail:send')
  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.mm.cancel(id);
  }
}
