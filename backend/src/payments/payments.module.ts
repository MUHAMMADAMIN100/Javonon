import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentsController, StudentPaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { PartnersModule } from '../partners/partners.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    PartnersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('STUDENT_JWT_SECRET') || config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') || '7d' },
      }),
    }),
  ],
  controllers: [PaymentsController, StudentPaymentsController],
  providers: [PaymentsService, StudentJwtGuard],
})
export class PaymentsModule {}
