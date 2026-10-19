import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailModule } from '../mail/mail.module';
import { SettingsModule } from '../settings/settings.module';
import { TaskDiaryService } from './task-diary.service';

@Module({
  imports: [NotificationsModule, MailModule, SettingsModule],
  controllers: [TasksController],
  providers: [TasksService, TaskDiaryService, PrismaService],
})
export class TasksModule {}
