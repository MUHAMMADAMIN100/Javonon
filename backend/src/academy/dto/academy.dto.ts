import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

export const ATTENDANCE_VALUES = ['PRESENT', 'ABSENT', 'LATE'] as const;

/** Отметка за урок — строка бумажного листа: посещение и три процента 0–100. */
export class JournalEntryItemDto {
  @IsUUID()
  studentId: string;

  @IsOptional()
  @IsIn(ATTENDANCE_VALUES as unknown as string[])
  attendance?: 'PRESENT' | 'ABSENT' | 'LATE' | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  homeworkPct?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  vocabularyPct?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  performancePct?: number | null;

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

  /** Сразу добавить в группу. Учителю обязательно — своя группа. */
  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** Телефоны родителей — необязательные. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  fatherPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  motherPhone?: string;

  /** Уровень из «Академия → Уровни». */
  @IsOptional()
  @IsUUID()
  levelId?: string;
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

  /** Пустая строка — стереть номер. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  fatherPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  motherPhone?: string;

  /** Пустая строка — без уровня. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  levelId?: string;
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

// ─── Уровни ───

export class AcademyLevelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;
}

export class ReorderLevelsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  ids: string[];
}

// ─── Завершение курса ───

export class CompleteCourseItemDto {
  @IsUUID()
  studentId: string;

  /** Новый уровень; null — без уровня. */
  @IsOptional()
  @IsUUID()
  levelId?: string | null;
}

export class CompleteCourseDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => CompleteCourseItemDto)
  items: CompleteCourseItemDto[];
}

// ─── Дневник ДЗ (кабинет студента) ───

export class HomeworkLogDto {
  @IsUUID()
  sessionId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}
