import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApplicationSource, ApplicationStatus, Country, Direction, Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { CreateStaffApplicationDto } from './dto/create-staff-application.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Permissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseDate } from '../common/query-date';

@Controller('applications')
export class ApplicationsController {
  constructor(private apps: ApplicationsService) {}

  // Лимит: 5 заявок в минуту с одного IP — защита от спама из формы лендинга.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('public')
  createFromLanding(@Body() dto: CreateApplicationDto) {
    // `ref` живёт как decorated-поле CreateApplicationDto — intersection-type
    // здесь использовать нельзя: ValidationPipe({ whitelist: true }) видит
    // только рефлектированные метаданные класса и срезает undecorated-ключи.
    return this.apps.create(dto);
  }

  /**
   * Ручной ввод лида сотрудником из CRM (экран /leads).
   *
   * ОТДЕЛЬНЫЙ маршрут, а не «тот же public с токеном»: у публичного
   * эндпоинта выше нет гварда вообще, свой throttle 5/мин на IP (квалификатор
   * набирает лиды десятками подряд и упёрся бы в него на шестом), он
   * принимает `ref` и запускает реферальную атрибуцию, шлёт SMS клиенту,
   * пост в Telegram и письмо «Новая заявка с лендинга». Ни один из этих
   * эффектов для набранного руками лида не нужен и не верен. Публичный
   * эндпоинт этим изменением не затронут.
   *
   * Права: applications:create. RolesGuard пропускает по OR — либо базовая
   * роль сотрудника (@Roles), либо пермишен кастомной роли (@Permissions),
   * либо неявная проверка по URL. Последняя матчит ЛЮБОЙ write-пермишен
   * раздела ('/applications' — create|update|delete|assign), поэтому точный
   * ключ доопределяет второй рубеж — canCreateApplication() в сервисе.
   * Отдельного ключа под «лиды» намеренно не заводим: роль уже собрана
   * основателем на существующих ключах, новый был бы всюду снят.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  @Permissions('applications:create')
  @Post('staff')
  createByStaff(@Body() dto: CreateStaffApplicationDto, @CurrentUser() user: any) {
    return this.apps.createByStaff(dto, user);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  list(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
    @Query('country') country?: string,
    @Query('search') search?: string,
    @Query('mine') mine?: string,
    @Query('manager') manager?: string,
    @Query('source') source?: string,
  ) {
    // QA-fix #45: validate enum query params (раньше bad value → 500).
    // Единый источник истины — Prisma enum'ы. Добавили значение в schema.prisma
    // → prisma generate → фильтр здесь автоматически знает о новом значении.
    // Раньше были ручные массивы, которые забывали синхронизировать (P2009 / 400).
    const VALID_STATUS = Object.values(ApplicationStatus) as string[];
    const VALID_DIR = Object.values(Direction) as string[];
    const VALID_SOURCE = Object.values(ApplicationSource) as string[];
    const VALID_COUNTRY = Object.values(Country) as string[];
    if (status && !VALID_STATUS.includes(status)) throw new BadRequestException('Неизвестный статус');
    if (direction && !VALID_DIR.includes(direction)) throw new BadRequestException('Неизвестное направление');
    if (country && !VALID_COUNTRY.includes(country)) throw new BadRequestException('Неизвестная страна');
    if (source && !VALID_SOURCE.includes(source)) throw new BadRequestException('Неизвестный источник');
    // search cap: без него юзер мог запросить ?search=AAA...×100k →
    // ILIKE %AAA% сканировал бы всю Application таблицу с гигантским
    // паттерном. 200 символов хватит для любого реального поиска.
    if (search && search.length > 200) throw new BadRequestException('Поисковая строка слишком длинная');
    return this.apps.findAll({
      status: status as ApplicationStatus | undefined,
      direction: direction as Direction | undefined,
      country: country as Country | undefined,
      search,
      mine: mine === 'true',
      managerUserId: manager || undefined,
      source: source as ApplicationSource | undefined,
      currentUserId: user?.id,
      currentUserRole: user?.role,
      currentUserRoles: user?.roles,
      currentUserPermissions: user?.permissions,
      currentUserHasCustomRole: user?.hasCustomRole,
    });
  }

  // from/to — опциональный период дашборда (переключатель «Этот месяц /
  // Квартал / …»). Фильтрует по дате СОЗДАНИЯ заявки. Парсер — тот же
  // общий parseDate, что и у /finance/summary: границы считаются по
  // Asia/Dushanbe, `to` inclusive до 23:59:59.999 TJT. Без параметров
  // ответ ровно прежний — за всё время.
  @UseGuards(JwtAuthGuard)
  @Get('stats')
  stats(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.apps.stats(user, {
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
    });
  }

  /**
   * Справочник сотрудников для инлайнового <select> «Менеджер» в строке
   * списка /leads. Объявлен ДО @Get(':id'), иначе 'managers' уедет в :id.
   *
   * Права те же, что у самого назначения (applications:assign): показывать
   * список тех, кому нельзя назначить, смысла нет. GET /users для этого не
   * годится — он @Roles(ADMIN, ACCOUNTANT) и отдаёт кадровую карточку
   * целиком; здесь — только id, имя и роль.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  @Permissions('applications:assign')
  @Get('managers')
  listAssignableManagers(@CurrentUser() user: any) {
    return this.apps.listAssignableManagers(user);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() user: any) {
    // user нужен сервису только чтобы решить, отдавать ли блок «Партнёр»
    // (руководству — да, менеджерам — поля в ответе нет вообще).
    return this.apps.findOne(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
    @CurrentUser() user: any,
  ) {
    return this.apps.update(id, dto, user);
  }

  /**
   * Назначение менеджера. Тот же самый эндпоинт, что использует карточка
   * заявки: инлайновый <select> в строке /leads шлёт сюда же — второго пути
   * назначения не заводим, иначе ActivityLog(MANAGER_CHANGE), зеркалирование
   * менеджера на Student и realtime разошлись бы между двумя реализациями
   * (ровно так уже разошёлся POST /sales/applications/:id/assign, который
   * ни того, ни другого не делает).
   *
   * Права: applications:assign. Гвард здесь — первый рубеж (раньше на
   * контроллере не было вообще ничего, кроме JwtAuthGuard); точный ключ и
   * ОБЪЁМ прав (взять себе / раздать любому) доопределяет
   * ApplicationsService.assignManager.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  @Permissions('applications:assign')
  @Patch(':id/manager')
  assignManager(
    @Param('id') id: string,
    @Body() body: { managerId?: string | null; chinaManagerId?: string | null },
    @CurrentUser() user: any,
  ) {
    return this.apps.assignManager(id, body, user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.apps.remove(id, user);
  }
}
