import { IsDateString, IsEnum, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ExternalMessageChannel } from '@prisma/client';

const NO_HTML_RE = /^[^<>]*$/;

/**
 * Создание массовой рассылки (ТЗ §10). Раньше эндпоинт принимал
 * `body: any` — admin мог отправить рассылку с любым полем, любой
 * длины, с <script> в теме/тексте. Хотя сами шаблоны рендерятся как
 * plain text, тема письма попадает в email-заголовок (потенциально
 * header injection через \r\n), и `name` пишется в активити-логи.
 */
export class CreateMassmailDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Matches(NO_HTML_RE, { message: 'Название содержит недопустимые символы' })
  name!: string;

  @IsEnum(ExternalMessageChannel)
  channel!: ExternalMessageChannel;

  // Email subject — ограничиваем длиной и запрещаем \r\n (header injection).
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\r\n<>]*$/, { message: 'Тема не должна содержать переносы строк или HTML-теги' })
  subject?: string;

  // Тело сообщения. Большое значение (письма часто длинные), но в
  // разумных рамках. Внутри тела могут быть переносы строк, поэтому
  // здесь только HTML-теги запрещаем.
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  @Matches(/^[^<>]*$/, { message: 'Текст не должен содержать HTML-теги. Для форматирования используй plain text.' })
  body!: string;

  // Audience — структурированный JSON, валидируем как объект; шейп
  // проверяет service.resolveAudience.
  @IsObject()
  audience!: Record<string, any>;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
