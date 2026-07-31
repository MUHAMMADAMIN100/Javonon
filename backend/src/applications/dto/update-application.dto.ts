import { IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApplicationStatus, ContactChannel, Country, Direction } from '@prisma/client';
import { ACTIVE_APPLICATION_STATUSES } from '../../common/application-status';

const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

export class UpdateApplicationDto {
  // ВНИМАНИЕ: здесь НЕ @IsEnum(ApplicationStatus).
  //
  // Prisma-enum по-прежнему содержит все восемь легаси-значений (NEW,
  // IN_PROGRESS, DOCS_REVIEW, DOCS_SUBMITTED, PRE_ADMISSION, AWAITING_PAYMENT,
  // COMPLETED, ENROLLED) и удалить их нельзя: Postgres не дропает значения, на
  // которые ссылаются строки, а `start:prod` делает `prisma db push` без
  // --accept-data-loss. То есть @IsEnum пропускал бы легаси-статус на запись —
  // и заявка откатывалась бы ЗА уже отработавшую миграцию (повторно её никто
  // не перенесёт), плюс клиенту уходила бы SMS «Заявка возвращена с …».
  //
  // Ограничиваем набор до ACTIVE_APPLICATION_STATUSES — того же списка, что
  // CRM показывает в дропдауне. Валидация серверная СПЕЦИАЛЬНО: главный
  // источник таких запросов — вкладка CRM, открытая до деплоя (Vercel отдаёт
  // хэшированные бандлы как immutable, поэтому старый JS в ней живёт до
  // перезагрузки и всё ещё умеет слать DOCS_REVIEW). Такой клиент получит 400.
  @IsOptional()
  @IsIn(ACTIVE_APPLICATION_STATUSES, {
    message: `status: допустимы только актуальные статусы (${ACTIVE_APPLICATION_STATUSES.join(', ')}). Старые значения доступны только для чтения — обновите страницу CRM.`,
  })
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

  // «За заявкой числится долг» — то, что раньше выражалось статусом
  // AWAITING_PAYMENT. Статуса такого больше нет (и на запись он закрыт
  // валидатором выше), поэтому признак долга менеджер ставит и снимает
  // отдельным флагом; читают его финансы (GET /finance/pending-payments).
  // Без этого поля колонка была бы доступна только миграции — список
  // должников замерз бы на снимке и мог бы лишь устаревать.
  @IsOptional()
  @IsBoolean()
  paymentPending?: boolean;
}
