import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const NO_HTML_RE = /^[^<>]*$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * PATCH bucket. Kind менять НЕЛЬЗЯ — иначе items с amountCents станут
 * лейблами PERCENTAGE (или наоборот). Если FOUNDER хочет сменить тип —
 * DELETE + POST заново.
 */
export class UpdateBucketDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'Название содержит недопустимые символы' })
  name?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'Цвет должен быть в формате #rgb или #rrggbb' })
  color?: string;

  // Для PERCENTAGE — 0..100. Для FIXED_SUM попытка задать percent — 400.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  percent?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  order?: number;
}
