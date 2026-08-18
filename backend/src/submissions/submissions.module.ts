import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PartnersModule } from '../partners/partners.module';
import { InstallmentsModule } from '../installments/installments.module';
import { SubmissionsService } from './submissions.service';
import { SubmissionsController } from './submissions.controller';

@Module({
  // PartnersModule экспортирует ReferralsService — им approvePayment
  // начисляет партнёрскую комиссию, а getOne отдаёт блок «Партнёр».
  // Так же подключён в payments.module.ts. Циклической зависимости нет:
  // PartnersModule ничего из submissions/ не импортирует, forwardRef не нужен.
  //
  // InstallmentsModule экспортирует InstallmentsService: им create()
  // материализует шаблон рассрочки программы в этапы сделки, а
  // approvePayment() гасит этапы ВНУТРИ своей транзакции. Цикла нет —
  // installments/ ничего из submissions/ не импортирует.
  imports: [PrismaModule, RealtimeModule, PartnersModule, InstallmentsModule],
  providers: [SubmissionsService],
  controllers: [SubmissionsController],
  exports: [SubmissionsService],
})
export class SubmissionsModule {}
