import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SmsModule } from '../../sms/sms.module';
import { SmsIntegrationController } from './sms-integration.controller';

@Module({
  imports: [PrismaModule, SmsModule],
  controllers: [SmsIntegrationController],
})
export class SmsIntegrationModule {}
