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
import { TaskStatus } from '@prisma/client';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { Permissions } from '../auth/permissions.decorator';

@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(private tasks: TasksService) {}

  @Permissions('tasks:read')
  @Get()
  list(
    @CurrentUser() user: any,
    @Query('mine') mine?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('controllerId') controllerId?: string,
  ) {
    if (search && search.length > 200) {
      throw new BadRequestException('Поисковая строка слишком длинная');
    }
    // Валидация status — enum TaskStatus, чтобы не пропустить мусор в prisma.
    let statusFilter: TaskStatus | undefined;
    if (status) {
      if (!Object.values(TaskStatus).includes(status as TaskStatus)) {
        throw new BadRequestException('Некорректный status');
      }
      statusFilter = status as TaskStatus;
    }
    return this.tasks.findAll({
      mine: mine === 'true',
      currentUserId: user.id,
      role: user.role,
      // Мульти-роли (ТЗ §2): roles[] нужен в service для elevated-check,
      // иначе secondary-ADMIN видел бы только свои задачи а не все.
      roles: user.roles,
      permissions: user.permissions,
      hasCustomRole: user.hasCustomRole,
      search,
      status: statusFilter,
      assigneeId: assigneeId || undefined,
      controllerId: controllerId || undefined,
    });
  }

  @Permissions('tasks:read')
  @Get('stats')
  stats(@CurrentUser() user: any) {
    return this.tasks.stats(user);
  }

  @Permissions('tasks:read')
  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tasks.findOneFor(id, user);
  }

  @Permissions('tasks:create')
  @Post()
  create(@Body() dto: CreateTaskDto, @CurrentUser() user: any) {
    return this.tasks.create(dto, user);
  }

  // Статус своей задачи меняет любой, у кого она есть; текст, срок и
  // исполнителей — по правам (сервис).
  @Permissions('tasks:read')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: any) {
    return this.tasks.update(id, dto, user);
  }

  @Permissions('tasks:delete')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tasks.remove(id, user);
  }
}
