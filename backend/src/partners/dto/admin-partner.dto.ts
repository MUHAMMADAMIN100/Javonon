import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Не даём протащить угловые скобки в fullName — защищаемся от stored XSS
// в админ-дашборде, куда попадёт этот partner.fullName.
const NO_HTML_RE = /^[^<>]*$/;
// Телефон 5..20 символов; допускаем + / пробелы / скобки / дефис.
const PHONE_RE = /^\+?[\d\s\-()]{5,20}$/;

/**
 * FOUNDER-side создание партнёра. Отличия от PartnerRegisterDto:
 * - password опциональный (backend сгенерирует и вернёт plainPassword ONCE);
 * - commissionPct опциональный (0..100), дефолт 30 применяется в сервисе;
 * - phone 5..20 (по контракту), не 7..20.
 */
export class AdminPartnerCreateDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Некорректный email' })
  @MaxLength(120)
  email!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2, { message: 'ФИО минимум 2 символа' })
  @MaxLength(100, { message: 'ФИО максимум 100 символов' })
  @Matches(NO_HTML_RE, { message: 'ФИО содержит недопустимые символы' })
  fullName!: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(PHONE_RE, { message: 'Телефон должен быть 5–20 символов' })
  @MaxLength(20)
  phone?: string;

  // Опциональный пароль — если не задан, backend авто-генерирует 12-char
  // и возвращает plainPassword ОДИН РАЗ в ответе.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(8, { message: 'Пароль минимум 8 символов' })
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsInt({ message: 'commissionPct должен быть целым числом' })
  @Min(0)
  @Max(100)
  commissionPct?: number;
}
