import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Direction } from '@prisma/client';

// ТЗ-доработка: обязательные только name + university. Остальное опц.
// (программа может быть бесплатной, без фиксированного города и т.д.).
const HTTP_URL = /^(https?:\/\/)\S{0,2000}$|^$/i;

export class CreateProgramDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  university: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  major?: string;

  @IsOptional()
  @IsEnum(Direction)
  direction?: Direction;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10_000_000)
  cost?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  duration?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(HTTP_URL, { message: 'universityWebsiteUrl должен быть http(s) ссылкой' })
  universityWebsiteUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  disciplines?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsBoolean()
  published?: boolean;

  // === Расширенные поля каталога ===
  @IsOptional()
  @IsString()
  @MaxLength(120)
  englishLevel?: string;

  @IsOptional()
  @IsBoolean()
  hasGrant?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  grantDetails?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  grantEnglishLevel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  avgAdmissionScore?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  applicationDeadline?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(12)
  intakesPerYear?: number;
}
