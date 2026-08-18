import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { InstallmentsService } from './installments.service';

/**
 * КАБИНЕТ СТУДЕНТА — рассрочка.
 *
 * Отдельный контроллер с отдельным гардом, как у остальных студенческих
 * поверхностей (student-lms, student-payments): StudentJwtGuard принимает
 * только токены с role === 'STUDENT' и кладёт в req.user.id идентификатор
 * СТУДЕНТА. Поэтому здесь нет и не должно быть параметра «чьи этапы» — id
 * берётся исключительно из токена.
 *
 * Штабные эндпоинты рассрочки живут не здесь: этапы сделки висят на
 * SubmissionsController (`/submissions/:id/stages`), а шаблон программы — на
 * ProgramsController (`/programs/:id/installment-template`). Так они наследуют
 * уже существующие permission-префиксы `/submissions` и `/programs` из
 * PERMISSION_CATALOG, и кастомным ролям не нужен новый ключ.
 */
@Controller('student-installments')
@UseGuards(StudentJwtGuard)
export class StudentInstallmentsController {
  constructor(private svc: InstallmentsService) {}

  /** Свои планы рассрочки и остаток к оплате. */
  @Get('mine')
  mine(@CurrentUser() user: any) {
    return this.svc.listForStudent(user.id);
  }
}
