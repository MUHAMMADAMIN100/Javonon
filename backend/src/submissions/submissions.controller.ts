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
import { Throttle } from '@nestjs/throttler';
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
    @CurrentUser() me: any,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('managerId') managerId?: string,
    @Query('take') take?: string,
    @Query('firstApproved') firstApproved?: string,
    @Query('partnerId') partnerId?: string,
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
      firstApproved: firstApproved === 'true' || firstApproved === '1' ? true : undefined,
      partnerId: partnerId || undefined,
      // Нужен, чтобы решить, прикладывать ли партнёрский блок к строкам.
      viewer: me,
    });
  }

  /** FOUNDER/ADMIN — pending платежи на одобрение. */
  @Get('pending-payments')
  @Roles(Role.FOUNDER, Role.ADMIN)
  pending(@CurrentUser() me: any, @Query('partnerId') partnerId?: string) {
    return this.svc.listPendingPayments({
      partnerId: partnerId || undefined,
      // Нужен, чтобы решить, прикладывать ли партнёрский блок к строкам.
      viewer: me,
    });
  }

  /**
   * Кто привёл клиента — для формы создания сделки (чип «Клиент от
   * партнёра»). ТОЛЬКО ЧТЕНИЕ.
   *
   * РОЛИ ЗЕРКАЛЯТ POST /submissions: показывать связь обязан тот же круг
   * людей, который эту связь своим действием и создаёт. Да, сюда попадают
   * SALES_MANAGER/CLIENT_MANAGER, которым партнёрские данные закрыты во всех
   * остальных местах, — это осознанное исключение, объяснённое в
   * SubmissionsService.previewPartnerForClient. Ответ сужен до имени
   * партнёра, кода и суммы комиссии по одному вводимому клиенту.
   *
   * ОДНОГО @Roles ЗДЕСЬ НЕ ХВАТАЕТ, поэтому viewer уходит в сервис. Носителя
   * активной кастомной роли этот декоратор не удерживает: RolesGuard ставит
   * skipBaseRole и пускает по implicit-проверке URL, где на GET засчитывается
   * любой submissions:*, включая read-only submissions:read. Такая роль
   * («Таргетолог»/«SMM» с одним «Продажи — просмотр») дошла бы сюда, не имея
   * права оформить сделку, — то есть ровно мимо зеркала, заявленного выше.
   * Настоящий гейт — canPreviewDealFormPartner в сервисе; кастомной роли
   * по-прежнему нужен явный partners:read.
   *
   * ВНИМАНИЕ: маршрут обязан быть ВЫШЕ @Get(':id'), иначе Nest разберёт
   * 'partner-preview' как id сделки.
   *
   * `applicationId` — заявка-источник из адреса формы
   * (`/submissions/new?applicationId=…`), тот же параметр, который форма
   * пошлёт в POST /submissions. Без него превью и создание сделки разрешают
   * заявку по РАЗНЫМ правилам и называют разных партнёров — см.
   * previewPartnerForClient.
   *
   * СВОЙ ЛИМИТ, А НЕ ДЕФОЛТНЫЙ. Глобальный бакет — 60/мин (app.module.ts), то
   * есть ~3600 запросов в час: для подбора по списку известных номеров этого
   * с запасом хватает, а именно подбором эндпоинт и опасен (см. скоуп-гейт в
   * previewPartnerForClient). 10/мин рассчитаны на реальную форму: телефон
   * дебаунсится 400 мс, ответ живёт в react-query 5 минут по ключу
   * «режим + идентичность клиента», retry выключен — то есть на одну
   * заполняемую сделку приходятся единицы запросов, а не десятки.
   *
   * Имя бакета — 'default': ThrottlerGuard обходит только те throttler'ы,
   * что объявлены в ThrottlerModule (там он один), поэтому выдуманное имя
   * было бы молча проигнорировано. Пересечения с другими маршрутами нет —
   * ключ бакета включает класс и хендлер. FOUNDER/ADMIN/ACCOUNTANT throttle
   * пропускают целиком (UserThrottlerGuard.shouldSkip), их этот лимит не
   * касается.
   */
  @Get('partner-preview')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
  partnerPreview(
    @CurrentUser() me: any,
    @Query('phone') phone?: string,
    @Query('studentId') studentId?: string,
    @Query('applicationId') applicationId?: string,
  ) {
    return this.svc.previewPartnerForClient({
      phone: phone || null,
      studentId: studentId || null,
      applicationId: applicationId || null,
      // Решает, отдавать ли партнёрский блок вообще (см. док-комментарий).
      viewer: me,
    });
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

  /** Редактирование платежа.
   *  - FOUNDER — любые платежи любой сделки, любой статус.
   *  - Менеджер (SALES_MANAGER / CLIENT_MANAGER / ADMIN) — только PENDING
   *    платежи своих сделок (ownership + status check в service). */
  @Patch('payments/:id')
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
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

  /** Редактирование сделки.
   *  - FOUNDER — любые сделки, любые поля.
   *  - Менеджер (SALES_MANAGER/CLIENT_MANAGER/ADMIN) — только свои сделки
   *    (ownership check в service). После первого APPROVE менеджер уже не
   *    может менять studentId, newStudent-snapshot или programId (заморожено). */
  @Patch(':id')
  @Roles(Role.FOUNDER, Role.ADMIN, Role.SALES_MANAGER, Role.CLIENT_MANAGER)
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
