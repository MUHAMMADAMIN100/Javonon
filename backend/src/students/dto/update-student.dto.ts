import { IsArray, IsEmail, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, IsObject } from 'class-validator';
import { ContactChannel, OnboardingStage, StudentStatus } from '@prisma/client';
import { Direction } from '../../common/lookup-keys';
import { IsLookupKey } from '../../common/lookup-validators';

const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(PHONE_RE, { each: true, message: 'каждый phone должен содержать только цифры' })
  phones?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  phoneLabels?: string[];

  @IsOptional()
  @IsEnum(ContactChannel)
  preferredChannel?: ContactChannel;

  @IsOptional()
  birthday?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photoUrl?: string;

  @IsOptional()
  @IsLookupKey('Выберите направление из списка')
  direction?: Direction;

  // Свои поля анкеты (перешли из лида; правятся в карточке студента).
  @IsOptional()
  @IsObject({ message: 'Поля анкеты: неверный формат' })
  customFields?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  cabinet?: number;

  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;

  @IsOptional()
  @IsEnum(OnboardingStage)
  onboardingStage?: OnboardingStage;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
