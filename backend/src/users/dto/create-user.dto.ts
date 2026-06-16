import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { Role } from '@prisma/client';

// QA-fix #42: запрещаем HTML/script-теги в имени.
const NO_HTML_RE = /^[^<>]*$/;

export class CreateUserDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(120)
  email: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'ФИО содержит недопустимые символы' })
  fullName: string;

  // trim перед хешированием — иначе пробелы зашьются в хэш и login по
  // тримленному паролю будет фейлиться.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @IsEnum(Role)
  role: Role;

  // ТЗ-доработка: при создании сотрудника FOUNDER может сразу
  // назначить ему кастомную роль (например «Таргетолог»). null/undefined =
  // только базовая роль. UUID-проверка отсекает мусор; саму существенность
  // и isActive проверяет service.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  customRoleId?: string | null;
}
