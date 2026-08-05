import { Module } from '@nestjs/common';
import { StudentsService } from './students.service';
import { StudentsController } from './students.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnersModule } from '../partners/partners.module';

@Module({
  // PartnersModule экспортирует ReferralsService — им findOne отдаёт блок
  // «Партнёр» руководству. Циклической зависимости нет: PartnersModule
  // ничего из students/ не импортирует.
  imports: [NotificationsModule, PartnersModule],
  providers: [StudentsService],
  controllers: [StudentsController],
})
export class StudentsModule {}
