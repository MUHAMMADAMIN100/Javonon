import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ActivityModule } from '../activity/activity.module';
import { RevenueSchemeController } from './revenue-scheme.controller';
import { RevenueSchemeService } from './revenue-scheme.service';

/**
 * FOUNDER-editable схема распределения выручки. Читается FinanceService.
 * distribution(), редактируется через /admin/revenue-scheme/*.
 * Сеет дефолт на первом запуске (см. RevenueSchemeService.onModuleInit).
 *
 * ActivityModule формально @Global, поэтому импорт не обязателен —
 * оставляем явно, чтобы зависимость читалась в графе модулей и unit-тесты
 * RevenueSchemeModule резолвили ActivityService без полной загрузки
 * AppModule. Аудит-трейл: без ActivityLog reset() тихо сносил весь Фонд
 * оплаты труда с именованными зарплатами (см. коммент над
 * RevenueSchemeService.reset и audit HIGH).
 */
@Module({
  imports: [PrismaModule, ActivityModule],
  controllers: [RevenueSchemeController],
  providers: [RevenueSchemeService],
  exports: [RevenueSchemeService],
})
export class RevenueSchemeModule {}
