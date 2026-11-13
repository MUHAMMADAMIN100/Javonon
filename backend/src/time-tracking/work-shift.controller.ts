import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { WorkShiftService } from './work-shift.service';

/**
 * Смена «как в Sabt» (13.11.2026). Свои данные — любому сотруднику; смены
 * команды — основатель и роль с «Посещаемость»; решения по просьбам и
 * отгулы — основатель и роль с «Причины опозданий — одобрение».
 * Приход и уход — прежние POST /time/clock-in и /time/clock-out.
 */
@Controller('shift')
@UseGuards(JwtAuthGuard)
export class WorkShiftController {
  constructor(private readonly svc: WorkShiftService) {}

  @Get('my')
  my(@CurrentUser() me: any) {
    return this.svc.my(me.id);
  }

  @Get('my-month')
  myMonth(@CurrentUser() me: any, @Query('ym') ym?: string) {
    return this.svc.myMonth(me.id, ym);
  }

  @Post('pause')
  pause(@CurrentUser() me: any, @Body() body: { kind?: 'LUNCH' | 'WORK' | 'PERSONAL' }) {
    return this.svc.pause(me.id, body?.kind as any);
  }

  @Post('resume')
  resume(@CurrentUser() me: any) {
    return this.svc.resume(me.id);
  }

  @Post('notices')
  createNotice(@CurrentUser() me: any, @Body() body: { date?: string; time?: string; reason?: string }) {
    return this.svc.createNotice(me.id, body || {});
  }

  @Get('notices/my')
  myNotices(@CurrentUser() me: any) {
    return this.svc.myNotices(me.id);
  }

  @Get('notices')
  notices(@CurrentUser() me: any) {
    return this.svc.notices(me);
  }

  @Post('notices/:id/decide')
  decideNotice(@CurrentUser() me: any, @Param('id') id: string, @Body() body: { approve?: boolean }) {
    return this.svc.decideNotice(id, body?.approve === true, me);
  }

  @Post('edits')
  requestEdit(@CurrentUser() me: any, @Body() body: { date?: string; field?: string; time?: string; note?: string }) {
    return this.svc.requestEdit(me.id, body || {});
  }

  @Get('edits/my')
  myEdits(@CurrentUser() me: any) {
    return this.svc.myEdits(me.id);
  }

  @Get('edits')
  edits(@CurrentUser() me: any) {
    return this.svc.edits(me);
  }

  @Post('edits/:id/decide')
  decideEdit(@CurrentUser() me: any, @Param('id') id: string, @Body() body: { approve?: boolean }) {
    return this.svc.decideEdit(id, body?.approve === true, me);
  }

  @Post('absences')
  setAbsence(@CurrentUser() me: any, @Body() body: { userId?: string; date?: string; kind?: any }) {
    return this.svc.setAbsence(me, body || {});
  }

  @Delete('absences/:userId/:date')
  removeAbsence(@CurrentUser() me: any, @Param('userId') userId: string, @Param('date') date: string) {
    return this.svc.removeAbsence(me, userId, date);
  }

  @Get('team')
  team(@CurrentUser() me: any) {
    return this.svc.team(me);
  }

  @Get('month')
  month(@CurrentUser() me: any, @Query('ym') ym?: string) {
    return this.svc.month(me, ym);
  }
}
