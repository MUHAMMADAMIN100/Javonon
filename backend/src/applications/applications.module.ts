import { Module } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { ApplicationsController } from './applications.controller';
import { PhoneCleanupService } from './phone-cleanup.service';
import { Qa2DataFixService } from './qa2-data-fix.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MailModule } from '../mail/mail.module';
import { PartnersModule } from '../partners/partners.module';
import { SalesModule } from '../sales/sales.module';

@Module({
  imports: [NotificationsModule, TelegramModule, MailModule, PartnersModule, SalesModule],
  providers: [ApplicationsService, PhoneCleanupService, Qa2DataFixService],
  controllers: [ApplicationsController],
})
export class ApplicationsModule {}
