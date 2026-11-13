import { IsArray, IsEmail, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Direction, ContactChannel, StudentStatus } from '../../common/lookup-keys';
import { IsLookupKey } from '../../common/lookup-validators';

const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;
// QA-fix: запрет HTML/script-тегов в текстовых полях (XSS protection).
const NO_HTML_RE = /^[^<>]*$/;

export class CreateStudentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'ФИО: нельзя использовать знаки < и >' })
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
  @IsLookupKey('Выберите канал связи из списка')
  preferredChannel?: ContactChannel;

  // ISO дата рождения — для cron birthdayGreetings.
  @IsOptional()
  birthday?: string;

  @IsEmail()
  @MaxLength(120)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photoUrl?: string;

  @IsLookupKey('Выберите направление из списка')
  direction: Direction;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  cabinet?: number;

  @IsOptional()
  @IsLookupKey('Выберите статус студента из списка')
  status?: StudentStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(NO_HTML_RE, { message: 'Комментарий: нельзя использовать знаки < и >' })
  comment?: string;
}
