import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { FinanceService, CreateTransactionDto } from './finance.service';
import { TransactionCategory, TransactionType } from '@prisma/client';

@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class FinanceController {
  constructor(private svc: FinanceService) {}

  @Get('transactions')
  list(
    @Query('type') type?: TransactionType,
    @Query('category') category?: TransactionCategory,
    @Query('studentId') studentId?: string,
    @Query('managerId') managerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.list({
      type,
      category,
      studentId,
      managerId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      take: take ? parseInt(take, 10) : undefined,
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
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get('by-category')
  byCategory(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.byCategory({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
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
    return this.svc.timeseries({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      bucket,
    });
  }
}
