import {
  Body,
  Controller,
  Delete,
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
import { AdminPartnerCreateDto } from './dto/admin-partner.dto';

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
@Roles('ADMIN', 'ACCOUNTANT')
export class AdminPartnersController {
  constructor(private svc: PartnersService) {}

  @Get()
  list() {
    return this.svc.adminList();
  }

  /**
   * FOUNDER-side создание партнёра. Роли переопределяем на FOUNDER/ADMIN —
   * ACCOUNTANT (class-level default) сюда пускать не должны.
   */
  @Post()
  @Roles('FOUNDER', 'ADMIN')
  adminCreate(@Body() body: AdminPartnerCreateDto) {
    return this.svc.adminCreate(body);
  }

  /**
   * Удаление партнёра. Soft, если есть Commission/ReferralAttribution;
   * иначе hard. Роли — FOUNDER/ADMIN (ACCOUNTANT не может удалять партнёров).
   */
  @Delete(':id')
  @Roles('FOUNDER', 'ADMIN')
  adminDelete(@Param('id') id: string) {
    return this.svc.adminDelete(id);
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
  payouts(@Query('partnerId') partnerId?: string) {
    return this.svc.adminListPayouts({ partnerId });
  }

  @Post('payouts/:id/pay')
  payoutPay(@Param('id') id: string) {
    return this.svc.adminMarkPayout(id, 'paid');
  }

  @Post('payouts/:id/reject')
  payoutReject(@Param('id') id: string) {
    return this.svc.adminMarkPayout(id, 'rejected');
  }

  /**
   * Карточка партнёра. Роли — FOUNDER/ADMIN (тот же паттерн, что и у
   * POST/DELETE — ACCOUNTANT (class-default) сюда не пускаем).
   *
   * ВАЖНО: :id-роуты объявлены ПОСЛЕ commissions/* и payouts/* литералов
   * специально — чтобы Nest не поймал GET /commissions или /payouts как
   * :id=commissions/payouts. (Строго говоря, `:id` матчит только один
   * сегмент, поэтому /commissions/list не пересекается, но безопаснее
   * держать порядок.)
   */
  @Get(':id')
  @Roles('FOUNDER', 'ADMIN')
  adminGetOne(@Param('id') id: string) {
    return this.svc.adminGetOne(id);
  }

  /**
   * Пагинированный список атрибуций конкретного партнёра.
   * take: clamped 1..100 (default 20). skip: >=0 (default 0).
   */
  @Get(':id/attributions')
  @Roles('FOUNDER', 'ADMIN')
  adminGetAttributions(
    @Param('id') id: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const rawTake = Number(take);
    const rawSkip = Number(skip);
    const takeNum = Math.min(
      Math.max(Number.isFinite(rawTake) && rawTake > 0 ? Math.floor(rawTake) : 20, 1),
      100,
    );
    const skipNum = Math.max(
      Number.isFinite(rawSkip) && rawSkip > 0 ? Math.floor(rawSkip) : 0,
      0,
    );
    return this.svc.adminGetAttributions(id, takeNum, skipNum);
  }
}
