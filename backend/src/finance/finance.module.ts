import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ActivityModule } from '../activity/activity.module';

@Module({
  // NotificationsModule нужен FinanceController для алерта админам:
  // если один recordedById создаёт больше N INCOME строк за короткое окно
  // (в дополнение к per-user @Throttle на POST /transactions —
  // per-user бакет обеспечивает common/user-throttler.guard.ts).
  //
  // RealtimeModule нужен FinanceService, чтобы после каждого write
  // (create/update/remove) слать `transaction:*` в staff-комнату.
  // Без этого /finance у другого пользователя (FOUNDER + ACCOUNTANT
  // в month-close) остаётся stale до ручного refetch: `submission:*`
  // и `payment:*` покрывают только свои страницы, Finance UI им не
  // слушает. Модуль @Global, но импортируем явно — граф зависимостей
  // так читается без сюрпризов.
  //
  // ActivityModule — для аудита транзакций
  // (FINANCE_CREATE / FINANCE_UPDATE / FINANCE_DELETE /
  // TRANSACTION_MANAGER_CHANGE). Формально @Global, поэтому импорт не
  // обязателен — оставляем явно, чтобы зависимость читалась в графе
  // модулей и unit-тесты FinanceModule резолвили ActivityService без
  // полной загрузки AppModule. Без этой записи FOUNDER не мог ответить
  // «кто создал/поменял/удалил транзакцию X, когда» — только грепом
  // по логам контейнера. См. finance.service.ts create/update/remove.
  imports: [PrismaModule, NotificationsModule, RealtimeModule, ActivityModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
