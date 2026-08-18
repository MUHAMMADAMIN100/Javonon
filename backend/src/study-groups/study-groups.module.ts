import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { StudyGroupsService } from './study-groups.service';
import {
  StudentScheduleController,
  StudyGroupsController,
} from './study-groups.controller';

/**
 * Учебные группы и расписание занятий. Сервис экспортируется ради CronModule
 * — напоминание перед занятием живёт в sweepSessionReminders(), а cron лишь
 * задаёт расписание запуска (тот же приём, что с PenaltiesService).
 * Обратной зависимости нет, forwardRef не нужен.
 */
@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    // Локальный JwtModule для StudentJwtGuard — см. payments.module.ts.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('STUDENT_JWT_SECRET') || config.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get<string>('STUDENT_JWT_EXPIRES_IN') || '7d',
        },
      }),
    }),
  ],
  controllers: [StudyGroupsController, StudentScheduleController],
  providers: [StudyGroupsService, StudentJwtGuard],
  exports: [StudyGroupsService],
})
export class StudyGroupsModule {}
