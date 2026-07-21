import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { RevenueSchemeService } from './revenue-scheme.service';
import { CreateBucketDto } from './dto/create-bucket.dto';
import { UpdateBucketDto } from './dto/update-bucket.dto';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';

/**
 * Управление FOUNDER-editable схемой распределения выручки.
 * Чтение (GET) — FOUNDER + ADMIN (админу нужна видимость для отчётности).
 * Мутации — только FOUNDER. Reset требует подтверждения на UI.
 *
 * Throttle на всех мутациях — параллель с finance.controller.ts: даже
 * FOUNDER-токен, если утёк, не должен спамить BD writes. Per-user через
 * глобальный UserThrottlerGuard (common/user-throttler.guard.ts) — офис
 * за NAT не делит бакет. POST /reset ограничен строже (3/мин): это
 * once-in-a-blue-moon действие, которое в транзакции удаляет всю схему
 * и пере-сеет DEFAULT_SCHEME (7 buckets + 15 items) — цикл reset() под
 * ворованным токеном держал бы Postgres connection pool и валил бы
 * остальные запросы по таймауту.
 *
 * @CurrentUser пробрасывается на каждую мутацию, чтобы сервис мог писать
 * actor.id/actor.role в ActivityLog. До audit-fix'а сервис литерально не
 * знал, кто его вызывает: /activity показывал пустоту даже после reset'а,
 * который сносит весь Фонд оплаты труда с именованными зарплатами. См.
 * RevenueSchemeService.reset и audit HIGH.
 */
@Controller('admin/revenue-scheme')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RevenueSchemeController {
  constructor(private svc: RevenueSchemeService) {}

  @Get()
  @Roles(Role.FOUNDER, Role.ADMIN)
  getActive() {
    return this.svc.getActive();
  }

  @Post('buckets')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles(Role.FOUNDER)
  createBucket(@Body() dto: CreateBucketDto, @CurrentUser() me: any) {
    return this.svc.createBucket(dto, { id: me?.id, role: me?.role });
  }

  @Patch('buckets/:id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles(Role.FOUNDER)
  updateBucket(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateBucketDto,
    @CurrentUser() me: any,
  ) {
    return this.svc.updateBucket(id, dto, { id: me?.id, role: me?.role });
  }

  @Delete('buckets/:id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles(Role.FOUNDER)
  deleteBucket(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() me: any,
  ) {
    return this.svc.deleteBucket(id, { id: me?.id, role: me?.role });
  }

  @Post('buckets/:bucketId/items')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles(Role.FOUNDER)
  createItem(
    @Param('bucketId', new ParseUUIDPipe({ version: '4' })) bucketId: string,
    @Body() dto: CreateItemDto,
    @CurrentUser() me: any,
  ) {
    return this.svc.createItem(bucketId, dto, { id: me?.id, role: me?.role });
  }

  @Patch('items/:id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles(Role.FOUNDER)
  updateItem(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateItemDto,
    @CurrentUser() me: any,
  ) {
    return this.svc.updateItem(id, dto, { id: me?.id, role: me?.role });
  }

  @Delete('items/:id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles(Role.FOUNDER)
  deleteItem(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() me: any,
  ) {
    return this.svc.deleteItem(id, { id: me?.id, role: me?.role });
  }

  // reset() удаляет все buckets активной схемы и пересеет DEFAULT_SCHEME
  // (7 buckets + 15 items) внутри одного Prisma $transaction. Легитимный
  // сценарий — руками нажать «Сбросить к дефолту» раз в жизни проекта,
  // поэтому лимит поставлен жёстче, чем на обычные CRUD-мутации: 3/мин
  // хватает на человека, но убивает цикл reset() под скомпрометированным
  // FOUNDER-токеном, который иначе держал бы connection pool в занятом
  // состоянии и валил бы остальные запросы по timeout.
  @Post('reset')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Roles(Role.FOUNDER)
  reset(@CurrentUser() me: any) {
    return this.svc.reset({ id: me?.id, role: me?.role });
  }
}
