import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule нужен FinanceController для алерта админам:
  // если один recordedById создаёт больше N INCOME строк за короткое окно
  // (в дополнение к per-user @Throttle на POST /transactions).
  imports: [PrismaModule, NotificationsModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
