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

const timeProofStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname || '') || '';
    cb(null, `time-${randomUUID()}${ext}`);
  },
});

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
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
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

  /** Сотрудник прикладывает доказательство присутствия (видео/фото). */
  @Post('proofs')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: timeProofStorage,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10) }, // 50MB
    }),
  )
  uploadProof(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Файл не загружен');
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

  @Get('team')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  teamStatus() {
    return this.svc.teamStatus();
  }
}
