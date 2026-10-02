import { Module } from '@nestjs/common';
import { ExcusesController } from './excuses.controller';
import { ExcusesService } from './excuses.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PenaltiesModule } from '../penalties/penalties.module';

@Module({
  imports: [PrismaModule, RealtimeModule, PenaltiesModule],
  controllers: [ExcusesController],
  providers: [ExcusesService],
})
export class ExcusesModule {}
