import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ClassSessionStatus, StudyGroupStatus } from '@prisma/client';

/**
 * ВНИМАНИЕ: глобальный ValidationPipe стоит с `whitelist: true` — поле без
 * декоратора молча вырезается из body. Декорируем всё, включая опциональное.
 */

export class CreateStudyGroupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsUUID()
  programId?: string;

  /** Преподаватель — обычный сотрудник (отдельной роли TEACHER в схеме нет). */
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /**
   * Стартовый состав. Индивидуальное занятие — это группа из ОДНОГО студента;
   * отдельной «персональной» ветки в системе нет и заводить её нельзя.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  studentIds?: string[];
}

export class UpdateStudyGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  /** Пустая строка = отвязать программу (в схеме programId nullable). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  programId?: string;

  /** Пустая строка = снять преподавателя. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  teacherId?: string;

  @IsOptional()
  @IsEnum(StudyGroupStatus)
  status?: StudyGroupStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class AddGroupMembersDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  studentIds: string[];
}

export class CreateClassSessionDto {
  /** ISO-строка или `YYYY-MM-DDTHH:mm`. Наивное время трактуется как душанбинское. */
  @IsString()
  @MaxLength(40)
  startsAt: string;

  @IsString()
  @MaxLength(40)
  endsAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  topic?: string;

  /** Замена штатного преподавателя на это занятие. Пустая строка = снять. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  teacherId?: string;
}

export class UpdateClassSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  startsAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  endsAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  topic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  teacherId?: string;

  @IsOptional()
  @IsEnum(ClassSessionStatus)
  status?: ClassSessionStatus;
}
