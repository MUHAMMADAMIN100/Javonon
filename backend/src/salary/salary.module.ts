import { Module } from '@nestjs/common';
import { SalaryController } from './salary.controller';
import { SalaryService } from './salary.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TimeTrackingModule } from '../time-tracking/time-tracking.module';
import { PenaltiesModule } from '../penalties/penalties.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [PrismaModule, TimeTrackingModule, PenaltiesModule, SettingsModule],
  controllers: [SalaryController],
  providers: [SalaryService],
  exports: [SalaryService],
})
export class SalaryModule {}
