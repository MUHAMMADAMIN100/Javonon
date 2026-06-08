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
import { ApplicationStatus, Direction } from '@prisma/client';
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
  createFromLanding(@Body() dto: CreateApplicationDto & { ref?: string }) {
    return this.apps.create(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  list(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
    @Query('search') search?: string,
    @Query('mine') mine?: string,
    @Query('manager') manager?: string,
  ) {
    // QA-fix #45: validate enum query params (раньше bad value → 500).
    const VALID_STATUS = ['NEW', 'IN_PROGRESS', 'COMPLETED', 'DOCS_REVIEW', 'DOCS_SUBMITTED', 'PRE_ADMISSION', 'AWAITING_PAYMENT', 'ENROLLED'];
    const VALID_DIR = ['BACHELOR', 'MASTER', 'LANGUAGE', 'LANGUAGE_COLLEGE', 'LANGUAGE_BACHELOR', 'COLLEGE'];
    if (status && !VALID_STATUS.includes(status)) throw new BadRequestException('Неизвестный статус');
    if (direction && !VALID_DIR.includes(direction)) throw new BadRequestException('Неизвестное направление');
    // search cap: без него юзер мог запросить ?search=AAA...×100k →
    // ILIKE %AAA% сканировал бы всю Application таблицу с гигантским
    // паттерном. 200 символов хватит для любого реального поиска.
    if (search && search.length > 200) throw new BadRequestException('Поисковая строка слишком длинная');
    return this.apps.findAll({
      status: status as ApplicationStatus | undefined,
      direction: direction as Direction | undefined,
      search,
      mine: mine === 'true',
      managerUserId: manager || undefined,
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
