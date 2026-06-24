import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Direction } from '@prisma/client';

// Раньше эти поля принимались с одним только MaxLength — `<script>`,
// `<img onerror=...>` лежали в БД и рендерились на публичном лендинге
// каталога программ. React JSX эскейпит при отдаче через CRM, но
// landing не использует JSX везде, а Telegram html-mode push нет.
const NO_HTML = /^[^<>]*$/;
// imageUrl сохранялся как-есть и рендерился как <img src={imageUrl}>.
// Без scheme guard `javascript:alert(1)` срабатывал на клик/load.
const SAFE_URL = /^(https?:\/\/|\/\/|\/)\S{0,2000}$/i;
// Для официального сайта университета — обязательно http(s)://, без
// относительных. Допускаем пустую строку — поле опц.
const HTTP_URL = /^(https?:\/\/)\S{0,2000}$|^$/i;

export class UpdateProgramDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) @Matches(NO_HTML, { message: 'name содержит HTML-теги' }) name?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) @Matches(NO_HTML, { message: 'university содержит HTML-теги' }) university?: string;
  // city/major/cost/currency больше не обязательны по ТЗ-доработке.
  // MinLength снят, чтобы можно было сохранить пустыми (программа без
  // фиксированного города/специальности, или стоимость 0).
  @IsOptional() @IsString() @MaxLength(100) @Matches(NO_HTML, { message: 'city содержит HTML-теги' }) city?: string;
  @IsOptional() @IsString() @MaxLength(200) @Matches(NO_HTML, { message: 'major содержит HTML-теги' }) major?: string;
  @IsOptional() @IsEnum(Direction) direction?: Direction;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) cost?: number;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(80) @Matches(NO_HTML, { message: 'duration содержит HTML-теги' }) duration?: string;
  @IsOptional() @IsString() @MaxLength(80) @Matches(NO_HTML, { message: 'language содержит HTML-теги' }) language?: string;
  @IsOptional() @IsString() @MaxLength(4000) @Matches(NO_HTML, { message: 'description содержит HTML-теги' }) description?: string;
  @IsOptional() @IsString() @MaxLength(400) @Matches(SAFE_URL, { message: 'imageUrl должен быть http(s) или относительной ссылкой' }) imageUrl?: string;
  @IsOptional() @IsString() @MaxLength(2000) @Matches(HTTP_URL, { message: 'universityWebsiteUrl должен быть http(s) ссылкой' }) universityWebsiteUrl?: string;
  @IsOptional() @IsBoolean() published?: boolean;
  @IsOptional() @IsString() @MaxLength(120) @Matches(NO_HTML, { message: 'englishLevel содержит HTML-теги' }) englishLevel?: string;
  @IsOptional() @IsBoolean() hasGrant?: boolean;
  @IsOptional() @IsString() @MaxLength(500) @Matches(NO_HTML, { message: 'grantDetails содержит HTML-теги' }) grantDetails?: string;
  @IsOptional() @IsString() @MaxLength(120) @Matches(NO_HTML, { message: 'grantEnglishLevel содержит HTML-теги' }) grantEnglishLevel?: string;
  @IsOptional() @IsString() @MaxLength(120) @Matches(NO_HTML, { message: 'avgAdmissionScore содержит HTML-теги' }) avgAdmissionScore?: string;
  @IsOptional() @IsString() @MaxLength(200) @Matches(NO_HTML, { message: 'applicationDeadline содержит HTML-теги' }) applicationDeadline?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(12) intakesPerYear?: number;
}
