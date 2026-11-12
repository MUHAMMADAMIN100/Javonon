import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { TimeTrackingService } from './time-tracking.service';
import { tjParseLocalDate, tjParseLocalDateEnd } from '../common/tj-time';
import { assertFileContent } from '../common/file-sniff';

// Подтверждение присутствия — фото или видео; причина опоздания — ещё и PDF
// (справка). QA-3 (BUG-29): окно предлагало «фото/видео», а сервер видео
// отклонял «Можно: JPG, PNG, WEBP, HEIC, PDF». Список — один на форму и
// сервер; содержимое проверяется после сохранения (assertFileContent).
// Раньше storage принимал любой тип файла (включая .exe/.html), что
// открывало stored-XSS если файл потом отдавался как static.
const TIME_PROOF_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.pdf', '.mp4', '.mov', '.webm', '.m4v', '.3gp',
]);
const TIME_PROOF_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp',
]);
const TIME_PROOF_HINT = 'Можно фото (JPG, PNG, WEBP, HEIC) или видео (MP4, MOV, WEBM)';

const timeProofStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = (extname(file.originalname || '') || '').toLowerCase();
    cb(null, `time-${randomUUID()}${ext}`);
  },
});

const timeProofFilter: any = (_req: any, file: any, cb: any) => {
  const ext = (extname(file.originalname || '') || '').toLowerCase();
  if (!TIME_PROOF_EXT.has(ext) || !TIME_PROOF_MIME.has(file.mimetype)) {
    return cb(new BadRequestException(`Этот файл не подходит. ${TIME_PROOF_HINT}; к причине опоздания — ещё PDF.`), false);
  }
  cb(null, true);
};

@Controller('time')
@UseGuards(JwtAuthGuard)
export class TimeTrackingController {
  constructor(private svc: TimeTrackingService) {}

  @Get('today')
  today(@CurrentUser() me: any) {
    return this.svc.getToday(me.id);
  }

  @Get('history')
  history(
    @CurrentUser() me: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.history(me.id, {
      from: from ? tjParseLocalDate(from) : undefined,
      to: to ? tjParseLocalDateEnd(to) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Post('clock-in')
  clockIn(
    @CurrentUser() me: any,
    @Body() body: { lat?: number; lon?: number; proofUrl?: string },
  ) {
    // Парсим числа на случай если фронт прислал строкой
    const lat = body.lat !== undefined ? Number(body.lat) : undefined;
    const lon = body.lon !== undefined ? Number(body.lon) : undefined;
    return this.svc.clockIn(me.id, {
      lat: typeof lat === 'number' && isFinite(lat) ? lat : undefined,
      lon: typeof lon === 'number' && isFinite(lon) ? lon : undefined,
      proofUrl: body.proofUrl,
    });
  }

  @Post('lunch-out')
  lunchOut(@CurrentUser() me: any) {
    return this.svc.lunchOut(me.id);
  }

  @Post('lunch-in')
  lunchIn(@CurrentUser() me: any) {
    return this.svc.lunchIn(me.id);
  }

  @Post('clock-out')
  clockOut(@CurrentUser() me: any) {
    return this.svc.clockOut(me.id);
  }

  /** Конец сегодняшнего рабочего дня по графику — CRM спрашивает «Уверены?» при раннем уходе (QA №55). */
  @Get('schedule-end')
  scheduleEnd(@CurrentUser() me: any) {
    return this.svc.myScheduledEnd(me.id);
  }

  /** Сотрудник прикладывает доказательство присутствия (видео/фото). */
  @Post('proofs')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: timeProofStorage,
      fileFilter: timeProofFilter,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10) }, // 50MB
    }),
  )
  uploadProof(@UploadedFile() file: Express.Multer.File, @Query('kind') kind?: string) {
    if (!file) throw new BadRequestException('Файл не загружен');
    // kind=excuse — причина опоздания (можно PDF-справку); иначе — подтверждение
    // присутствия: только фото или видео с места.
    if (kind === 'excuse') assertFileContent(file, ['image', 'video', 'pdf'], 'Файл к причине опоздания');
    else assertFileContent(file, ['image', 'video'], 'Подтверждение присутствия');
    return {
      url: `/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
    };
  }

  /** Сотрудник присылает оправдание опоздания. */
  @Post(':id/excuse')
  submitExcuse(
    @CurrentUser() me: any,
    @Param('id') id: string,
    @Body() body: { excuseUrl?: string; excuseReason?: string },
  ) {
    return this.svc.submitLateExcuse(me.id, id, body);
  }

  /** Сотрудник присылает оправдание позднего возвращения с обеда. */
  @Post(':id/lunch-excuse')
  submitLunchExcuse(
    @CurrentUser() me: any,
    @Param('id') id: string,
    @Body() body: { excuseUrl?: string; excuseReason?: string },
  ) {
    return this.svc.submitLunchLateExcuse(me.id, id, body);
  }

  /** Кто сейчас на работе — админ и бухгалтер (в CRM экрана нет, роли закрыто). */
  @Get('team')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  teamStatus() {
    return this.svc.teamStatus();
  }
}
