import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const NO_HTML_RE = /^[^<>]*$/;

/**
 * PATCH item. bucketId менять НЕ даём (item жёстко привязан к своему
 * bucket'у — иначе PERCENTAGE-лейбл окажется под FIXED_SUM без
 * amountCents и ломает allocated).
 */
export class UpdateItemDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'Название содержит недопустимые символы' })
  name?: string;

  @IsOptional()
  @IsInt()
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
