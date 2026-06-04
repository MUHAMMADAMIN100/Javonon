import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { LmsService } from './lms.service';

// Admin/staff side
@Controller('lms')
export class LmsController {
  constructor(private svc: LmsService) {}

  @Get('courses')
  @UseGuards(JwtAuthGuard)
  list() {
    return this.svc.listCourses();
  }

  @Get('courses/:id')
  @UseGuards(JwtAuthGuard)
  one(@Param('id') id: string) {
    return this.svc.getCourse(id);
  }

  @Post('courses')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  create(@CurrentUser() me: any, @Body() body: any) {
    return this.svc.createCourse(me.id, body);
  }

  @Patch('courses/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  update(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateCourse(id, body);
  }

  @Delete('courses/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  remove(@Param('id') id: string) {
    return this.svc.deleteCourse(id);
  }

  @Post('courses/:id/lessons')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  addLesson(@Param('id') courseId: string, @Body() body: any) {
    return this.svc.createLesson(courseId, body);
  }

  @Patch('lessons/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  updateLesson(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateLesson(id, body);
  }

  @Delete('lessons/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  removeLesson(@Param('id') id: string) {
    return this.svc.deleteLesson(id);
  }

  @Post('courses/:id/enroll')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  enrollStudent(@Param('id') courseId: string, @Body() body: { studentId: string }) {
    return this.svc.enroll(body.studentId, courseId, true);
  }
}

// Student side — отдельный контроллер с другим guard'ом
@Controller('student-lms')
@UseGuards(StudentJwtGuard)
export class StudentLmsController {
  constructor(private svc: LmsService) {}

  @Get('my-courses')
  myCourses(@CurrentUser() user: any) {
    return this.svc.studentCourses(user.id);
  }

  @Get('available')
  available(@CurrentUser() user: any) {
    return this.svc.availableCoursesForStudent(user.id);
  }

  @Get('courses/:id')
  course(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.getCourseForStudent(id, user.id);
  }

  @Post('courses/:id/enroll')
  selfEnroll(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.enroll(user.id, id);
  }

  @Post('lessons/:id/complete')
  completeLesson(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.markLessonComplete(id, user.id);
  }
}
