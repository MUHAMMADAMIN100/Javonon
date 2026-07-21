import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const NO_HTML_RE = /^[^<>]*$/;

/**
 * Позиция bucket'а: для FIXED_SUM — конкретная строка «Alijon 1 000 000»;
 * для PERCENTAGE — сублейбл вроде «Таргет» (amountCents null).
 * kind-специфичная проверка (FIXED_SUM требует amountCents > 0; PERCENTAGE
 * — amountCents должен быть null) в сервисе.
 */
export class CreateItemDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Название обязательно' })
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'Название содержит недопустимые символы' })
  name!: string;

  // Копейки-целые (не Float — избегаем IEEE-754 в бухгалтерии, как в
  // Transaction.amount фронт-конвертация).
  @IsOptional()
  @IsInt({ message: 'amountCents должен быть целым числом' })
  @Min(0)
  @Max(2_000_000_000)
  amountCents?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  order?: number;

  @IsOptional()
  @IsUUID('4', { message: 'userId должен быть UUID' })
  userId?: string | null;
}
