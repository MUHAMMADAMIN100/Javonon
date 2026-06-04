import { IsArray, IsEmail, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ContactChannel, Direction, StudentStatus } from '@prisma/client';

const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;
// QA-fix: запрет HTML/script-тегов в текстовых полях (XSS protection).
const NO_HTML_RE = /^[^<>]*$/;

export class CreateStudentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'ФИО содержит недопустимые символы' })
  fullName: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(PHONE_RE, { each: true, message: 'каждый phone должен содержать только цифры' })
  phones?: string[];

  // Подписи к телефонам (синхронны по индексу с phones).
  // Например: ["сам", "Отец", "Мать"].
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  phoneLabels?: string[];

  @IsOptional()
  @IsEnum(ContactChannel)
  preferredChannel?: ContactChannel;

  @IsEmail()
  @MaxLength(120)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photoUrl?: string;

  @IsEnum(Direction)
  direction: Direction;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  cabinet?: number;

  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(NO_HTML_RE, { message: 'Комментарий содержит недопустимые символы' })
  comment?: string;
}
