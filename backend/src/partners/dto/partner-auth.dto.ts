import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const NO_HTML_RE = /^[^<>]*$/;
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

/**
 * Регистрация партнёра. Раньше POST /partner-auth/register принимал
 * сырой body без валидации — можно было зарегистрироваться с
 * email="foo", password="1", fullName="<script>...</script>". Stored
 * XSS + weak пароли + мусор в БД.
 */
export class PartnerRegisterDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(120)
  email!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(8, { message: 'Пароль: минимум 8 символов' })
  @MaxLength(128)
  password!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'ФИО содержит недопустимые символы' })
  fullName!: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'Телефон должен содержать только цифры' })
  @MaxLength(40)
  phone?: string;
}

export class PartnerLoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(120)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
