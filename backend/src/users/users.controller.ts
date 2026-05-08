import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.users.findAll({ search });
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() me: any) {
    // QA-fix #44 (часть 2): админ не может понизить себя — иначе после понижения
    // он не сможет вернуть себе ADMIN, и система останется без админа.
    if (id === me.id && dto.role && dto.role !== 'ADMIN') {
      throw new BadRequestException('Нельзя понизить собственную роль');
    }
    return this.users.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    // QA-fix #44: админ не может удалить сам себя — это ломает систему.
    if (id === me.id) {
      throw new BadRequestException('Нельзя удалить собственный аккаунт');
    }
    return this.users.remove(id);
  }
}
