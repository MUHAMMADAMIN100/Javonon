import { IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApplicationStatus, ContactChannel, Direction } from '@prisma/client';

const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

export class UpdateApplicationDto {
  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'phone должен содержать только цифры' })
  phone?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'secondaryPhone должен содержать только цифры' })
  secondaryPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  secondaryContactLabel?: string;

  @IsOptional()
  @IsEnum(ContactChannel)
  preferredChannel?: ContactChannel;

  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @IsEnum(Direction)
  direction?: Direction;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
