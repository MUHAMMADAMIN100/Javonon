import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ContactChannel, Country, ApplicationSource } from '@prisma/client';

// E.164: '+' необязателен, 7–15 цифр всего, разрешаем пробелы/дефисы при вводе.
export const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;
// QA-fix: имя без HTML-тегов (XSS) — fullName попадает в email-шаблоны и Telegram.
export const NO_HTML_RE = /^[^<>]*$/;
// Реферальный код партнёра: 4–16 буквенно-цифровых, регистр не важен
// (нормализуется в ReferralsService через .trim().toUpperCase()).
const REF_CODE_RE = /^[A-Z0-9]{4,16}$/i;

export class CreateApplicationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'ФИО содержит недопустимые символы' })
  fullName: string;

  @IsString()
  @MinLength(5)
  @MaxLength(40)
  @Matches(PHONE_RE, { message: 'phone должен содержать только цифры (с опциональным «+» и пробелами/дефисами)' })
  phone: string;

  // WhatsApp-номер клиента. На лендинге чекбокс «Ҳамон рақами телефон»
  // включён по умолчанию — тогда сюда приходит тот же номер, что и в phone.
  // Валидация СПЕЦИАЛЬНО та же самая (PHONE_RE + те же границы длины),
  // что и у phone: второй регекс завёл бы два расходящихся правила.
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(40)
  @Matches(PHONE_RE, { message: 'whatsappPhone должен содержать только цифры (с опциональным «+» и пробелами/дефисами)' })
  whatsappPhone?: string;

  // Доп. номер (отец/мать/другое контактное лицо). По ТЗ §8.
  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'secondaryPhone должен содержать только цифры' })
  secondaryPhone?: string;

  // Подпись доп. контакта: «Отец», «Мать» и т.п.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  secondaryContactLabel?: string;

  // Предпочтительный канал связи (WhatsApp/Phone/Instagram/Telegram/Email).
  @IsOptional()
  @IsEnum(ContactChannel)
  preferredChannel?: ContactChannel;

  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string;

  // Поля `direction` здесь НЕТ и быть не должно: направление на этапе создания
  // не спрашивает ни один клиент этого DTO. Единственный вход в
  // ApplicationsService.create() — POST /applications/public, и дёргает его
  // только форма лендинга, которая спрашивает страну (country) вместо «Ҳадаф».
  // Telegram-бот заявок не создаёт вообще (уводит человека на ту же форму,
  // см. telegram/bot-funnel.service.ts), а «ручное создание» в CRM идёт через
  // POST /students → StudentsService.create(), который пишет Application
  // напрямую в Prisma и это DTO не использует.
  // NOT NULL-колонку Application.direction заполняет плейсхолдер
  // ApplicationsService.DEFAULT_DIRECTION; настоящее направление менеджер
  // выставляет позже в карточке студента (PATCH /students/:id).

  // Страна обучения — то, что теперь реально спрашивает лендинг.
  @IsOptional()
  @IsEnum(Country)
  country?: Country;

  // Дата рождения, ISO (`YYYY-MM-DD` из <input type="date">).
  // Сервис хранит её как UTC-полночь того же календарного дня (DOB — дата, а
  // не момент; см. parseCalendarDateUtc в common/tj-time.ts), а возраст 14–60
  // проверяет относительно «сегодня» по Asia/Dushanbe.
  @IsOptional()
  @IsDateString()
  birthday?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(NO_HTML_RE, { message: 'Комментарий содержит недопустимые символы' })
  comment?: string;

  @IsOptional()
  @IsString()
  programId?: string;

  @IsOptional()
  @IsEnum(ApplicationSource)
  source?: ApplicationSource;

  // Реферальный код партнёра из query-параметра ?ref= на лендинге.
  // ВАЖНО: должно быть decorated-полем DTO, иначе глобальный
  // ValidationPipe({ whitelist: true }) в main.ts срежет его до того,
  // как ApplicationsService успеет вызвать ReferralsService.attribute().
  // Раньше был intersection-type в контроллере (CreateApplicationDto &
  // { ref?: string }) — intersection-типы не имеют runtime-метаданных,
  // и class-transformer их не видит. Результат: реферальная атрибуция
  // с лендинга не работала 100% времени.
  @IsOptional()
  @IsString()
  @Matches(REF_CODE_RE, { message: 'ref: 4–16 буквенно-цифровых символов' })
  ref?: string;
}
