import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PartnerAuthController } from './partner-auth.controller';
import { PartnerAuthService } from './partner-auth.service';
import {
  AdminPartnersController,
  PartnersController,
} from './partners.controller';
import { PartnersService } from './partners.service';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';
import { CommissionOutboxService } from './commission-outbox.service';
import { PartnerJwtGuard } from './partner-jwt.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Партнёрский токен подписывается отдельным секретом если задан.
        secret:
          config.get<string>('PARTNER_JWT_SECRET') ||
          config.get<string>('JWT_SECRET'),
        // Отдельная ручка для партнёров — не читаем общий JWT_EXPIRES_IN
        // (см. student-auth.module.ts). Должно совпадать с partner-auth.service.ts.
        signOptions: { expiresIn: config.get<string>('PARTNER_JWT_EXPIRES_IN') || '30d' },
      }),
    }),
  ],
  controllers: [
    PartnerAuthController,
    PartnersController,
    AdminPartnersController,
    ReferralsController,
  ],
  providers: [
    PrismaService,
    PartnerAuthService,
    PartnersService,
    ReferralsService,
    CommissionOutboxService,
    PartnerJwtGuard,
  ],
  // CommissionOutboxService экспортируется двум потребителям: submissions
  // (пишет строку в транзакции одобрения и сам же её закрывает) и cron
  // (добирает то, что быстрый путь потерял на рестарте).
  exports: [ReferralsService, CommissionOutboxService],
})
export class PartnersModule {}
