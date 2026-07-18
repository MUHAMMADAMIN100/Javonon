import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StudentAuthController } from './student-auth.controller';
import { StudentAuthService } from './student-auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailModule } from '../mail/mail.module';
import { PartnersModule } from '../partners/partners.module';

@Module({
  imports: [
    PassportModule,
    MailModule,
    PartnersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Студенческий токен подписывается отдельным секретом (если задан),
        // чтобы студент не мог подделать payload с role: ADMIN. При verify
        // в guard и realtime gateway оба секрета пробуются по очереди (fallback),
        // чтобы старые сессии продолжали работать до своего expiration.
        secret:
          config.get<string>('STUDENT_JWT_SECRET') ||
          config.get<string>('JWT_SECRET'),
        // Раньше здесь читался общий JWT_EXPIRES_IN — та же ручка, что и
        // у сотрудников CRM и партнёров. Прод пинил её в 7d, из-за чего
        // код-дефолт 30d для staff/partner не срабатывал. Теперь у каждой
        // аудитории свой env; для студентов дефолт остаётся 7d.
        signOptions: { expiresIn: config.get<string>('STUDENT_JWT_EXPIRES_IN') || '7d' },
      }),
    }),
  ],
  controllers: [StudentAuthController],
  providers: [StudentAuthService, PrismaService],
})
export class StudentAuthModule {}
