import { Module } from '@nestjs/common';
import { TimeTrackingController } from './time-tracking.controller';
import { TimeTrackingService } from './time-tracking.service';
import { WorkShiftController } from './work-shift.controller';
import { WorkShiftService } from './work-shift.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, SettingsModule, RealtimeModule, NotificationsModule],
  // WorkShift — смена «как в Sabt» (13.11.2026): перерывы с причиной, «Приду позже»,
  // правки времени, отгулы, табель месяца и смены сегодня.
  controllers: [TimeTrackingController, WorkShiftController],
  providers: [TimeTrackingService, WorkShiftService],
  exports: [TimeTrackingService, WorkShiftService],
})
export class TimeTrackingModule {}
