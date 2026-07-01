import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { SubmissionsService } from './submissions.service';
import { Role, SubmissionStatus, SubmissionPaymentStatus } from '@prisma/client';

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
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  create(@CurrentUser() me: any, @Body() body: any) {
    return this.svc.create(me.id, body);
  }

  /** Менеджер добавляет новый платёж в существующую сделку. */
  @Post(':id/payments')
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  addPayment(@CurrentUser() me: any, @Param('id') id: string, @Body() body: any) {
    return this.svc.addPayment(me.id, id, body);
  }

  /** Менеджер — список своих сделок. */
  @Get('mine')
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  listMine(@CurrentUser() me: any, @Query('status') status?: string) {
    const validStatus = status && ['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(status)
      ? (status as SubmissionStatus)
      : undefined;
    return this.svc.listMine(me.id, { status: validStatus });
  }

  /** Все сделки — только для FOUNDER/ADMIN (PII сделок: контракты, паспорта, e-mail студентов). */
  @Get()
  @Roles(Role.FOUNDER, Role.ADMIN)
  list(
    @CurrentUser() _me: any,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('managerId') managerId?: string,
    @Query('take') take?: string,
  ) {
    // Доступ ограничен @Roles(FOUNDER, ADMIN) на уровне декоратора —
    // ACCOUNTANT/менеджеры до сюда не дойдут. Раньше здесь был fallback на
    // listMine() для не-elevated, но он стал мёртвым кодом после
    // ужесточения ролей в рамках audit:edge-cases bug #32.
    return this.svc.listAll({
      status: status && ['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(status)
        ? (status as SubmissionStatus) : undefined,
      paymentStatus: paymentStatus && ['PENDING', 'APPROVED', 'REJECTED'].includes(paymentStatus)
        ? (paymentStatus as SubmissionPaymentStatus) : undefined,
      managerId: managerId || undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  /** FOUNDER/ADMIN — pending платежи на одобрение. */
  @Get('pending-payments')
  @Roles(Role.FOUNDER, Role.ADMIN)
  pending() {
    return this.svc.listPendingPayments();
  }

  /**
   * Просмотр конкретной сделки. FOUNDER/ADMIN видят любую; SALES_MANAGER/
   * CLIENT_MANAGER — только свою (фильтрация по managerId в сервисе).
   * ACCOUNTANT убран намеренно — содержит PII студента (паспорт, e-mail).
   */
  @Get(':id')
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  getOne(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.getOne(me, id);
  }

  /** FOUNDER одобряет платёж — атомарно создаёт Student/Application/Transaction. */
  @Post('payments/:id/approve')
  @Roles(Role.FOUNDER)
  approve(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.approvePayment(id, me.id);
  }

  /** FOUNDER отклоняет платёж с причиной. */
  @Post('payments/:id/reject')
  @Roles(Role.FOUNDER)
  reject(@CurrentUser() me: any, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.svc.rejectPayment(id, me.id, body?.reason || '');
  }

  /** FOUNDER редактирует платёж (amount/method/paidAt/файлы/notes). */
  @Patch('payments/:id')
  @Roles(Role.FOUNDER)
  updatePayment(@CurrentUser() me: any, @Param('id') id: string, @Body() body: any) {
    return this.svc.updatePayment(me, id, body);
  }

  /** FOUNDER удаляет платёж (с реверсом Transaction при APPROVED). */
  @Delete('payments/:id')
  @Roles(Role.FOUNDER)
  deletePayment(@CurrentUser() me: any, @Param('id') id: string) {
    return this.svc.deletePayment(me, id);
  }

  /** Менеджер меняет статус всей сделки (COMPLETED / CANCELLED).
   *  FOUNDER может закрывать ЛЮБУЮ сделку (включая orphan когда
   *  менеджер уволен и managerId стал null). */
  @Post(':id/status')
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  changeStatus(@CurrentUser() me: any, @Param('id') id: string, @Body() body: { status: SubmissionStatus }) {
    return this.svc.changeStatus(me, id, body.status);
  }

  /** FOUNDER редактирует сделку (контракт-файлы/сумма/валюта/notes + до
   *  первого одобрения — snapshot нового студента и programId). */
  @Patch(':id')
  @Roles(Role.FOUNDER)
  updateSubmission(@CurrentUser() me: any, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateSubmission(me, id, body);
  }

  /** Hard delete сделки — ТОЛЬКО FOUNDER. Удаляет связанные платежи
   *  каскадом. APPROVED Transaction'ы НЕ трогаются (они уже в финансах).
   *  Нужен для удаления тестовых/ошибочных сделок. */
  @Delete(':id')
  @Roles(Role.FOUNDER)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  /**
   * Загрузка файла (паспорт / контракт / чек / скрин депозита).
   * ACCOUNTANT убран из allowlist — у него нет права создавать submission,
   * значит и грузить файлы под submission'ы он не должен (disk-fill риск,
   * 50MB лимит). FOUNDER/ADMIN оставлены: могут редактировать чужие сделки.
   */
  @Post('upload')
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: submissionFileStorage,
      fileFilter: submissionFileFilter,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10) }, // 50MB
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Файл не загружен');
    // Возвращаем mimeType с сервера (multer уже провалидировал его через
    // submissionFileFilter). Раньше фронт брал mime только из File.type
    // браузера — для .heic в старых браузерах он бывает пустой, и Document
    // при APPROVE сохранялся с application/octet-stream.
    return {
      url: `/uploads/${file.filename}`,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    };
  }
}
