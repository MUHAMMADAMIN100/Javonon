import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * ВНИМАНИЕ: глобальный ValidationPipe стоит с `whitelist: true` — поле без
 * декоратора молча вырезается из body. Декорируем всё, включая опциональное.
 *
 * null в полях отметок — осознанное «стереть» (поэтому @IsOptional, а не
 * отсутствие поля): undefined = не трогать, null = очистить.
 */

export class JournalEntryItemDto {
  @IsUUID()
  studentId: string;

  @IsOptional()
  @IsBoolean()
  present?: boolean | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  score?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string | null;
}

export class SaveJournalEntriesDto {
  @IsUUID()
  sessionId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => JournalEntryItemDto)
  items: JournalEntryItemDto[];
}

export class JournalWeekItemDto {
  @IsUUID()
  studentId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  bonus?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(70)
  exam?: number | null;
}

export class SaveJournalWeeksDto {
  @IsUUID()
  groupId: string;

  /** Понедельник недели 'YYYY-MM-DD' (проверяется в сервисе). */
  @IsString()
  @MaxLength(10)
  weekStart: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => JournalWeekItemDto)
  items: JournalWeekItemDto[];
}

export class AddMaterialLinkDto {
  @IsString()
  @MaxLength(2000)
  url: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

export class CreateAcademyStudentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @IsString()
  @MaxLength(40)
  phone: string;

  @IsString()
  @MaxLength(160)
  email: string;

  /** 'YYYY-MM-DD'. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  birthday?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  /** Сразу добавить в группу. */
  @IsOptional()
  @IsUUID()
  groupId?: string;
}

export class UpdateAcademyStudentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  /** 'YYYY-MM-DD' или пустая строка — стереть. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  birthday?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class GiveFlagDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  /** Группа, в которой случилось. Учитель обязан указать свою. */
  @IsOptional()
  @IsUUID()
  groupId?: string;
}

export class RemoveFlagDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AcademyDecisionDto {
  @IsIn(['EXPEL', 'KEEP'])
  action: 'EXPEL' | 'KEEP';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReinstateDto {
  @IsOptional()
  @IsUUID()
  groupId?: string;
}
