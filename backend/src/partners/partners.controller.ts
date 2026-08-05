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

  /**
   * Подтвердить начисление к выплате (PENDING → APPROVED). Денег не двигает,
   * но без него партнёр не может запросить выплату: requestPayout выдаёт
   * только подтверждённую часть баланса (partners.service.ts,
   * approvedWithdrawableCents).
   *
   * Роли — FOUNDER/ADMIN, как у POST/DELETE партнёра, а не class-default с
   * ACCOUNTANT'ом: это АВТОРИЗАЦИЯ расхода («да, эти деньги партнёр
   * заработал»), а не его проведение. Проведение — commissions/:id/pay и
   * payouts/:id/pay — остаётся бухгалтеру.
   */
  @Post('commissions/:id/approve')
  @Roles('FOUNDER', 'ADMIN')
  approveCommission(@Param('id') id: string) {
    return this.svc.adminApproveCommission(id);
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
   * Карточка партнёра. Роли — FOUNDER/ADMIN/ACCOUNTANT, то есть ровно
   * class-level default.
   *
   * ПОЧЕМУ ACCOUNTANT ЗДЕСЬ ЕСТЬ (в отличие от POST/DELETE выше). Читать
   * карточку и менять партнёра — разные вещи, и раньше они разъехались в
   * обратную сторону: @Roles на методе НЕ объединяется с class-level, он его
   * ПЕРЕКРЫВАЕТ (RolesGuard → reflector.getAllAndOverride). Из-за этого
   * бухгалтер мог PATCH ':id' (наследует class-default) и не мог GET ':id'
   * — право писать без права читать.
   *
   * Плюс ACCOUNTANT входит в isElevated (FOUNDER/ADMIN/ACCOUNTANT), а именно
   * isElevated решает, показывать ли блок «Партнёр» на карточках студента и
   * заявки (students/applications.service.ts). Блок показывали, а его
   * единственная ссылка «Открыть карточку» вела в 403. При этом бухгалтер уже
   * видит партнёра в GET '' (список: имя, e-mail, реф-код, ставка, баланс,
   * начислено/выплачено) и сам же проводит выплаты — commissions/:id/pay,
   * payouts/:id/pay. Карточка не открывает ему ничего нового.
   *
   * Записи (POST/DELETE) остаются FOUNDER/ADMIN — создавать и удалять
   * партнёров бухгалтер по-прежнему не может.
   *
   * ВАЖНО: :id-роуты объявлены ПОСЛЕ commissions/* и payouts/* литералов
   * специально — чтобы Nest не поймал GET /commissions или /payouts как
   * :id=commissions/payouts. (Строго говоря, `:id` матчит только один
   * сегмент, поэтому /commissions/list не пересекается, но безопаснее
   * держать порядок.)
   */
  @Get(':id')
  @Roles('FOUNDER', 'ADMIN', 'ACCOUNTANT')
  adminGetOne(@Param('id') id: string) {
    return this.svc.adminGetOne(id);
  }

  /**
   * Пагинированный список атрибуций конкретного партнёра.
   * take: clamped 1..100 (default 20). skip: >=0 (default 0).
   *
   * Роли — те же, что и у GET ':id' выше (вкладка «Клиенты» той же карточки;
   * разъехавшиеся роли снова дали бы наполовину рабочую страницу). PII
   * клиентов в ответе (ФИО/телефон/e-mail студента и заявки) для ACCOUNTANT
   * не новость: GET /students/:id и GET /applications/:id ему уже открыты.
   */
  @Get(':id/attributions')
  @Roles('FOUNDER', 'ADMIN', 'ACCOUNTANT')
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
