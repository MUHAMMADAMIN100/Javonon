import { Module } from '@nestjs/common';
import { ExcusesController } from './excuses.controller';
import { ExcusesService } from './excuses.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [PrismaModule, RealtimeModule],
  controllers: [ExcusesController],
  providers: [ExcusesService],
})
export class ExcusesModule {}
