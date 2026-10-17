import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { AcademyService } from './academy.service';
import { AcademyController, StudentAcademySummaryController } from './academy.controller';
import { StudentAcademyController } from './student-academy.controller';

/**
 * Академия: журнал, материалы уроков, ученики, красные флаги и вкладка
 * «Академия» в кабинете студента. Группы и расписание живут рядом, в
 * StudyGroupsModule; общие правила доступа — academy/academy-access.ts.
 */
@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    // Локальный JwtModule для StudentJwtGuard — см. study-groups.module.ts.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('STUDENT_JWT_SECRET') || config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('STUDENT_JWT_EXPIRES_IN') || '7d' },
      }),
    }),
  ],
  controllers: [AcademyController, StudentAcademySummaryController, StudentAcademyController],
  providers: [AcademyService, StudentJwtGuard],
  exports: [AcademyService],
})
export class AcademyModule {}
