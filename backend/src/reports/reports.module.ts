import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { DailyReportsModule } from '../daily-reports/daily-reports.module';

// /reports — адрес, которым пользуется CRM («Мои отчёты»). Вся логика и
// проверки — в DailyReportsService: раньше здесь жил второй сервис без
// единой проверки, и отчёт принимал «−5 звонков».
@Module({
  imports: [DailyReportsModule],
  controllers: [ReportsController],
})
export class ReportsModule {}
