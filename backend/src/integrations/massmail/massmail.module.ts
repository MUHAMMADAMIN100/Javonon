import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { TelegramModule } from '../../telegram/telegram.module';
import { MailModule } from '../../mail/mail.module';
import { SmsModule } from '../../sms/sms.module';
import { MassmailService } from './massmail.service';
import { MassmailController } from './massmail.controller';

@Module({
  imports: [PrismaModule, WhatsappModule, TelegramModule, MailModule, SmsModule],
  providers: [MassmailService],
  controllers: [MassmailController],
  exports: [MassmailService],
})
export class MassmailModule {}
