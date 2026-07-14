import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Logger, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { hasRole, isElevated } from '../auth/role-utils';
import { FinanceService, CreateTransactionDto } from './finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionCategory, TransactionType } from '@prisma/client';
import {
  tjStartOfMonth,
  tjEndOfMonth,
  tjStartOfYear,
  tjEndOfYear,
  tjParseLocalDate,
  tjParseLocalDateEnd,
  tjStartOfDay,
  tjYMD,
} from '../common/tj-time';

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
// endOfDay=true — если пришла date-only строка "YYYY-MM-DD" (её присылает
// <input type="date"> и наш календарный пикер), поднимаем её до конца
// суток 23:59:59.999 Asia/Dushanbe. Иначе `new Date("2026-01-31")` даёт
// 2026-01-31T00:00:00Z, а фильтр `date <= to` молча выкидывает всё с
// этой даты после полуночи UTC — целый последний день пропадал из
// summary/breakdown/timeseries/etc. Bug: менеджер смотрит на пирог и не
// видит платёж, зарегистрированный сегодня днём.
//
// TZ-fix (issue #4): раньше здесь стоял `new Date(v) + setUTCHours(23,…)`,
// что давало границу по UTC-суткам. Из-за offset UTC+5 в Душанбе
// «2026-01-31» на самом деле начинается в 19:00 UTC 30-го числа, поэтому
// фильтр с UTC-границами обрезал последние 5 часов суток TJT в каждом
// периоде — все finance-эндпоинты (summary/byCategory/timeseries/
// distribution/top-managers/income-*/transactions) давали цифры,
// расходящиеся на несколько часов реальных операций. Единый парсер
// через tjParseLocalDate/tjParseLocalDateEnd делает границы согласованными
// с остальным бэкендом (reports, salary, attendance, kpi и т.д.).
//
// Использовать endOfDay=true только для «правой» границы диапазона (to).
// Для `from` фактическое 00:00 TJT — это как раз то, что нужно.
function parseDate(
  v: string | undefined,
  name: string,
  endOfDay = false,
): Date | undefined {
  if (!v) return undefined;
  const d = endOfDay ? tjParseLocalDateEnd(v) : tjParseLocalDate(v);
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
//
// TZ-fix: явные границы парсим tjParseLocalDate / tjParseLocalDateEnd —
// иначе `new Date('2026-01-31')` даёт UTC-полночь и «крадёт» первые
// 5 часов дня в Душанбе (`from` теряет утро, `to` тянет за собой первые
// 5 часов следующих суток). Остальные controllers (attendance / kpi /
// reports / salary / time-tracking / penalties / daily-reports) уже
// используют этот путь — здесь приводим в соответствие.
const VALID_PERIODS = new Set(['day', 'week', 'month', 'quarter', 'year', 'all']);
function resolveRange(
  period: string | undefined,
  from: string | undefined,
  to: string | undefined,
): { from?: Date; to?: Date } {
  // Пустая строка (?from=&to=2026-01-31) должна означать «не задано»,
  // а не «валидная граница undefined» — поэтому нормализуем сначала.
  const rawFrom = from && from.trim() !== '' ? from.trim() : undefined;
  const rawTo = to && to.trim() !== '' ? to.trim() : undefined;
  if (rawFrom || rawTo) {
    let explicitFrom: Date | undefined;
    let explicitTo: Date | undefined;
    if (rawFrom) {
      explicitFrom = tjParseLocalDate(rawFrom);
      if (isNaN(explicitFrom.getTime())) {
        throw new BadRequestException('from: некорректная дата');
      }
    }
    if (rawTo) {
      explicitTo = tjParseLocalDateEnd(rawTo);
      if (isNaN(explicitTo.getTime())) {
        throw new BadRequestException('to: некорректная дата');
      }
    }
    // Если пришёл только `from` — верхнюю границу закрываем «сейчас»,
    // чтобы поведение было консистентно с period-веткой (там всегда
    // возвращаются обе границы). Без этого Prisma получала бы {gte: X}
    // без верхнего предела — молча включаются будущие даты, если
    // менеджер по ошибке поставил их в форме создания транзакции.
    if (explicitFrom && !explicitTo) {
      explicitTo = new Date();
    }
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
  // period=month / period=year — это КАЛЕНДАРНЫЙ месяц/год Asia/Dushanbe,
  // а не скользящее «-30/-365 дней». Ранее использовались
  // Date.prototype.setMonth / setFullYear, что давало сразу два бага:
  //  (1) операции работают в TZ процесса (Railway = UTC) → все границы
  //      съезжают на 5 часов относительно ожиданий FOUNDER'а;
  //  (2) у setMonth есть month-length overflow — 31 марта минус месяц
  //      даёт «3 марта», а не «начало февраля».
  // На 14 июля отчёт «за месяц» молча включал половину июня и терял
  // последние две недели июля.
  if (p === 'month') {
    return { from: tjStartOfMonth(now), to: tjEndOfMonth(now) };
  }
  if (p === 'year') {
    return { from: tjStartOfYear(now), to: tjEndOfYear(now) };
  }
  // day / week / quarter — базой берём полночь Asia/Dushanbe, а не
  // «сейчас в TZ процесса». Раньше здесь работали `Date.prototype.setDate` /
  // `setMonth` на объекте, склонированном из `now`; они оперируют в TZ
  // процесса (Railway = UTC), поэтому:
  //   • `day` в 00:30 субботы TJT (= 19:30 пятницы UTC) возвращал начало
  //     пятницы UTC = ~05:00 пятницы TJT, теряя ночные продажи;
  //   • `week` / `quarter` уносили нижнюю границу на 5 часов относительно
  //     полуночи Душанбе — в срез попадал «хвост» прошлых суток.
  // Sec: сутки в Asia/Dushanbe всегда 24ч (UTC+5, без DST), поэтому
  // `week` — это `todayStart - 7 * 24h` (fixed-offset arithmetic — не
  // трогаем `setDate`, чтобы не проваливаться в UTC-семантику снова).
  // Для `quarter` арифметику ведём по Y/M/D wall-clock через tjYMD:
  // `setMonth` в UTC-Date переносит 31 мая на «1 марта» из-за
  // month-length overflow, а нам нужна дата начала квартала на
  // календаре Душанбе (с клэмпом дня по длине целевого месяца).
  const todayStart = tjStartOfDay(now);
  let start: Date = todayStart;
  if (p === 'week') {
    start = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (p === 'quarter') {
    const { y, m, d } = tjYMD(now);
    let qy = y;
    let qm = m - 3;
    while (qm < 1) {
      qm += 12;
      qy -= 1;
    }
    // Клэмп дня по длине целевого месяца — Date.UTC(y, m_1based, 0) даёт
    // последний день месяца m (без риска пересечения DST, т.к. считаем
    // сугубо календарь). Иначе «31 мая → -3 мес» = «3 марта».
    const dim = new Date(Date.UTC(qy, qm, 0)).getUTCDate();
    const qd = Math.min(d, dim);
    const mm = String(qm).padStart(2, '0');
    const dd = String(qd).padStart(2, '0');
    start = new Date(`${qy}-${mm}-${dd}T00:00:00+05:00`);
  }
  // 'day' → start остаётся todayStart (полночь TJT).
  return { from: start, to: now };
}

// Порог алерта: если один recordedById создал больше N INCOME строк
// за короткое окно — уведомляем админов. Меньше жёсткого throttle
// (20/мин), но выше нормального ручного потока (менеджер физически
// не заносит 10 продаж за 5 минут). Ловит распределённый спам
// «под throttle» и bonus-inflation через украденный токен. Значения
// параметризованы, чтобы бухгалтерия могла отрегулировать без пересборки.
const INCOME_SPAM_WINDOW_MS = parseInt(
  process.env.FINANCE_SPAM_WINDOW_MS || String(5 * 60_000),
  10,
);
const INCOME_SPAM_THRESHOLD = parseInt(
  process.env.FINANCE_SPAM_THRESHOLD || '10',
  10,
);

@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'ACCOUNTANT')
export class FinanceController {
  private readonly logger = new Logger(FinanceController.name);

  constructor(
    private svc: FinanceService,
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

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
      to: parseDate(to, 'to', true),
      take: parseTake(take),
    });
  }

  // POST /finance/transactions — доход менеджеры могут вносить сами
  // (SALES_MANAGER закрывает продажу, CLIENT_MANAGER берёт доплату у
  // студента). Расход по-прежнему — только FOUNDER / ADMIN / ACCOUNTANT,
  // чтобы менеджер не мог фиктивной EXPENSE подрезать чистую прибыль
  // (а значит и премии). FOUNDER имеет неявный доступ через RolesGuard.
  //
  // Sec: жёсткий throttle 20/мин перекрывает глобальный 60/мин из
  // AppModule. Без него менеджер (или украденный менеджерский токен)
  // мог за минуту накидать десятки INCOME строк по 1_000_000 и
  // перекосить topManagers / salary-engine на миллионы. Дополнительно
  // после каждой созданной INCOME строки считаем плотность записей
  // этого recordedById в скользящем окне — если превышен порог, ловим
  // распределённый спам «под лимит» и уведомляем админов.
  //
  // NB: FOUNDER / ADMIN / ACCOUNTANT throttle НЕ касается — см.
  // UserThrottlerGuard.shouldSkip. Это парная фикса к тому, что
  // finance.service.ts отдельно снимает окно дат ±3 суток для elevated
  // ролей (закрытие месяца, импорт истории из старых Google-таблиц):
  // если бы 20/min лимит применялся и к ним, date-window exemption
  // становился бесполезен — 5000-строчный импорт занимал бы 4+ часа
  // babysitting'а 429-loop'а. Bonus-inflation guard сохраняется,
  // потому что SALES_MANAGER / CLIENT_MANAGER не elevated.
  //
  // Per-user, а не per-IP: см. common/user-throttler.guard.ts — глобально
  // ThrottlerGuard заменён на UserThrottlerGuard, который трекает по
  // req.user.id. Иначе весь офис за NAT делил бы один бакет и первые 20
  // транзакций подряд от кого угодно клали бы всех остальных.
  @Post('transactions')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles('ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER')
  async create(@Body() dto: CreateTransactionDto, @CurrentUser() me: any) {
    if (dto?.type === 'EXPENSE' && !hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT')) {
      throw new ForbiddenException('Только ADMIN / ACCOUNTANT / FOUNDER могут вносить расходы');
    }
    // Audit-fix: передаём actor с реальным флагом isElevated, чтобы сервис
    // мог форсить self-attribute для менеджеров (иначе SALES_MANAGER мог
    // бы указать любой managerId в dto — bonus inflation).
    // `role` пробрасываем в ActivityLog.actorRole — без неё FOUNDER не мог
    // отфильтровать /activity по «FINANCE_CREATE от SALES_MANAGER».
    const tx = await this.svc.create(dto, me.id, {
      id: me.id,
      role: me?.role,
      isElevated: isElevated(me),
    });
    // Спам-детектор для INCOME. fire-and-forget: даже если ветка алерта
    // упадёт, ответ клиенту не должен ломаться. Ошибки логируем — иначе
    // silent .catch() «съел» бы всё.
    if (dto?.type === 'INCOME') {
      this.checkIncomeSpam(me.id).catch((err) =>
        this.logger.error(`spam-check failed: ${err?.message || err}`),
      );
    }
    return tx;
  }

  /**
   * Считает INCOME записи текущего recordedById за скользящее окно.
   * Если превышен порог — уведомляет ADMIN/ACCOUNTANT и пишет в лог.
   */
  private async checkIncomeSpam(recordedById: string): Promise<void> {
    const since = new Date(Date.now() - INCOME_SPAM_WINDOW_MS);
    const count = await this.prisma.transaction.count({
      where: {
        recordedById,
        type: 'INCOME',
        createdAt: { gte: since },
      },
    });
    if (count < INCOME_SPAM_THRESHOLD) return;
    const windowMin = Math.round(INCOME_SPAM_WINDOW_MS / 60_000);
    this.logger.warn(
      `INCOME spam suspected: recordedById=${recordedById} wrote ${count} rows in last ${windowMin}m`,
    );
    // Уведомляем только админов, а не всех сотрудников — чтобы не спамить
    // менеджерский чат. notifyAdmins уже покрывает ACCOUNTANT.
    try {
      await this.notifications.notifyAdmins({
        type: 'FINANCE_INCOME_SPAM',
        title: 'Подозрение на спам INCOME-записей',
        message: `Пользователь ${recordedById} создал ${count} INCOME-транзакций за ${windowMin} мин. Проверьте bonus-инфляцию.`,
        payload: { recordedById, count, windowMin },
      });
    } catch (err: any) {
      // Не критично — throttle уже удержал основной удар. Просто в лог.
      this.logger.error(`notifyAdmins failed: ${err?.message || err}`);
    }
  }

  // Тот же throttle что и на POST — PATCH тоже спамится: атакующий
  // может репутационно раздувать amount у уже существующих строк,
  // не создавая новые. 20 правок/мин на пользователя (per-user
  // обеспечивает UserThrottlerGuard в AppModule; см. коммент на POST).
  @Patch('transactions/:id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  update(
    @Param('id') id: string,
    @Body() patch: Partial<CreateTransactionDto>,
    @CurrentUser() me: any,
  ) {
    // Передаём actor, чтобы service мог enforce'ить date-bounds
    // (INCOME не может быть в будущем; менеджерам — ±3 суток).
    // Сейчас PATCH доступен только ADMIN/ACCOUNTANT (см. Roles на
    // контроллере), но передаём actor честно — если PATCH когда-то
    // откроют менеджерам, окно уже будет работать.
    // `role` — для ActivityLog.actorRole (FINANCE_UPDATE /
    // TRANSACTION_MANAGER_CHANGE), без него FOUNDER не мог бы фильтровать
    // /activity по роли автора правки.
    return this.svc.update(id, patch, {
      id: me.id,
      role: me?.role,
      isElevated: isElevated(me),
    });
  }

  @Delete('transactions/:id')
  remove(@Param('id') id: string, @CurrentUser() me: any) {
    // Передаём actor, чтобы FINANCE_DELETE в ActivityLog содержал имя
    // и роль удалившего. Без этого FOUNDER увидел бы факт удаления
    // только через emit + мог только грепом по логам искать автора.
    return this.svc.remove(id, {
      id: me.id,
      role: me?.role,
      isElevated: isElevated(me),
    });
  }

  @Get('summary')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.summary({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
    });
  }

  @Get('by-category')
  byCategory(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.byCategory({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
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
      to: parseDate(to, 'to', true),
      bucket,
    });
  }

  /** Распределение 70/20/10 — рекомендация куда направить чистую прибыль. */
  @Get('distribution')
  distribution(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.distribution({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
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
      to: parseDate(to, 'to', true),
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Источники дохода — новые клиенты / доплаты / вложения. */
  @Get('income-sources')
  incomeSources(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.incomeSources({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
    });
  }

  /** Доход по продуктовым категориям. */
  @Get('income-by-product')
  incomeByProduct(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.incomeByProduct({
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to', true),
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
   *
   * Sec: throttle 20 uploads/мин. Без него можно spam'ить 20MB файлы
   * и забить диск, плюс генерировать URL для прикрепления к спамным
   * INCOME строкам (маскирует фиктивные записи как «с чеком»).
   */
  @Post('receipts')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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
