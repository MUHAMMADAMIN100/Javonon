import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { BotFunnelService } from './bot-funnel.service';
import { PrismaService } from '../prisma/prisma.service';
import { PartnersModule } from '../partners/partners.module';

@Module({
  imports: [PartnersModule],
  providers: [TelegramService, BotFunnelService, PrismaService],
  exports: [TelegramService],
})
export class TelegramModule {}
