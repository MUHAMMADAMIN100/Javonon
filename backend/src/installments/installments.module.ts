import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { InstallmentsService } from './installments.service';
import { StudentInstallmentsController } from './installments.controller';

/**
 * Рассрочка по сделкам. Сервис экспортируется, потому что его дёргают три
 * чужих модуля:
 *   - SubmissionsModule — материализация шаблона при создании сделки и
 *     погашение этапов внутри транзакции одобрения платежа;
 *   - ProgramsModule — чтение/запись шаблона в карточке программы;
 *   - CronModule — суточный проход по просрочке.
 * Обратных зависимостей нет, поэтому forwardRef не нужен.
 */
@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    // Локальный JwtModule нужен StudentJwtGuard'у — тот же приём, что в
    // payments.module.ts и lms.module.ts (см. комментарий про отдельный
    // STUDENT_JWT_SECRET в student-auth.module.ts).
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
  controllers: [StudentInstallmentsController],
  providers: [InstallmentsService, StudentJwtGuard],
  exports: [InstallmentsService],
})
export class InstallmentsModule {}
