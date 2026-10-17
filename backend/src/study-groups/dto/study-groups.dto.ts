import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
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

  /** Домашнее задание к уроку. Пустая строка = стереть. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  homework?: string;

  /** Срок ДЗ 'YYYY-MM-DD'. Пустая строка = без срока. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  homeworkDue?: string;

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

/**
 * Занятия по шаблону: дни недели (1 = Пн … 7 = Вс), время и даты «с … по …»
 * включительно (душанбинские). dryRun — только посчитать, ничего не создавая.
 */
export class BulkClassSessionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays: number[];

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  endTime: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  topic?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
