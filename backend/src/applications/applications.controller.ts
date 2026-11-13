import {
  BadRequestException,
  ForbiddenException,
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
import { Role } from '@prisma/client';
import { ApplicationSource, ApplicationStatus, Country, Direction } from '../common/lookup-keys';
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
import { isAccountantOnly, isElevated } from '../auth/role-utils';
import { LookupsService } from '../lookups/lookups.service';
import { LEGACY_STATUS_LABEL } from '../lookups/lookup-defaults';

@Controller('applications')
export class ApplicationsController {
  constructor(private apps: ApplicationsService, private lookups: LookupsService) {}

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
  @Permissions('leads:create')
  @Post('staff')
  createByStaff(@Body() dto: CreateStaffApplicationDto, @CurrentUser() user: any) {
    return this.apps.createByStaff(dto, user);
  }

  @UseGuards(JwtAuthGuard)
  @Permissions('leads:read', 'applications:read')
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
    // Период списка. Появился ради сходимости с дашбордом: клик по строке
    // «Заявки по направлениям · 2» обязан открыть ровно те 2 заявки, из
    // которых карточка сложила двойку, а не все за всё время. Разбор дат —
    // тем же parseDate, что и у stats(): календарные границы по
    // Asia/Dushanbe, `to` включительно до 23:59:59.999 TJT.
    @Query('from') from?: string,
    @Query('to') to?: string,
    // «Без направления» на дашборде — такая же строка, как остальные, и по
    // ней тоже кликают. Отдельный флаг, а не direction=NONE: направление у
    // такой заявки ЕСТЬ (плейсхолдер), не подтверждено лишь то, что его
    // выбрал клиент.
    @Query('directionPending') directionPending?: string,
    /** Заявки без указанной страны — строка «Не указано» карточки «Страны». */
    @Query('countryPending') countryPending?: string,
    // Серверная пагинация экрана «Заявки»: с page ответ — { items, total },
    // без него — весь список массивом, как раньше (очередь лидов, дашборд).
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sort') sort?: string,
    @Query('ranks') ranks?: string,
    @Query('deleted') deleted?: string,
    @Query('duplicates') duplicates?: string,
    // Быстрый вид «С долгом» (макет таблицы «Лиды»): только с отметкой должника.
    @Query('debt') debt?: string,
    @Query('brief') brief?: string,
    // QA-3 (набл. 13): без страницы список можно ограничить (?limit=50).
    @Query('limit') limit?: string,
    // Свои поля анкеты: ?cf_<ключ>=значение.
    @Query() query?: Record<string, unknown>,
  ) {
    const customFilters = Object.entries(query ?? {})
      .filter(([k, v]) => k.startsWith('cf_') && typeof v === 'string' && v.length <= 60)
      .slice(0, 10)
      .map(([k, v]) => ({ key: k.slice(3), value: String(v) }));
    // QA-fix #45: неизвестное значение фильтра — 400, а не пустой список.
    // Источник истины — справочники «Лиды → Настройки» (13.11.2026); статус
    // ещё и легаси-ключом старой воронки (старые строки читаются).
    if (status && !this.lookups.has('LEAD_STATUS', status) && !LEGACY_STATUS_LABEL[status]) throw new BadRequestException('Неизвестный статус');
    if (direction && !this.lookups.has('DIRECTION', direction)) throw new BadRequestException('Неизвестное направление');
    if (country && !this.lookups.has('COUNTRY', country)) throw new BadRequestException('Неизвестная страна');
    if (source && !this.lookups.has('LEAD_SOURCE', source)) throw new BadRequestException('Неизвестный источник');
    // search cap: без него юзер мог запросить ?search=AAA...×100k →
    // ILIKE %AAA% сканировал бы всю Application таблицу с гигантским
    // паттерном. 200 символов хватит для любого реального поиска.
    if (search && search.length > 200) throw new BadRequestException('Поисковая строка слишком длинная');
    // QA-2: бухгалтеру раздел «Лиды» не показан — и база лидов с телефонами
    // ему не отдаётся (раньше API возвращал все 2 338).
    if (isAccountantOnly(user)) throw new ForbiddenException('Список лидов бухгалтеру не открыт');
    return this.apps.findAll({
      status: status as ApplicationStatus | undefined,
      direction: direction as Direction | undefined,
      country: country as Country | undefined,
      search,
      mine: mine === 'true',
      managerUserId: manager || undefined,
      source: source as ApplicationSource | undefined,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
      directionPending: directionPending === 'true' || directionPending === '1',
      countryPending: countryPending === 'true' || countryPending === '1',
      currentUserId: user?.id,
      currentUserRole: user?.role,
      currentUserRoles: user?.roles,
      currentUserPermissions: user?.permissions,
      currentUserHasCustomRole: user?.hasCustomRole,
      page: page ? Math.max(1, parseInt(page, 10) || 1) : undefined,
      pageSize: pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)) : undefined,
      sort,
      ranks: ranks?.slice(0, 2000),
      deleted: deleted === '1' || deleted === 'true',
      // «Дубли» — только руководству: остальным список и так ограничен своими.
      duplicates: (duplicates === '1' || duplicates === 'true') && isElevated(user),
      debt: debt === '1' || debt === 'true',
      customFilters,
      brief: brief === '1' || brief === 'true',
      limit: limit ? Math.min(500, Math.max(1, parseInt(limit, 10) || 0)) || undefined : undefined,
    });
  }

  // from/to — опциональный период дашборда (переключатель «Этот месяц /
  // Квартал / …»). Фильтрует по дате СОЗДАНИЯ заявки. Парсер — тот же
  // общий parseDate, что и у /finance/summary: границы считаются по
  // Asia/Dushanbe, `to` inclusive до 23:59:59.999 TJT. Без параметров
  // ответ ровно прежний — за всё время.
  /**
   * Числа на быстрых видах списка «Лиды» (макет 11.11.2026): Все, Мои, Новые,
   * Без менеджера, С долгом. Считаются тем же findAll, что и сам список, —
   * права те же: менеджер видит числа только по своим лидам.
   */
  @UseGuards(JwtAuthGuard)
  @Permissions('leads:read', 'applications:read')
  @Get('view-counts')
  viewCounts(@CurrentUser() user: any) {
    if (isAccountantOnly(user)) throw new ForbiddenException('Список лидов бухгалтеру не открыт');
    return this.apps.viewCounts(user);
  }

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
   * Права — как у назначения (…:assign); сотруднику с ролью ещё и с «Все,
   * не только свои» — для фильтра «Менеджер» в списках. GET /users для
   * этого не годится — он отдаёт кадровую карточку целиком; здесь — только
   * id, имя и роль.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  @Permissions('leads:assign', 'applications:assign', 'leads:all', 'applications:all', 'students:all')
  @Get('managers')
  listAssignableManagers(@CurrentUser() user: any) {
    return this.apps.listAssignableManagers(user);
  }

  /**
   * Массовое назначение менеджера пачке лидов (экран /leads: галочки →
   * менеджер → «Назначить»). Логика и обоснование — в
   * ApplicationsService.bulkAssignManager.
   *
   * ОБЪЯВЛЕН ДО маршрутов с ':id' НАМЕРЕННО: Nest регистрирует ручки в
   * порядке объявления, и PATCH /applications/bulk/manager иначе совпал бы
   * с PATCH ':id/manager' при id='bulk' — запрос молча ушёл бы в одиночное
   * назначение и упал бы «Заявка не найдена».
   *
   * Гвард и пермишен — те же, что у одиночного назначения: это та же
   * операция, только над пачкой.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  @Permissions('leads:assign', 'applications:assign')
  @Patch('bulk/manager')
  bulkAssignManager(
    @Body() body: { ids?: string[]; managerId?: string; confirmReassign?: boolean },
    @CurrentUser() user: any,
  ) {
    return this.apps.bulkAssignManager(body, user);
  }

  /**
   * Сделки клиента для блока «Сделки» карточки лида (макет 11.11.2026): по
   * самому лиду, по лиду-источнику и по его студенту. Доступ — как к карточке;
   * суммы — только тем, кому видны деньги клиентов; «открыть» — тем, кому
   * откроется сама сделка.
   */
  @UseGuards(JwtAuthGuard)
  @Permissions('leads:read', 'applications:read')
  @Get(':id/deals')
  async deals(@Param('id') id: string, @CurrentUser() user: any) {
    await this.apps.assertCanView(id, user);
    return this.apps.dealsForLead(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Permissions('leads:read', 'applications:read')
  @Get(':id')
  async one(@Param('id') id: string, @CurrentUser() user: any) {
    await this.apps.assertCanView(id, user);
    // user нужен сервису ещё и чтобы решить, отдавать ли блок «Партнёр»
    // (руководству — да, менеджерам — поля в ответе нет вообще).
    const app = await this.apps.findOne(id, user);
    return { ...app, phoneTwins: await this.apps.phoneTwins(app, user) };
  }

  @UseGuards(JwtAuthGuard)
  @Permissions('leads:update', 'applications:update')
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
  @Permissions('leads:assign', 'applications:assign')
  @Patch(':id/manager')
  assignManager(
    @Param('id') id: string,
    @Body() body: { managerId?: string | null; chinaManagerId?: string | null },
    @CurrentUser() user: any,
  ) {
    return this.apps.assignManager(id, body, user);
  }

  @UseGuards(JwtAuthGuard)
  @Permissions('leads:delete', 'applications:delete')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.apps.remove(id, user);
  }

  /** Вернуть заявку из корзины. */
  @UseGuards(JwtAuthGuard)
  @Permissions('leads:delete', 'applications:delete')
  @Post(':id/restore')
  restore(@Param('id') id: string, @CurrentUser() user: any) {
    return this.apps.restore(id, user);
  }
}
