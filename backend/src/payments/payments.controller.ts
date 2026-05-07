import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { StudentJwtGuard } from '../student-auth/student-jwt.guard';
import { PaymentsService } from './payments.service';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

// Staff side
@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class PaymentsController {
  constructor(private svc: PaymentsService) {}

  @Get()
  list(@Query('status') status?: PaymentStatus) {
    return this.svc.listAll({ status });
  }

  @Post(':id/confirm')
  confirm(
    @Param('id') id: string,
    @CurrentUser() me: any,
    @Body() body: { actualAmount?: number; method?: PaymentMethod },
  ) {
    return this.svc.confirmByAccountant(id, me.id, body);
  }

  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @CurrentUser() me: any,
    @Body() body: { comment?: string },
  ) {
    return this.svc.rejectByAccountant(id, me.id, body.comment);
  }
}

// Student side
@Controller('student-payments')
@UseGuards(StudentJwtGuard)
export class StudentPaymentsController {
  constructor(private svc: PaymentsService) {}

  @Get()
  myList(@CurrentUser() user: any) {
    return this.svc.listForStudent(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: any,
    @Body() body: { amount: number; currency?: string; method?: PaymentMethod; comment?: string },
  ) {
    return this.svc.createByStudent(user.id, body);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.cancelByStudent(id, user.id);
  }
}
