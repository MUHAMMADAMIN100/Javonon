import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { TelephonyService } from './telephony.service';
import { TelephonyController } from './telephony.controller';

@Module({
  imports: [PrismaModule],
  providers: [TelephonyService],
  controllers: [TelephonyController],
  exports: [TelephonyService],
})
export class TelephonyModule {}
