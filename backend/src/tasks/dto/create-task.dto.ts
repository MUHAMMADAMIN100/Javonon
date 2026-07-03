import {
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

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

  // Мульти-исполнители (ТЗ §Tasks): минимум один. Легаси-поле
  // assignedToId в БД мы всё равно проставим = assigneeIds[0] для
  // совместимости со старыми запросами (см. TasksService.create).
  @IsArray({ message: 'assigneeIds должен быть массивом' })
  @ArrayNotEmpty({ message: 'Нужен хотя бы один исполнитель' })
  @ArrayMinSize(1, { message: 'Нужен хотя бы один исполнитель' })
  @ArrayUnique({ message: 'Исполнители не должны повторяться' })
  @IsUUID('4', { each: true, message: 'assigneeIds: невалидный UUID' })
  assigneeIds: string[];

  // Контролёр (наблюдатель) — опционально. null допустим (снять контролёра).
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4', { message: 'controllerId должен быть валидным UUID' })
  controllerId?: string | null;

  @IsOptional()
  @IsDateString()
  deadline?: string;
}
