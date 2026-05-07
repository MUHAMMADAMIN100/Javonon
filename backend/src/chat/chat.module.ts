import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiModule } from '../ai/ai.module';
import { FinanceModule } from '../finance/finance.module';

@Module({
  imports: [PrismaModule, RealtimeModule, NotificationsModule, AiModule, FinanceModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
