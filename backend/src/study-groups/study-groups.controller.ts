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
import { Role, StudyGroupStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { StudyGroupsService } from './study-groups.service';
import {
  AddGroupMembersDto,
  CreateClassSessionDto,
  CreateStudyGroupDto,
  UpdateClassSessionDto,
  UpdateStudyGroupDto,
} from './dto/study-groups.dto';

/**
 * CRM: группы и календарь занятий.
 *
 * @Roles здесь ШИРОКИЙ и это намеренно. Преподавателем группы может быть
 * любой сотрудник — отдельной роли TEACHER в enum Role нет, — поэтому
 * декоратор пускает весь штат, а настоящий рубеж стоит в сервисе:
 * руководство (FOUNDER/ADMIN) управляет всем, преподаватель — только своими
 * группами, остальные не видят ничего. Ровно тот же приём, что в
 * SubmissionsController: роль пускает к разделу, владение проверяет сервис.
 */
const STAFF_ROLES = [
  Role.FOUNDER,
  Role.ADMIN,
  Role.ACCOUNTANT,
  Role.SALES_MANAGER,
  Role.CLIENT_MANAGER,
] as const;

@Controller('study-groups')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...STAFF_ROLES)
export class StudyGroupsController {
  constructor(private svc: StudyGroupsService) {}

  // ВНИМАНИЕ: литеральные маршруты обязаны стоять ВЫШЕ параметрических,
  // иначе Nest разберёт 'sessions' как id группы.

  /** Лента занятий для календаря. Границы — `YYYY-MM-DD`, сутки душанбинские. */
  @Get('sessions')
  listSessions(
    @CurrentUser() me: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupId') groupId?: string,
    @Query('teacherId') teacherId?: string,
  ) {
    return this.svc.listSessions(me, { from, to, groupId, teacherId });
  }

  @Patch('sessions/:sessionId')
  updateSession(
    @CurrentUser() me: any,
    @Param('sessionId') sessionId: string,
    @Body() body: UpdateClassSessionDto,
  ) {
    return this.svc.updateSession(me, sessionId, body);
  }

  @Delete('sessions/:sessionId')
  removeSession(@CurrentUser() me: any, @Param('sessionId') sessionId: string) {
    return this.svc.removeSession(me, sessionId);
  }

  @Get()
  list(
    @CurrentUser() me: any,
    @Query('status') status?: string,
    @Query('teacherId') teacherId?: string,
    @Query('programId') programId?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.listGroups(me, {
      status:
        status === 'ACTIVE' || status === 'ARCHIVED'
          ? (status as StudyGroupStatus)
          : undefined,
      teacherId: teacherId || undefined,
      programId: programId || undefined,
      search: search ? search.slice(0, 200) : undefined,
    });
  }

  @Post()
  create(@CurrentUser() me: any, @Body() body: CreateStudyGroupDto) {
    return this.svc.createGroup(me, body);
  }

  @Get(':id')
  one(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.getGroup(me, id);
  }

  @Patch(':id')
  update(@CurrentUser() me: any, @Param('id') id: string, @Body() body: UpdateStudyGroupDto) {
    return this.svc.updateGroup(me, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.removeGroup(me, id);
  }

  @Post(':id/members')
  addMembers(
    @CurrentUser() me: any,
    @Param('id') id: string,
    @Body() body: AddGroupMembersDto,
  ) {
    return this.svc.addMembers(me, id, body);
  }

  @Delete(':id/members/:studentId')
  removeMember(
    @CurrentUser() me: any,
    @Param('id') id: string,
    @Param('studentId') studentId: string,
  ) {
    return this.svc.removeMember(me, id, studentId);
  }

  @Post(':id/sessions')
  createSession(
    @CurrentUser() me: any,
    @Param('id') id: string,
    @Body() body: CreateClassSessionDto,
  ) {
    return this.svc.createSession(me, id, body);
  }
}

/**
 * КАБИНЕТ СТУДЕНТА — расписание. Отдельный контроллер с отдельным гардом,
 * как student-lms / student-payments. StudentJwtGuard кладёт в req.user.id
 * идентификатор СТУДЕНТА, поэтому параметра «чьё расписание» здесь нет:
 * студент видит только занятия групп, в которых состоит.
 */
@Controller('student-schedule')
@UseGuards(StudentJwtGuard)
export class StudentScheduleController {
  constructor(private svc: StudyGroupsService) {}

  /** Ближайшие занятия — главный экран расписания в кабинете. */
  @Get('upcoming')
  upcoming(@CurrentUser() user: any, @Query('limit') limit?: string) {
    const parsed = limit ? parseInt(limit, 10) : undefined;
    return this.svc.listUpcomingForStudent(
      user.id,
      Number.isFinite(parsed as number) ? parsed : undefined,
    );
  }

  /** Занятия за период — для месячной сетки. */
  @Get('sessions')
  range(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.listRangeForStudent(user.id, from, to);
  }
}
