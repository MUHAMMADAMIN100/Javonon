import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { InteractionsService } from './interactions.service';
import { InteractionType } from '@prisma/client';

// Staff-side: список и CRUD
@Controller('interactions')
@UseGuards(JwtAuthGuard)
export class InteractionsController {
  constructor(private svc: InteractionsService) {}

  @Get()
  async list(@Query('studentId') studentId: string, @CurrentUser() me: any) {
    await this.svc.assertCanSeeStudent(studentId, me);
    return this.svc.listForStudent(studentId);
  }

  /** Полная история взаимодействий (Interaction + CallLog + ExternalMessage). */
  @Get('timeline')
  async timeline(@Query('studentId') studentId: string, @CurrentUser() me: any) {
    await this.svc.assertCanSeeStudent(studentId, me);
    return this.svc.fullTimeline(studentId);
  }

  @Post()
  async create(
    @CurrentUser() me: any,
    @Body() body: {
      studentId: string;
      type: InteractionType;
      summary: string;
      details?: string;
      visibleToStudent?: boolean;
      occurredAt?: string;
    },
  ) {
    await this.svc.assertCanSeeStudent(body?.studentId, me);
    return this.svc.create(me.id, body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @CurrentUser() me: any) {
    await this.svc.assertCanModify(id, me);
    return this.svc.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() me: any) {
    await this.svc.assertCanModify(id, me);
    return this.svc.remove(id);
  }
}

// Student-side: только видимые ему записи
@Controller('student-interactions')
@UseGuards(StudentJwtGuard)
export class StudentInteractionsController {
  constructor(private svc: InteractionsService) {}

  @Get()
  myList(@CurrentUser() user: any) {
    return this.svc.listForStudent(user.id, { visibleToStudentOnly: true });
  }
}
