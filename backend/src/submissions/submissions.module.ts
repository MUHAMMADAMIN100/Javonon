import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PartnersModule } from '../partners/partners.module';
import { SubmissionsService } from './submissions.service';
import { SubmissionsController } from './submissions.controller';

@Module({
  // PartnersModule экспортирует ReferralsService — им approvePayment
  // начисляет партнёрскую комиссию, а getOne отдаёт блок «Партнёр».
  // Так же подключён в payments.module.ts. Циклической зависимости нет:
  // PartnersModule ничего из submissions/ не импортирует, forwardRef не нужен.
  imports: [PrismaModule, RealtimeModule, PartnersModule],
  providers: [SubmissionsService],
  controllers: [SubmissionsController],
  exports: [SubmissionsService],
})
export class SubmissionsModule {}
