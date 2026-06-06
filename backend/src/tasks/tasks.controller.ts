import {
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
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(private tasks: TasksService) {}

  @Get()
  list(
    @CurrentUser() user: any,
    @Query('mine') mine?: string,
    @Query('search') search?: string,
  ) {
    return this.tasks.findAll({
      mine: mine === 'true',
      currentUserId: user.id,
      role: user.role,
      // Мульти-роли (ТЗ §2): roles[] нужен в service для elevated-check,
      // иначе secondary-ADMIN видел бы только свои задачи а не все.
      roles: user.roles,
      search,
    } as any);
  }

  @Get('stats')
  stats(@CurrentUser() user: any) {
    return this.tasks.stats(user);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.tasks.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateTaskDto, @CurrentUser() user: any) {
    return this.tasks.create(dto, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: any) {
    return this.tasks.update(id, dto, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tasks.remove(id, user);
  }
}
