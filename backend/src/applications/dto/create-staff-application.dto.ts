import { IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsOptional, IsString, Matches, MinLength, MaxLength, IsObject } from 'class-validator';
import { Transform } from 'class-transformer';
import { ContactChannel } from '@prisma/client';
import { ApplicationSource, ApplicationStatus, Country, Direction } from '../../common/lookup-keys';
import { NO_HTML_RE } from './create-application.dto';
import { IsLookupKey } from '../../common/lookup-validators';

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
  // QA-2: ФИО из одних пробелов сервер принимал — обрезаем до проверки длины.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  @IsString({ message: 'Укажите ФИО' })
  @MinLength(2, { message: 'ФИО: минимум 2 буквы' })
  @MaxLength(120, { message: 'ФИО: не длиннее 120 символов' })
  @Matches(NO_HTML_RE, { message: 'ФИО: нельзя использовать знаки < и >' })
  fullName: string;

  // Формат и длину проверяет normalizePhone в сервисе — с понятным текстом
  // («номер слишком короткий…»), а не «только цифры» на короткий номер (QA-2).
  @IsString({ message: 'Укажите телефон' })
  @MaxLength(40, { message: 'Телефон слишком длинный' })
  phone: string;

  // На форме — чекбокс «тот же номер»: тогда сюда приходит тот же номер,
  // что и в phone. Правила те же, что у phone (см. комментарий в
  // CreateApplicationDto — второй регекс завёл бы два расходящихся правила).
  @IsOptional()
  @IsString()
  @MaxLength(40, { message: 'WhatsApp: номер слишком длинный' })
  whatsappPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40, { message: 'Второй телефон слишком длинный' })
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
  @IsLookupKey('Выберите страну из списка')
  country?: Country;

  // `YYYY-MM-DD`. Возраст 14–60 проверяется сервисом (parseBirthday),
  // ровно как для заявки с лендинга.
  // QA-2: форма требует дату рождения (возраст 14–60), сервер — тоже.
  @IsDateString({}, { message: 'Укажите дату рождения' })
  birthday: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(NO_HTML_RE, { message: 'Комментарий: нельзя использовать знаки < и >' })
  comment?: string;

  // Канал привлечения со слов клиента. Опционален; без него — OTHER.
  // @IsIn, а не @IsEnum(ApplicationSource): полный enum пропустил бы
  // LANDING_FORM / SELF_REGISTRATION / REFERRAL (см. блок выше).
  /** QA-3 (BUG-07): направление можно указать сразу при создании лида. */
  @IsOptional()
  @IsLookupKey('Выберите направление из списка')
  direction?: Direction;

  // Источник со слов клиента — значение справочника, кроме машинных
  // (Сайт, Самозапись, Реферал); проверяет ApplicationsService.createByStaff.
  @IsOptional()
  @IsLookupKey('Недопустимый источник для лида, введённого вручную')
  source?: string;

  // Кому лид (23.10.2026). Пусто — тому, кто создаёт. Другому — только с
  // правом раздавать лиды (проверяет ApplicationsService.createByStaff).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerId?: string;

  // Номер уже есть у открытого лида: без флага лид НЕ создаётся и НЕ
  // сливается — CRM сначала спрашивает сотрудника (QA №24). true — «добавить
  // повторное обращение» в найденный лид, как решил заказчик.
  @IsOptional()
  @IsBoolean()
  confirmDuplicate?: boolean;

  // Статус сразу в форме; по умолчанию «Новый лид». Только актуальные
  // значения — как у смены статуса в карточке (UpdateApplicationDto).
  @IsOptional()
  @IsLookupKey('Выберите статус из списка')
  status?: ApplicationStatus;

  // Свои поля анкеты: { [ключ поля]: значение } — проверяет LeadFieldsService.
  @IsOptional()
  @IsObject({ message: 'Поля анкеты: неверный формат' })
  customFields?: Record<string, unknown>;
}
