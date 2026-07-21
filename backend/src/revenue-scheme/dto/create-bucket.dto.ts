import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { RevenueBucketKind } from '@prisma/client';

// Не даём HTML в имя bucket (FOUNDER-editable, но всё-таки рендерим как
// текст — на всякий блокируем `<` / `>`).
const NO_HTML_RE = /^[^<>]*$/;
// Цвет как CSS hex #rgb / #rrggbb. Отдельные CSS-имена / rgba() не
// пропускаем — на фронте нужен предсказуемый hex для CSS-переменных
// диаграммы.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export class CreateBucketDto {
  @IsEnum(RevenueBucketKind, { message: 'kind должен быть PERCENTAGE или FIXED_SUM' })
  kind!: RevenueBucketKind;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Название обязательно' })
  @MaxLength(120, { message: 'Название максимум 120 символов' })
  @Matches(NO_HTML_RE, { message: 'Название содержит недопустимые символы' })
  name!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'Цвет должен быть в формате #rgb или #rrggbb' })
  color?: string;

  // 0..100. Требуется если kind=PERCENTAGE; для FIXED_SUM — должен
  // быть null/omit. Финальная проверка в сервисе (kind ↔ percent).
  @IsOptional()
  @IsInt({ message: 'percent должен быть целым числом' })
  @Min(0)
  @Max(100)
  percent?: number | null;

  @IsOptional()
  @IsInt({ message: 'order должен быть целым числом' })
  @Min(0)
  @Max(1000)
  order?: number;
}
