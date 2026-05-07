import { IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength, MaxLength } from 'class-validator';
import { Direction, ApplicationSource } from '@prisma/client';

// E.164: '+' необязателен, 7–15 цифр всего, разрешаем пробелы/дефисы при вводе.
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

export class CreateApplicationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @IsString()
  @MinLength(5)
  @MaxLength(40)
  @Matches(PHONE_RE, { message: 'phone должен содержать только цифры (с опциональным «+» и пробелами/дефисами)' })
  phone: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string;

  @IsEnum(Direction)
  direction: Direction;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;

  @IsOptional()
  @IsString()
  programId?: string;

  @IsOptional()
  @IsEnum(ApplicationSource)
  source?: ApplicationSource;
}
