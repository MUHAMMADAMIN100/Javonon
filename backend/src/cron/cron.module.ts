import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PenaltiesModule } from '../penalties/penalties.module';
import { SmsModule } from '../sms/sms.module';
import { PartnersModule } from '../partners/partners.module';

@Module({
  // PartnersModule экспортирует CommissionOutboxService — им cron добирает
  // партнёрские комиссии, которые не успел начислить approvePayment (см.
  // CronService.drainCommissionOutbox). Циклической зависимости нет:
  // PartnersModule ничего из cron/ не импортирует.
  imports: [PrismaModule, NotificationsModule, PenaltiesModule, SmsModule, PartnersModule],
  providers: [CronService],
})
export class CronModule {}
