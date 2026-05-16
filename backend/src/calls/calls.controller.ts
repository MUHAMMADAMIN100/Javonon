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

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new BadRequestException('Некорректная дата');
  return d;
}

@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallsController {
  constructor(private svc: CallsService) {}

  /** Залогировать звонок. */
  @Post()
  create(@CurrentUser() me: any, @Body() dto: CreateCallDto) {
    return this.svc.create(me.id, dto);
  }

  /** Список звонков. mine=true → только свои. Иначе ADMIN видит все. */
  @Get()
  list(
    @CurrentUser() me: any,
    @Query('mine') mine?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // EMPLOYEE/ACCOUNTANT видят только свои; ADMIN — любые / по фильтру
    const isAdmin = me.role === 'ADMIN';
    const effectiveUserId =
      mine === 'true' || !isAdmin ? me.id : userId || undefined;
    return this.svc.list({
      userId: effectiveUserId,
      from: parseDate(from),
      to: parseDate(to),
    });
  }

  /** Статистика звонков по команде — только ADMIN. */
  @Get('stats')
  stats(@CurrentUser() me: any, @Query('from') from?: string, @Query('to') to?: string) {
    if (me.role !== 'ADMIN') {
      throw new BadRequestException('Статистика доступна только администратору');
    }
    return this.svc.stats({ from: parseDate(from), to: parseDate(to) });
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.remove(id, me.id, me.role === 'ADMIN');
  }
}
