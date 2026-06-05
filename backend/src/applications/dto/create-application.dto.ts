import { IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength, MaxLength } from 'class-validator';
import { ContactChannel, Direction, ApplicationSource } from '@prisma/client';

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

  // Доп. номер (отец/мать/другое контактное лицо). По ТЗ §8.
  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'secondaryPhone должен содержать только цифры' })
  secondaryPhone?: string;

  // Подпись доп. контакта: «Отец», «Мать» и т.п.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  secondaryContactLabel?: string;

  // Предпочтительный канал связи (WhatsApp/Phone/Instagram/Telegram/Email).
  @IsOptional()
  @IsEnum(ContactChannel)
  preferredChannel?: ContactChannel;

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
