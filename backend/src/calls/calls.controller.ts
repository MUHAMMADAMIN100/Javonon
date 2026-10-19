import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CallsService, CreateCallDto } from './calls.service';
import { isElevated, roleAllows } from '../auth/role-utils';

/** Все звонки и статистика: руководство по должности, роль — «Звонки всех и статистика». */
const seesAllCalls = (me: any) => roleAllows(me, 'calls:all', () => isElevated(me));
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';
import { Permissions } from '../auth/permissions.decorator';

/** Парс начала периода: YYYY-MM-DD как полночь Asia/Dushanbe. */
function parseFrom(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = tjParseLocalDate(v);
  if (isNaN(d.getTime())) throw new BadRequestException('Некорректная дата');
  return d;
}

/** Парс конца периода: YYYY-MM-DD как 23:59:59.999 Asia/Dushanbe
 *  (иначе последний день выпадает из выборки — см. finance/attendance). */
function parseTo(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = tjParseLocalDateEnd(v);
  if (isNaN(d.getTime())) throw new BadRequestException('Некорректная дата');
  return d;
}

@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallsController {
  constructor(private svc: CallsService) {}

  /** Залогировать звонок (и звонок из CRM пишет сюда же). */
  @Permissions('calls:create', 'calls:dial')
  @Post()
  create(@CurrentUser() me: any, @Body() dto: CreateCallDto) {
    return this.svc.create(me.id, dto);
  }

  /** Список звонков. mine=true → только свои. Иначе ADMIN видит все. */
  @Permissions('calls:read')
  @Get()
  list(
    @CurrentUser() me: any,
    @Query('mine') mine?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // Elevated (FOUNDER/ADMIN/ACCOUNTANT с мульти-роли) видит любые
    // звонки / по фильтру; остальные — только свои.
    const elevated = seesAllCalls(me);
    const effectiveUserId =
      mine === 'true' || !elevated ? me.id : userId || undefined;
    return this.svc.list({
      userId: effectiveUserId,
      from: parseFrom(from),
      to: parseTo(to),
    });
  }

  /** Статистика звонков по команде — только ADMIN. */
  @Permissions('calls:all')
  @Get('stats')
  stats(@CurrentUser() me: any, @Query('from') from?: string, @Query('to') to?: string) {
    // Elevated (ТЗ §2 мульти-роли).
    if (!seesAllCalls(me)) {
      throw new BadRequestException('Статистика доступна только администрации');
    }
    return this.svc.stats({ from: parseFrom(from), to: parseTo(to) });
  }

  @Permissions('calls:delete')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.remove(id, me.id, seesAllCalls(me));
  }
}
