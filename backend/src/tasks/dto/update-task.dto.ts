import {
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { TaskStatus } from '@prisma/client';

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  // Мульти-исполнители: если передан — синхронизирует M2M через set.
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Нужен хотя бы один исполнитель' })
  @ArrayMinSize(1, { message: 'Нужен хотя бы один исполнитель' })
  @ArrayUnique({ message: 'Исполнители не должны повторяться' })
  @IsUUID('4', { each: true, message: 'assigneeIds: невалидный UUID' })
  assigneeIds?: string[];

  // Контролёр: null = снять, uuid = назначить.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4', { message: 'controllerId должен быть валидным UUID' })
  controllerId?: string | null;

  @IsOptional()
  @IsDateString()
  deadline?: string | null;
}
