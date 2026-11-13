import { Global, Module } from '@nestjs/common';
import { LookupsService } from './lookups.service';
import { LookupsController } from './lookups.controller';

/** Глобальный: значения справочников проверяют лиды, студенты, программы, сайт. */
@Global()
@Module({
  providers: [LookupsService],
  controllers: [LookupsController],
  exports: [LookupsService],
})
export class LookupsModule {}
