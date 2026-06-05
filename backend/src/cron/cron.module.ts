import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PenaltiesModule } from '../penalties/penalties.module';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [PrismaModule, NotificationsModule, PenaltiesModule, SmsModule],
  providers: [CronService],
})
export class CronModule {}
