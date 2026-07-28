import { IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApplicationStatus, ContactChannel, Country, Direction } from '@prisma/client';

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

  // WhatsApp-номер: менеджер может поправить его в карточке заявки.
  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'whatsappPhone должен содержать только цифры' })
  whatsappPhone?: string;

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

  // Направление менеджер по-прежнему правит руками — у заявок с лендинга
  // здесь лежит плейсхолдер (см. ApplicationsService.DEFAULT_DIRECTION).
  @IsOptional()
  @IsEnum(Direction)
  direction?: Direction;

  // Страна, выбранная клиентом на лендинге; менеджер может исправить.
  @IsOptional()
  @IsEnum(Country)
  country?: Country;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
