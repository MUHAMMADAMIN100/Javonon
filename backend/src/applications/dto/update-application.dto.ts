import { IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, IsObject } from 'class-validator';
import { ApplicationStatus, Country, Direction, ContactChannel } from '../../common/lookup-keys';
import { NO_HTML_RE } from './create-application.dto';
import { IsLookupKey } from '../../common/lookup-validators';

const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

export class UpdateApplicationDto {
  // Статус — ключ из справочника «Лиды → Настройки». Есть ли он там, проверяет
  // ApplicationsService.update (isWritableStatus): легаси-значения старой
  // воронки в справочнике отсутствуют, поэтому записать их нельзя — старая
  // вкладка CRM получит 400, а не откатит заявку за миграцию.
  @IsOptional()
  @IsLookupKey('Выберите статус из списка')
  status?: ApplicationStatus;

  // Свои поля анкеты: пришли — проверяем и сливаем с прежними (пустое снимает).
  @IsOptional()
  @IsObject({ message: 'Поля анкеты: неверный формат' })
  customFields?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(NO_HTML_RE, { message: 'ФИО: нельзя использовать знаки < и >' })
  fullName?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'Телефон: только цифры (можно «+», пробелы, скобки и дефис), от 7 до 20 знаков' })
  phone?: string;

  // WhatsApp-номер: менеджер может поправить его в карточке заявки.
  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'WhatsApp: только цифры (можно «+», пробелы, скобки и дефис), от 7 до 20 знаков' })
  whatsappPhone?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, { message: 'Второй телефон: только цифры (можно «+», пробелы, скобки и дефис), от 7 до 20 знаков' })
  secondaryPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  secondaryContactLabel?: string;

  @IsOptional()
  @IsLookupKey('Выберите канал связи из списка')
  preferredChannel?: ContactChannel;

  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string;

  // Направление менеджер по-прежнему правит руками — у заявок с лендинга
  // здесь лежит плейсхолдер (см. ApplicationsService.DEFAULT_DIRECTION).
  @IsOptional()
  @IsLookupKey('Выберите направление из списка')
  direction?: Direction;

  /**
   * QA-3 (BUG-07): источник лида можно поправить — но только среди тех, что
   * сотрудник вправе ставить руками. «Сайт», «Самозапись» и «Реферал»
   * определяются автоматически и не меняются (см. ApplicationsService.update).
   */
  @IsOptional()
  @IsLookupKey('Выберите источник из списка')
  source?: string;

  // Страна, выбранная клиентом на лендинге; менеджер может исправить.
  @IsOptional()
  @IsLookupKey('Выберите страну из списка')
  country?: Country;

  // Те же правила, что у «Нового лида» (QA №23): раньше карточка сохраняла
  // «<script>», а окно «Изменить лид» потом не давало сохранить ничего.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(NO_HTML_RE, { message: 'Комментарий: нельзя использовать знаки < и >' })
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

  /** Дата рождения (YYYY-MM-DD); пустая строка — очистить. Окно возраста — как у нового лида. */
  @IsOptional()
  @IsString()
  birthday?: string;
}
