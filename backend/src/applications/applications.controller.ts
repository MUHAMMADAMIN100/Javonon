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
import { ApplicationSource, ApplicationStatus, Country, Direction } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';

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
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats')
  stats(@CurrentUser() user: any) {
    return this.apps.stats(user);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  one(@Param('id') id: string) {
    return this.apps.findOne(id);
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

  @UseGuards(JwtAuthGuard)
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
