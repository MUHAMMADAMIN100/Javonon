import { IsDateString, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

// QA-fix #24: запрещаем HTML/script-теги в свободных текстовых полях.
const NO_HTML_RE = /^[^<>]*$/;

export class CreateTaskDto {
  @IsString()
  @MinLength(3, { message: 'Минимум 3 символа' })
  @MaxLength(200)
  @Matches(NO_HTML_RE, { message: 'Заголовок содержит недопустимые символы' })
  title: string;

  @IsString()
  @MinLength(3, { message: 'Минимум 3 символа' })
  @MaxLength(2000)
  @Matches(NO_HTML_RE, { message: 'Описание содержит недопустимые символы' })
  description: string;

  @IsUUID('4', { message: 'assignedToId должен быть валидным UUID' })
  assignedToId: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;
}
