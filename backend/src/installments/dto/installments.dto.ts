import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * ВНИМАНИЕ: глобальный ValidationPipe в main.ts стоит с `whitelist: true`.
 * Любое поле без class-validator декоратора МОЛЧА вырезается из body ещё до
 * входа в контроллер — поэтому здесь декорирован каждый атрибут, включая
 * необязательные.
 */

/** Один этап шаблона рассрочки программы. */
export class InstallmentTemplateStageDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  /** Доля этапа от суммы контракта, 0 < percent <= 100. */
  @IsNumber()
  @Min(0.01)
  @Max(100)
  percent: number;

  /** Сдвиг срока от старта сделки в календарных днях (0 = в день заключения). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  offsetDays?: number;
}

/** Полная перезапись шаблона программы (PUT-семантика). */
export class SaveInstallmentTemplateDto {
  /** Пустой массив = «у программы нет рассрочки», этапы сделок не создаются. */
  @IsArray()
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => InstallmentTemplateStageDto)
  stages: InstallmentTemplateStageDto[];
}

/** Ручная правка уже материализованного этапа сделки. */
export class UpdatePaymentStageDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000_000)
  amount?: number;

  /** `YYYY-MM-DD` либо полная ISO-строка. Парсится как душанбинская дата. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  dueDate?: string;
}
