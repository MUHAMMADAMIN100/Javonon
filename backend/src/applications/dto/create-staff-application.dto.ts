import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApplicationSource, ContactChannel, Country } from '@prisma/client';
import { NO_HTML_RE, PHONE_RE } from './create-application.dto';

/**
 * DTO ручного ввода лида сотрудником (экран /leads, роль «Квалификатор
 * лидов»). Заявки приходят по телефону и в мессенджерах, Meta-интеграции
 * ещё нет — кто-то набирает их руками.
 *
 * Набор полей и правила ВАЛИДАЦИИ — те же, что у формы лендинга
 * (CreateApplicationDto): PHONE_RE и NO_HTML_RE импортируются оттуда, а не
 * копируются, иначе завелись бы два расходящихся набора правил для одного
 * и того же номера телефона. Возрастное окно 14–60 для birthday проверяет
 * тот же ApplicationsService.parseBirthday, что и лендинг.
 *
 * Отличия от CreateApplicationDto — ровно два, оба намеренные:
 *  1. НЕТ поля `ref`. У лида, набранного руками, партнёра нет по
 *     определению; реферальная атрибуция здесь не запускается вообще
 *     (см. createByStaff). Отсутствие поля в DTO — гарантия, что её нельзя
 *     инициировать и «снизу», подсунув код в теле запроса.
 *  2. `source` сужен до каналов привлечения (см. STAFF_ALLOWED_SOURCES).
 */

/**
 * Источники, которые сотрудник вправе проставить руками.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. В ApplicationSource НЕТ значения, которое
 * означало бы «завёл сотрудник вручную», и выдумывать новое нельзя —
 * это destructive-изменение схемы (Railway гоняет
 * `prisma db push --accept-data-loss`). Поэтому:
 *  • LANDING_FORM и SELF_REGISTRATION исключены: это машинно
 *    подтверждённое происхождение («пришло из формы лендинга» /
 *    «клиент зарегистрировался сам в кабинете», StudentAuthService).
 *    Позволить сотруднику проставить их руками — значит разрешить
 *    подделать провенанс и сломать оба отчёта.
 *  • REFERRAL исключён: он подразумевает партнёрскую атрибуцию, которой
 *    у ручного лида нет (и которую этот путь принципиально не запускает).
 * Остальное — то, что квалификатор реально слышит в трубке: «увидел в
 * Instagram», «написал в Telegram», «посоветовал знакомый», «был на дне
 * открытых дверей». Дефолт — OTHER (STAFF_DEFAULT_SOURCE): честный
 * «прочее», а не чужой машинный источник.
 */
export const STAFF_ALLOWED_SOURCES = [
  'INSTAGRAM',
  'TELEGRAM',
  'GOOGLE_ADS',
  'TIKTOK',
  'WORD_OF_MOUTH',
  'EVENT',
  'OTHER',
] as const satisfies readonly ApplicationSource[];

export type StaffApplicationSource = (typeof STAFF_ALLOWED_SOURCES)[number];

/** Источник по умолчанию для лида, набранного сотрудником руками. */
export const STAFF_DEFAULT_SOURCE: ApplicationSource = 'OTHER';

export class CreateStaffApplicationDto {
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

  // На форме — чекбокс «тот же номер»: тогда сюда приходит тот же номер,
  // что и в phone. Правила те же, что у phone (см. комментарий в
  // CreateApplicationDto — второй регекс завёл бы два расходящихся правила).
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(40)
  @Matches(PHONE_RE, { message: 'whatsappPhone должен содержать только цифры (с опциональным «+» и пробелами/дефисами)' })
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

  @IsOptional()
  @IsEnum(Country)
  country?: Country;

  // `YYYY-MM-DD`. Возраст 14–60 проверяется сервисом (parseBirthday),
  // ровно как для заявки с лендинга.
  @IsOptional()
  @IsDateString()
  birthday?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(NO_HTML_RE, { message: 'Комментарий содержит недопустимые символы' })
  comment?: string;

  // Канал привлечения со слов клиента. Опционален; без него — OTHER.
  // @IsIn, а не @IsEnum(ApplicationSource): полный enum пропустил бы
  // LANDING_FORM / SELF_REGISTRATION / REFERRAL (см. блок выше).
  @IsOptional()
  @IsIn(STAFF_ALLOWED_SOURCES as readonly string[], {
    message: 'Недопустимый источник для лида, введённого вручную',
  })
  source?: StaffApplicationSource;
}
