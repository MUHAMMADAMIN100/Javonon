import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { CurrentUser } from '../auth/current-user.decorator';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { contentDisposition } from '../common/upload-name';
import { AcademyService } from './academy.service';

/**
 * КАБИНЕТ СТУДЕНТА — вкладка «Академия». StudentJwtGuard кладёт в
 * req.user.id идентификатор СТУДЕНТА, поэтому параметра «чей кабинет» здесь
 * нет: студент видит только свои группы, уроки, ДЗ и отметки.
 */
@Controller('student-academy')
@UseGuards(StudentJwtGuard)
export class StudentAcademyController {
  constructor(private svc: AcademyService) {}

  @Get('overview')
  overview(@CurrentUser() me: any) {
    return this.svc.cabinetOverview(me.id);
  }

  @Get('lessons')
  lessons(@CurrentUser() me: any) {
    return this.svc.cabinetLessons(me.id);
  }

  @Get('homework')
  homework(@CurrentUser() me: any) {
    return this.svc.cabinetHomework(me.id);
  }

  @Get('progress')
  progress(@CurrentUser() me: any) {
    return this.svc.cabinetProgress(me.id);
  }

  /**
   * Файл урока. /uploads студентам закрыт (UploadsAuthMiddleware), поэтому
   * отдаём поток отсюда — после проверки, что ученик в группе урока.
   */
  @Get('materials/:id/download')
  async download(@CurrentUser() me: any, @Param('id') id: string, @Res() res: Response) {
    const file = await this.svc.cabinetMaterial(me.id, id);
    if (!existsSync(file.path)) throw new NotFoundException('Файл не найден');
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(file.title));
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(file.path);
  }
}
