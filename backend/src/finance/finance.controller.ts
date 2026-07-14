import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { hasRole } from '../auth/role-utils';
import { FinanceService, CreateTransactionDto } from './finance.service';
import { TransactionCategory, TransactionType } from '@prisma/client';

// Receipts: только изображения и PDF. Whitelist расширений и MIME —
// раньше можно было загрузить .exe/.html/.php (потенциальный XSS если
// файл потом отдаётся как static, либо исполнение кода на сервере).
const RECEIPT_ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.heic']);
const RECEIPT_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
]);

const receiptStorage = diskStorage({
  destination: process.env.UPLOADS_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = (extname(file.originalname || '') || '').toLowerCase();
    cb(null, `receipt-${randomUUID()}${ext}`);
  },
});

const receiptFileFilter: any = (_req: any, file: any, cb: any) => {
  const ext = (extname(file.originalname || '') || '').toLowerCase();
  if (!RECEIPT_ALLOWED_EXT.has(ext) || !RECEIPT_ALLOWED_MIME.has(file.mimetype)) {
    return cb(new BadRequestException(
      `Тип файла «${file.mimetype}» (${ext}) не разрешён. Допустимы: JPG, PNG, WEBP, HEIC, PDF.`,
    ), false);
  }
  cb(null, true);
};

// QA-fix #45/#46/#47: безопасный парсинг query-параметров для фильтров.
const VALID_TX_TYPES: TransactionType[] = ['INCOME', 'EXPENSE'];
const VALID_TX_CATEGORIES: TransactionCategory[] = [
  'TUITION_PAYMENT', 'ADDITIONAL_FEE', 'SALARY', 'RENT', 'UTILITIES',
  'MARKETING', 'OFFICE', 'OTHER_INCOME', 'OTHER_EXPENSE',
];
function parseDate(v: string | undefined, name: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new BadRequestException(`${name}: некорректная дата`);
  return d;
}
function parseTake(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new BadRequestException('take должен быть числом');
  if (n < 1) throw new BadRequestException('take должен быть >= 1');
  if (n > 1000) throw new BadRequestException('take не может превышать 1000');
  return n;
}

// Резолвим ?period=X в конкретный интервал {from, to}. Явные from/to
// (если пришли валидные) перебивают period — календарный пикер важнее
// пресетов. `all` возвращает пустой объект (без границ).
const VALID_PERIODS = new Set(['day', 'week', 'month', 'quarter', 'year', 'all']);
function resolveRange(
  period: string | undefined,
  from: string | undefined,
  to: string | undefined,
): { from?: Date; to?: Date } {
  const explicitFrom = parseDate(from, 'from');
  const explicitTo = parseDate(to, 'to');
  if (explicitFrom || explicitTo) {
    return { from: explicitFrom, to: explicitTo };
  }
  const p = (period || 'month').toLowerCase();
  if (!VALID_PERIODS.has(p)) {
    throw new BadRequestException(
      `period: должно быть одно из [${[...VALID_PERIODS].join(', ')}]`,
    );
  }
  if (p === 'all') return {};
  const now = new Date();
  const start = new Date(now);
  switch (p) {
    case 'day':
      start.setHours(0, 0, 0, 0);
      break;
    case 'week':
      start.setDate(now.getDate() - 7);
      break;
    case 'month':
      start.setMonth(now.getMonth() - 1);
      break;
    case 'quarter':
      start.setMonth(now.getMonth() - 3);
      break;
    case 'year':
      start.setFullYear(now.getFullYear() - 1);
      break;
  }
  return { from: start, to: now };
}

@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class FinanceController {
  constructor(private svc: FinanceService) {}

  @Get('transactions')
  list(
    @Query('type') type?: string,
    @Query('category') category?: string,
    @Query('studentId') studentId?: string,
    @Query('managerId') managerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
  ) {
    if (type && !VALID_TX_TYPES.includes(type as TransactionType)) {
      throw new BadRequestException('Неизвестный type');
    }
    if (category && !VALID_TX_CATEGORIES.includes(category as TransactionCategory)) {
      throw new BadRequestException('Неизвестная category');
    }
    return this.svc.list({
      type: type as TransactionType | undefined,
      category: category as TransactionCategory | undefined,
      studentId,
      managerId,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      take: parseTake(take),
    });
  }

  // POST /finance/transactions — доход менеджеры могут вносить сами
  // (SALES_MANAGER закрывает продажу, CLIENT_MANAGER берёт доплату у
  // студента). Расход по-прежнему — только FOUNDER / ADMIN / ACCOUNTANT,
  // чтобы менеджер не мог фиктивной EXPENSE подрезать чистую прибыль
  // (а значит и премии). FOUNDER имеет неявный доступ через RolesGuard.
  @Post('transactions')
  @Roles('ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER')
  create(@Body() dto: CreateTransactionDto, @CurrentUser() me: any) {
    if (dto?.type === 'EXPENSE' && !hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT')) {
      throw new ForbiddenException('Только ADMIN / ACCOUNTANT / FOUNDER могут вносить расходы');
    }
    return this.svc.create(dto, me.id);
  }

  @Patch('transactions/:id')
  update(@Param('id') id: string, @Body() patch: Partial<CreateTransactionDto>) {
    return this.svc.update(id, patch);
  }

  @Delete('transactions/:id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Get('summary')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.summary({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  @Get('by-category')
  byCategory(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.byCategory({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  @Get('pending-payments')
  pendingPayments() {
    return this.svc.pendingPayments();
  }

  @Get('timeseries')
  timeseries(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('bucket') bucket?: 'day' | 'week' | 'month',
  ) {
    if (bucket && !['day', 'week', 'month'].includes(bucket)) {
      throw new BadRequestException('bucket: day | week | month');
    }
    return this.svc.timeseries({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      bucket,
    });
  }

  /** Распределение 70/20/10 — рекомендация куда направить чистую прибыль. */
  @Get('distribution')
  distribution(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.distribution({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  /** Топ менеджеров по продажам — кто сколько принёс. */
  @Get('top-managers')
  topManagers(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.topManagers({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Источники дохода — новые клиенты / доплаты / вложения. */
  @Get('income-sources')
  incomeSources(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.incomeSources({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  /** Доход по продуктовым категориям. */
  @Get('income-by-product')
  incomeByProduct(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.incomeByProduct({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  /**
   * Три разреза (источник дохода / менеджер / категория расходов) одним
   * запросом. `period` — day | week | month | quarter | year | all
   * (по-умолчанию month). Опционально можно передать явные from/to,
   * которые перекроют period — удобно для календарного пикера.
   */
  @Get('breakdown')
  breakdown(
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveRange(period, from, to);
    return this.svc.breakdown(range);
  }

  /**
   * Загрузка чека/фото наличных. Возвращает URL для прикрепления
   * к транзакции при последующем POST /transactions.
   */
  @Post('receipts')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: receiptStorage,
      fileFilter: receiptFileFilter,
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '20971520', 10) }, // 20MB
    }),
  )
  uploadReceipt(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Файл не загружен');
    return {
      url: `/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
    };
  }
}
