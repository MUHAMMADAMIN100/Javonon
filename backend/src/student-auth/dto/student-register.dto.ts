import { IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { Direction } from '@prisma/client';

const NO_HTML_RE = /^[^<>]*$/;
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

/**
 * Self-регистрация студента через лендинг. Раньше эндпоинт принимал
 * `body: any` — можно было зарегистрироваться с email="foo",
 * password="1", fullName="<script>alert(1)</script>", direction =
 * любой строкой. Stored XSS + weak passwords + мусорные direction
 * значения попадали в БД.
 */
export class StudentRegisterDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'ФИО содержит недопустимые символы' })
  fullName!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(120)
  email!: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'Телефон должен содержать только цифры' })
  @MaxLength(40)
  phone?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(8, { message: 'Пароль: минимум 8 символов' })
  @MaxLength(128)
  password!: string;

  @IsEnum(Direction, { message: 'Некорректное направление' })
  direction!: Direction;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(NO_HTML_RE, { message: 'Комментарий содержит недопустимые символы' })
  comment?: string;

  // Реферальный код партнёра (опциональный).
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ref?: string;
}
