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
import { CurrentUser } from '../auth/current-user.decorator';
import { SubmissionsService } from './submissions.service';
import { SubmissionStatus, SubmissionPaymentStatus } from '@prisma/client';

// Те же типы файлов что и в time-tracking (паспорт/контракт/чек).
const SUBMISSION_FILE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.pdf']);
const SUBMISSION_FILE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
]);

const submissionFileStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = (extname(file.originalname || '') || '').toLowerCase();
    cb(null, `sub-${randomUUID()}${ext}`);
  },
});

const submissionFileFilter: any = (_req: any, file: any, cb: any) => {
  const ext = (extname(file.originalname || '') || '').toLowerCase();
  if (!SUBMISSION_FILE_EXT.has(ext) || !SUBMISSION_FILE_MIME.has(file.mimetype)) {
    return cb(new Error(`Тип файла не разрешён: ${file.mimetype}. Допустимы JPG/PNG/WEBP/HEIC/PDF.`), false);
  }
  cb(null, true);
};

@Controller('submissions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SubmissionsController {
  constructor(private svc: SubmissionsService) {}

  /** Менеджер создаёт новую сделку. */
  @Post()
  create(@CurrentUser() me: any, @Body() body: any) {
    return this.svc.create(me.id, body);
  }

  /** Менеджер добавляет новый платёж в существующую сделку. */
  @Post(':id/payments')
  addPayment(@CurrentUser() me: any, @Param('id') id: string, @Body() body: any) {
    return this.svc.addPayment(me.id, id, body);
  }

  /** Менеджер — список своих сделок. */
  @Get('mine')
  listMine(@CurrentUser() me: any, @Query('status') status?: string) {
    const validStatus = status && ['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(status)
      ? (status as SubmissionStatus)
      : undefined;
    return this.svc.listMine(me.id, { status: validStatus });
  }

  /** Все сделки — для FOUNDER (или ADMIN). */
  @Get()
  list(
    @CurrentUser() me: any,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('managerId') managerId?: string,
    @Query('take') take?: string,
  ) {
    if (!['FOUNDER', 'ADMIN'].includes(me.role)) {
      // Не-FOUNDER видит только свои
      return this.svc.listMine(me.id, {});
    }
    return this.svc.listAll({
      status: status && ['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(status)
        ? (status as SubmissionStatus) : undefined,
      paymentStatus: paymentStatus && ['PENDING', 'APPROVED', 'REJECTED'].includes(paymentStatus)
        ? (paymentStatus as SubmissionPaymentStatus) : undefined,
      managerId: managerId || undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  /** FOUNDER — pending платежи на одобрение. */
  @Get('pending-payments')
  pending(@CurrentUser() me: any) {
    if (!['FOUNDER', 'ADMIN'].includes(me.role)) {
      throw new BadRequestException('Только FOUNDER может смотреть pending');
    }
    return this.svc.listPendingPayments();
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.svc.getOne(id);
  }

  /** FOUNDER одобряет платёж — атомарно создаёт Student/Application/Transaction. */
  @Post('payments/:id/approve')
  approve(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.approvePayment(id, me.id);
  }

  /** FOUNDER отклоняет платёж с причиной. */
  @Post('payments/:id/reject')
  reject(@CurrentUser() me: any, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.svc.rejectPayment(id, me.id, body?.reason || '');
  }

  /** Менеджер меняет статус всей сделки (COMPLETED / CANCELLED). */
  @Post(':id/status')
  changeStatus(@CurrentUser() me: any, @Param('id') id: string, @Body() body: { status: SubmissionStatus }) {
    return this.svc.changeStatus(me.id, id, body.status);
  }

  /** Загрузка файла (паспорт / контракт / чек / скрин депозита). */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: submissionFileStorage,
      fileFilter: submissionFileFilter,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10) }, // 50MB
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Файл не загружен');
    return {
      url: `/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
    };
  }
}
