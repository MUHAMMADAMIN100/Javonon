import { Module } from '@nestjs/common';
import { SalaryController } from './salary.controller';
import { SalaryService } from './salary.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TimeTrackingModule } from '../time-tracking/time-tracking.module';

@Module({
  imports: [PrismaModule, TimeTrackingModule],
  controllers: [SalaryController],
  providers: [SalaryService],
  exports: [SalaryService],
})
export class SalaryModule {}
