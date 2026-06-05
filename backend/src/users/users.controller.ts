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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { Role } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

const userDocStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname || '') || '';
    cb(null, `userdoc-${randomUUID()}${ext}`);
  },
});

/**
 * Self-эндпоинты + просмотр чужих профилей с проверкой доступа.
 * Не использует ADMIN-guard — доступ решается внутри (ADMIN / self /
 * DataAccessGrant).
 */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(private users: UsersService) {}

  @Get('full')
  myFullProfile(@CurrentUser() me: any) {
    return this.users.fullProfile(me.id);
  }

  /** Профиль другого сотрудника — доступ через canViewProfile. */
  @Get('profile/:id')
  async viewProfile(@Param('id') id: string, @CurrentUser() me: any) {
    const ok = await this.users.canViewProfile(me.id, me.role, id);
    if (!ok) {
      throw new BadRequestException('Нет доступа к данным этого сотрудника');
    }
    return this.users.fullProfile(id);
  }

  /**
   * Сотрудник сам загружает свой документ (паспорт, фото, диплом).
   * type — UserDocumentType. По ТЗ при добавлении сотрудника он сам
   * должен заполнять портал.
   */
  @Post('documents')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: userDocStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
    }),
  )
  uploadMyDocument(
    @CurrentUser() me: any,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { type?: string; comment?: string },
  ) {
    if (!file) throw new BadRequestException('Файл не загружен');
    return this.users.addDocument(me.id, {
      type: body.type || 'OTHER',
      url: `/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
      comment: body.comment,
    });
  }

  @Delete('documents/:docId')
  deleteMyDocument(@CurrentUser() me: any, @Param('docId') docId: string) {
    return this.users.deleteDocument(me.id, docId);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.ACCOUNTANT)
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

  /** Полный профиль сотрудника (HR + зарплата + KPI + посещаемость + штрафы). */
  @Get(':id/full')
  fullProfile(@Param('id') id: string) {
    return this.users.fullProfile(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() me: any) {
    // QA-fix #44 (часть 2): админ не может понизить себя — иначе после понижения
    // он не сможет вернуть себе ADMIN, и система останется без админа.
    if (id === me.id && dto.role && dto.role !== 'ADMIN') {
      throw new BadRequestException('Нельзя понизить собственную роль');
    }
    return this.users.update(id, dto, me);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    // QA-fix #44: админ не может удалить сам себя — это ломает систему.
    if (id === me.id) {
      throw new BadRequestException('Нельзя удалить собственный аккаунт');
    }
    return this.users.remove(id, me);
  }

  /** Загрузить документ сотрудника (паспорт/контракт/диплом). */
  @Post(':id/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: userDocStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '209715200', 10) },
    }),
  )
  uploadDocument(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { type?: string; comment?: string },
  ) {
    if (!file) throw new BadRequestException('Файл не загружен');
    return this.users.addDocument(id, {
      type: body.type || 'OTHER',
      url: `/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
      comment: body.comment,
    });
  }

  @Delete(':id/documents/:docId')
  deleteDocument(@Param('id') id: string, @Param('docId') docId: string) {
    return this.users.deleteDocument(id, docId);
  }

  /** Список тех, кому выдан доступ к данным этого сотрудника. */
  @Get(':id/access')
  listAccess(@Param('id') id: string) {
    return this.users.listGrantsForTarget(id);
  }

  /** Выдать доступ к данным сотрудника :id пользователю grantedToId. */
  @Post(':id/access')
  grantAccess(
    @Param('id') id: string,
    @Body() body: { grantedToId: string },
    @CurrentUser() me: any,
  ) {
    if (!body.grantedToId) throw new BadRequestException('grantedToId обязателен');
    return this.users.grantAccess(body.grantedToId, id, me.id);
  }

  @Delete(':id/access/:granteeId')
  revokeAccess(@Param('id') id: string, @Param('granteeId') granteeId: string) {
    return this.users.revokeAccess(granteeId, id);
  }

  /**
   * FOUNDER-only: задать список ролей сотрудника.
   * roles — массив значений Role. Например ['ADMIN','ACCOUNTANT'].
   * Только основатель раздаёт роли — гарантия в RolesGuard ниже.
   */
  @Put(':id/roles')
  @Roles(Role.FOUNDER)
  setRoles(
    @Param('id') id: string,
    @Body() body: { roles: Role[] },
    @CurrentUser() me: any,
  ) {
    if (!Array.isArray(body.roles)) {
      throw new BadRequestException('roles должно быть массивом');
    }
    return this.users.setRoles(id, body.roles, me.id);
  }
}
