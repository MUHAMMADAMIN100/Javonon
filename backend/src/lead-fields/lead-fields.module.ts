import { Global, Module } from '@nestjs/common';
import { LeadFieldsService } from './lead-fields.service';
import { LeadFieldsController } from './lead-fields.controller';

/** Глобальный: значения своих полей проверяют лиды, студенты и сделки. */
@Global()
@Module({
  providers: [LeadFieldsService],
  controllers: [LeadFieldsController],
  exports: [LeadFieldsService],
})
export class LeadFieldsModule {}
