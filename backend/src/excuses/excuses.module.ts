import { Module } from '@nestjs/common';
import { ExcusesController } from './excuses.controller';
import { ExcusesService } from './excuses.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ExcusesController],
  providers: [ExcusesService],
})
export class ExcusesModule {}
