import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { FinanceService, CreateTransactionDto } from './finance.service';
import { TransactionCategory, TransactionType } from '@prisma/client';

// QA-fix #45/#46/#47: безопасный парсинг query-параметров для фильтров.
const VALID_TX_TYPES: TransactionType[] = ['INCOME', 'EXPENSE'];
const VALID_TX_CATEGORIES: TransactionCategory[] = [
  'TUITION_PAYMENT', 'ADDITIONAL_FEE', 'SALARY', 'RENT', 'UTILITIES',
  'MARKETING', 'OFFICE', 'OTHER_INCOME', 'OTHER_EXPENSE',
];
function parseDate(v: string | undefined, name: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new BadRequestException(`${name}: некорректная дата`);
  return d;
}
function parseTake(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new BadRequestException('take должен быть числом');
  if (n < 1) throw new BadRequestException('take должен быть >= 1');
  if (n > 1000) throw new BadRequestException('take не может превышать 1000');
  return n;
}

@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class FinanceController {
  constructor(private svc: FinanceService) {}

  @Get('transactions')
  list(
    @Query('type') type?: string,
    @Query('category') category?: string,
    @Query('studentId') studentId?: string,
    @Query('managerId') managerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    if (type && !VALID_TX_TYPES.includes(type as TransactionType)) {
      throw new BadRequestException('Неизвестный type');
    }
    if (category && !VALID_TX_CATEGORIES.includes(category as TransactionCategory)) {
      throw new BadRequestException('Неизвестная category');
    }
    return this.svc.list({
      type: type as TransactionType | undefined,
      category: category as TransactionCategory | undefined,
      studentId,
      managerId,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      take: parseTake(take),
    });
  }

  @Post('transactions')
  create(@Body() dto: CreateTransactionDto, @CurrentUser() me: any) {
    return this.svc.create(dto, me.id);
  }

  @Patch('transactions/:id')
  update(@Param('id') id: string, @Body() patch: Partial<CreateTransactionDto>) {
    return this.svc.update(id, patch);
  }

  @Delete('transactions/:id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Get('summary')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.summary({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  @Get('by-category')
  byCategory(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.byCategory({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  @Get('pending-payments')
  pendingPayments() {
    return this.svc.pendingPayments();
  }

  @Get('timeseries')
  timeseries(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('bucket') bucket?: 'day' | 'week' | 'month',
  ) {
    if (bucket && !['day', 'week', 'month'].includes(bucket)) {
      throw new BadRequestException('bucket: day | week | month');
    }
    return this.svc.timeseries({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      bucket,
    });
  }
}
