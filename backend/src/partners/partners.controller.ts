import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PartnerJwtGuard } from './partner-jwt.guard';
import { PartnersService } from './partners.service';

@Controller('partner')
@UseGuards(PartnerJwtGuard)
export class PartnersController {
  constructor(private svc: PartnersService) {}

  /** Полный дашборд партнёра. */
  @Get('dashboard')
  dashboard(@Req() req: any) {
    return this.svc.dashboard(req.user.id);
  }

  @Get('commissions')
  commissions(@Req() req: any, @Query('limit') limit?: string) {
    return this.svc.listCommissions(req.user.id, {
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('payouts')
  payouts(@Req() req: any) {
    return this.svc.listPayouts(req.user.id);
  }

  @Post('payouts')
  requestPayout(
    @Req() req: any,
    @Body() body: { amountCents: number; method?: string; details?: string },
  ) {
    return this.svc.requestPayout(req.user.id, body);
  }
}

/** Админская часть — управление партнёрами. */
@Controller('admin/partners')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminPartnersController {
  constructor(private svc: PartnersService) {}

  @Get()
  list() {
    return this.svc.adminList();
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() patch: {
      commissionPct?: number;
      status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
      fullName?: string;
    },
  ) {
    return this.svc.adminUpdate(id, patch);
  }

  @Get('commissions/list')
  commissions(
    @Query('partnerId') partnerId?: string,
    @Query('status') status?: 'PENDING' | 'APPROVED' | 'PAID' | 'REVERSED',
  ) {
    return this.svc.adminListCommissions({ partnerId, status });
  }

  @Post('commissions/:id/pay')
  markCommissionPaid(@Param('id') id: string) {
    return this.svc.adminMarkCommissionPaid(id);
  }

  @Get('payouts/list')
  payouts() {
    return this.svc.adminListPayouts();
  }

  @Post('payouts/:id/pay')
  payoutPay(@Param('id') id: string) {
    return this.svc.adminMarkPayout(id, 'paid');
  }

  @Post('payouts/:id/reject')
  payoutReject(@Param('id') id: string) {
    return this.svc.adminMarkPayout(id, 'rejected');
  }
}
