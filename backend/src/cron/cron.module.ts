import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PenaltiesModule } from '../penalties/penalties.module';
import { SmsModule } from '../sms/sms.module';
import { PartnersModule } from '../partners/partners.module';
import { InstallmentsModule } from '../installments/installments.module';
import { StudyGroupsModule } from '../study-groups/study-groups.module';

@Module({
  // PartnersModule экспортирует CommissionOutboxService — им cron добирает
  // партнёрские комиссии, которые не успел начислить approvePayment (см.
  // CronService.drainCommissionOutbox). Циклической зависимости нет:
  // PartnersModule ничего из cron/ не импортирует.
  // InstallmentsModule / StudyGroupsModule — по тому же принципу, что и
  // PenaltiesService: логика прохода живёт в своём домене, cron задаёт лишь
  // расписание запуска. Циклической зависимости нет — ни один из них ничего
  // из cron/ не импортирует.
  imports: [
    PrismaModule,
    NotificationsModule,
    PenaltiesModule,
    SmsModule,
    PartnersModule,
    InstallmentsModule,
    StudyGroupsModule,
  ],
  providers: [CronService],
})
export class CronModule {}
