import { IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength, MaxLength } from 'class-validator';
import { Direction, ApplicationSource } from '@prisma/client';

// E.164: '+' необязателен, 7–15 цифр всего, разрешаем пробелы/дефисы при вводе.
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;
// QA-fix: имя без HTML-тегов (XSS) — fullName попадает в email-шаблоны и Telegram.
const NO_HTML_RE = /^[^<>]*$/;

export class CreateApplicationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'ФИО содержит недопустимые символы' })
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
  @Matches(NO_HTML_RE, { message: 'Комментарий содержит недопустимые символы' })
  comment?: string;

  @IsOptional()
  @IsString()
  programId?: string;

  @IsOptional()
  @IsEnum(ApplicationSource)
  source?: ApplicationSource;
}
