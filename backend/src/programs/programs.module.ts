import { Module } from '@nestjs/common';
import { ProgramsController } from './programs.controller';
import { ProgramsService } from './programs.service';
import { TelegramModule } from '../telegram/telegram.module';
import { InstallmentsModule } from '../installments/installments.module';

@Module({
  // InstallmentsModule — шаблон рассрочки редактируется в карточке
  // программы (GET/PUT /programs/:id/installment-template). Цикла нет:
  // installments/ ничего из programs/ не импортирует.
  imports: [TelegramModule, InstallmentsModule],
  controllers: [ProgramsController],
  providers: [ProgramsService],
})
export class ProgramsModule {}
