import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimeTrackingService } from '../time-tracking/time-tracking.service';
import { PenaltiesService } from '../penalties/penalties.service';
import {
  tjEndOfMonth,
  tjLocalDay,
  tjParseLocalDate,
  tjParseLocalDateEnd,
  tjStartOfMonth,
} from '../common/tj-time';
import {
  MANAGER_BONUS_BANDS,
  ManagerBonusBand,
  computeManagerBonus,
} from '../common/bonus-bands';
import {
  MANAGER_BONUS_CURRENCY,
  effectiveManagerBonus,
  loadCountedPayments,
  managerBonusMonths,
  monthCoverageShare,
  nonTjsCounted,
} from '../common/manager-bonus-volume';

// Единая отчётная валюта модуля зарплат. Должна совпадать с
// REPORTING_CURRENCY из finance.service.ts — иначе финансовый и
// зарплатный модуль расходятся: finance считает выручку только в TJS,
// а зарплата брала бонусную базу из смешанных валют.
// Bonus-inflation-fix (продолжение aff8b00): SubmissionPayment.amount
// и Transaction.amount складывались без фильтра по валюте, а результат
// умножался на процент полосы (пороги полос заданы в TJS)
// и писался в SalaryRecord.bonusAmount с currency='TJS'. Один USD 5000
// контракт превращался в «5000 TJS» бонусной базы (в ~11 раз меньше
// корректной, либо в неверный tier). Т.к. SaleSubmission.currency
// @default("USD"), это фактически ломало каждую свежую сделку.
// SubmissionPayment не имеет собственного currency-поля, поэтому
// фильтруем через relation `submission.currency`.
//
// ЧЕСТНОСТЬ (fix follow-up): бонусная база считается ТОЛЬКО в TJS
// (schema SalaryRecord держит один scalar salesAmount / bonusAmount /
// currency — schema-change для per-currency payroll вне scope этого
// фикса). Не-TJS суммы больше НЕ дропаются молча — они возвращаются
// отдельным полем `nonTjsSales` (см. preview() ниже), по той же
// схеме что `nonTjsTotals` в finance.service.ts: фронт показывает
// «в периоде была ещё выручка в USD/EUR/… — обработайте вручную
// или конвертируйте в TJS вручную перед закрытием периода».
const SALARY_REPORTING_CURRENCY = MANAGER_BONUS_CURRENCY;

// Разбивка не-TJS продаж (по коду валюты → сумма в исходной валюте).
// Используется исключительно для отображения / audit — эти суммы НЕ
// участвуют в bonusAmount и netAmount, но и не теряются в тишине.
export type NonTjsSalesBreakdown = Record<string, number>;

/**
 * Сообщение отказа при повторном начислении за тот же период.
 * Отдаётся как 400. Локализованная подпись у этой ошибки на фронте —
 * ключ `salary.error.duplicatePeriod` (ru/tj в lib/i18n.tsx): CRM
 * сопоставляет её по коду 400 + совпадению текста и показывает свой
 * перевод, а не сырую строку бэкенда.
 */
const DUPLICATE_PERIOD_MESSAGE = 'Зарплата за этот период уже начислена';
const RECALC_PAID_MESSAGE = 'Выплаченную зарплату пересчитать нельзя';

/**
 * Сообщение при проигранной гонке SERIALIZABLE-транзакции после
 * исчерпания ретраев. Ключ на фронте — `salary.error.concurrent`.
 */
const CONCURRENT_WRITE_MESSAGE =
  'Расчёт не сохранён из-за одновременного запроса. Повторите попытку';

/** Сколько раз перезапускать SERIALIZABLE-транзакцию при 40001/P2034. */
const SERIALIZABLE_RETRIES = 3;

@Injectable()
export class SalaryService {
  constructor(
    private prisma: PrismaService,
    private timeSvc: TimeTrackingService,
    private penaltiesSvc: PenaltiesService,
  ) {}

  async list(filters: { userId?: string; from?: Date; to?: Date }) {
    return this.prisma.salaryRecord.findMany({
      where: {
        ...(filters.userId && { userId: filters.userId }),
        ...(filters.from && { periodStart: { gte: filters.from } }),
        ...(filters.to && { periodEnd: { lte: filters.to } }),
      },
      orderBy: { periodStart: 'desc' },
      include: { user: { select: { id: true, fullName: true, isActive: true, role: true, email: true } } },
    });
  }

  /**
   * Зарплата за период сразу по всем работающим сотрудникам — таблица на
   * странице «Зарплата». Каждая строка считается тем же preview(), что и
   * карточка одного человека: числа в таблице и в расчёте совпадают.
   * Считаем пачками по шесть, чтобы не занимать весь пул соединений.
   */
  async previewAll(periodStart: Date, periodEnd: Date) {
    const userSelect = {
      id: true, fullName: true, role: true, roles: true, baseSalary: true, hourlyRate: true, isActive: true,
    } as const;
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: userSelect,
      orderBy: { fullName: 'asc' },
    });
    // Уже начисленное за этот период — чтобы не начислить второй раз.
    const records = await this.prisma.salaryRecord.findMany({
      where: { periodStart: { gte: periodStart, lte: periodEnd } },
      orderBy: { createdAt: 'desc' },
    });
    const recordByUser = new Map<string, (typeof records)[number]>();
    for (const r of records) if (!recordByUser.has(r.userId)) recordByUser.set(r.userId, r);

    // УВОЛЕННЫЕ. Из всех списков они убраны, но зарплата — это долг: если в
    // периоде уволенный успел поработать или ему засчитаны продажи, строка
    // нужна, иначе расчёт при увольнении нечем начислить. Показываем ТОЛЬКО
    // за такие периоды (и за те, где начисление уже есть), с пометкой
    // «уволен»; за периоды после ухода его в таблице нет.
    const dismissed = await this.prisma.user.findMany({
      where: { isActive: false },
      select: userSelect,
      orderBy: { fullName: 'asc' },
    });
    if (dismissed.length) {
      const ids = dismissed.map((u) => u.id);
      const [worked, counted] = await Promise.all([
        this.prisma.timeEntry.groupBy({
          by: ['userId'],
          where: { userId: { in: ids }, date: { gte: periodStart, lte: periodEnd } },
          _count: { _all: true },
        }),
        loadCountedPayments(this.prisma, ids, { from: tjStartOfMonth(periodStart), to: tjEndOfMonth(periodEnd) }),
      ]);
      // Доплата за прошлые месяцы — тоже долг: платёж с датой оплаты в уже
      // рассчитанном месяце могли одобрить после увольнения.
      const withArrears = await Promise.all(
        ids.map(async (id) => ((await bonusArrearsMonths(this.prisma, id, periodStart)).length ? id : null)),
      );
      const owed = new Set<string>([
        ...worked.map((w) => w.userId),
        ...counted.map((c) => c.managerId),
        ...ids.filter((id) => recordByUser.has(id)),
        ...withArrears.filter((x): x is string => !!x),
      ]);
      users.push(...dismissed.filter((u) => owed.has(u.id)));
    }

    const rows: any[] = [];
    const CHUNK = 6;
    for (let i = 0; i < users.length; i += CHUNK) {
      const part = await Promise.all(
        users.slice(i, i + CHUNK).map(async (u) => {
          const rec = recordByUser.get(u.id) ?? null;
          // Начислено — показываем сохранённые числа, а не новый расчёт:
          // после начисления комиссия месяца уже выплачена, а штрафы
          // помечены применёнными, и пересчёт дал бы другую сумму.
          if (rec) {
            return {
              userId: u.id,
              user: { id: u.id, fullName: u.fullName, role: u.role, roles: u.roles, isActive: u.isActive },
              hasRate: (u.baseSalary || 0) > 0 || (u.hourlyRate || 0) > 0,
              workedMinutes: rec.workedMinutes,
              lateMinutes: rec.lateMinutes,
              baseAmount: rec.baseAmount,
              salesAmount: rec.salesAmount,
              bonusAmount: rec.bonusAmount,
              bonusPercent: rec.bonusPercent ?? null,
              kpiBonus: rec.kpiBonus,
              penalties: rec.penalties,
              penaltiesPending: 0,
              penaltiesExcused: 0,
              netAmount: rec.netAmount,
              currency: rec.currency,
              /** Доплата за прошлые месяцы, вошедшая в запись (уже в bonusAmount). */
              bonusArrearsAmount: recordArrearsAmount(rec),
              record: { id: rec.id, status: rec.status, netAmount: rec.netAmount, periodStart: rec.periodStart, periodEnd: rec.periodEnd },
            };
          }
          const p = await this.preview(u.id, periodStart, periodEnd, 0);
          return {
            userId: u.id,
            user: { id: u.id, fullName: u.fullName, role: u.role, roles: u.roles, isActive: u.isActive },
            /** Оклад или ставка заданы — иначе база всегда 0 и это стоит заметить. */
            hasRate: (u.baseSalary || 0) > 0 || (u.hourlyRate || 0) > 0,
            workedMinutes: p.workedMinutes,
            lateMinutes: p.lateMinutes,
            baseAmount: p.baseAmount,
            salesAmount: p.salesAmount,
            bonusAmount: p.bonusAmount,
            bonusPercent: p.bonusPercent,
            kpiBonus: 0,
            penalties: p.penalties,
            penaltiesPending: p.penaltiesPending,
            penaltiesExcused: p.penaltiesExcused,
            netAmount: p.netAmount,
            currency: p.currency,
            /** Доплата за прошлые месяцы (уже в bonusAmount). */
            bonusArrearsAmount: p.bonusArrearsAmount,
            record: null,
          };
        }),
      );
      rows.push(...part);
    }
    return { periodStart, periodEnd, rows };
  }

  /**
   * Считает (без сохранения) зарплату сотрудника за период:
   *   - hours/minutes — берём из TimeEntry за ЗАПРОШЕННЫЙ период
   *   - объём продаж (бонусная база) — сумма в сомони одобренных основателем
   *     платежей, засчитанных в КАЛЕНДАРНЫЙ МЕСЯЦ (Asia/Dushanbe) по месяцу
   *     оплаты. Правило и фильтры — только в common/manager-bonus-volume.ts.
   *   - доплата за прошлые месяцы — платежи с датой оплаты в уже
   *     рассчитанном месяце, одобренные после его расчёта (bonusArrearsMonths)
   *   - bonus = ВЕСЬ объём × ставка ОДНОЙ полосы (см. common/bonus-bands.ts:
   *     flat-по-полосе, не прогрессивно)
   *   - penalty — эффективные штрафы за период (не тронуты этой доработкой)
   *   - net = base + bonus + kpi − penalty
   *
   * ПЕРЕРАБОТКА (overtime) в расчёте больше НЕ участвует — убрана по
   * решению учредителя. Колонки SalaryRecord.overtimeMinutes / overtimePay
   * и TimeEntry.overtimeMinutes остались в схеме с историческими данными,
   * но ничего их не пишет и не читает. Штрафы — отдельная сущность,
   * остаются как были.
   *
   * ДВА ОКНА, ЭТО НАМЕРЕННО:
   *   - время/штрафы считаются за периодStart..periodEnd (что попросили);
   *   - продажи и бонус — строго за календарный месяц Asia/Dushanbe,
   *     содержащий periodStart. Так требует правило комиссии: полоса
   *     определяется МЕСЯЧНЫМ объёмом, иначе произвольный диапазон
   *     («две недели») занижал бы ставку. На практике окна совпадают:
   *     CRM по умолчанию открывает текущий месяц.
   */
  async preview(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    kpiBonus = 0,
    /**
     * Предпросмотр пересчёта: считать так, будто записи excludeRecordId нет,
     * а её штрафы (alsoAppliedPenaltyIds) снова не учтены, — ровно то, что
     * получится после recalculate().
     */
    opts: { excludeRecordId?: string; alsoAppliedPenaltyIds?: string[] } = {},
  ) {
    // Валидация дат: невалидные / неверный порядок / слишком далёкое будущее
    if (!(periodStart instanceof Date) || !(periodEnd instanceof Date) ||
        isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      throw new BadRequestException('Неверный формат даты периода');
    }
    if (periodStart > periodEnd) {
      throw new BadRequestException('Начало периода позже конца');
    }
    // Не даём считать зарплату за будущее (защита от опечаток + бесполезное).
    // Допускаем "до конца текущего месяца" — лимит +1 день в будущее.
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    if (periodStart > tomorrow) {
      throw new BadRequestException('Период начинается в будущем');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Сотрудник не найден');

    const time = await this.timeSvc.summaryForUser(userId, periodStart, periodEnd);

    // ИСТОЧНИК БОНУСНОЙ БАЗЫ — два разных «триггера»:
    //
    // 1) Платежи по сделкам (SubmissionPayment) — одобренные основателем, в
    //    месяц оплаты (paidAt); сумма — в сомони (у валютной сделки её вводит
    //    основатель при одобрении). Отбор — loadCountedPayments() в
    //    common/manager-bonus-volume.ts, общий с KPI и профилем.
    //    Transaction.date при этом тоже = paidAt, так что «Финансы» и бонус
    //    кладут одни и те же деньги в один и тот же месяц.
    //
    // 2) Ручные INCOME-транзакции (импорт / исторические данные /
    //    операции без сделки) — считаются по date и с новым правилом
    //    комиссии в объём полосы НЕ входят (ТЗ: «объём = одобренные
    //    платежи по заявкам»). Возвращаем их отдельным полем
    //    manualSalesAmount, чтобы бухгалтер видел их, а не гадал.
    //    Их легко отличить от платежей по сделкам по
    //    category != 'TUITION_PAYMENT' (approvePayment всегда пишет
    //    category='TUITION_PAYMENT'); такой фильтр гарантирует
    //    отсутствие двойного учёта с (1).
    //
    //    ИНВАРИАНТ: Transaction.category='TUITION_PAYMENT' ДОЛЖЕН
    //    происходить ТОЛЬКО из approvePayment (submissions.service /
    //    payments.service, оба пишут напрямую через prisma в рамках
    //    $transaction с SubmissionPayment). Ручное создание через
    //    FinanceService.create()/update() с этой категорией отклоняется
    //    (400) — см. одноимённый комментарий в finance.service.ts. Без
    //    инварианта возможна дивергенция Finance vs Salary: ручная
    //    INCOME-строка с category=TUITION_PAYMENT учитывается в
    //    finance.breakdown byManager, но НЕ входит в бонусную базу
    //    (tjsPaymentCandidates её не видит, потому что нет
    //    SubmissionPayment-строки; manualSalesAgg — потому что
    //    category=TUITION_PAYMENT). Итог для менеджера: доход виден в
    //    /finance, но бонус не начисляется.
    // Bug #25: после CANCEL сделки её APPROVED-платежи помечаются REJECTED
    // и связанная INCOME-транзакция получает reversedAt — оба фильтра ниже
    // исключают деньги отменённых сделок из бонусной базы автоматически.
    //
    // ANCHOR-PARITY-FIX (audit HIGH): salary раньше опирался ТОЛЬКО на
    // `submission.status != 'CANCELLED'`, а finance.breakdown/topManagers —
    // на `Transaction.reversedAt = null`. Два разных «якоря» на одну и ту
    // же семантику «деньги вернулись» → отчёты расходились в двух
    // сценариях:
    //   (A) CANCEL прошёл, но side-effect reversedAt по linked-tx не
    //       сработал (транзиентная ошибка, ручная отмена без submission-
    //       cancel) — finance всё ещё видит INCOME, salary уже обнулил
    //       бонус (submission=CANCELLED). Divergence.
    //   (B) Админ вручную поставил reversedAt на Transaction без cancel'а
    //       сделки (корректировка ошибочной записи) — finance исключает,
    //       salary всё ещё считает бонус. Обратная divergence.
    // Фикс: mirror'им ОБА якоря — submission != CANCELLED И linked
    // Transaction.reversedAt = null. Так salary и finance всегда сходятся
    // независимо от того, каким путём отмена случилась. То же самое
    // применяем и к non-TJS ветке ниже (иначе баланс валют разойдётся с
    // finance breakdown точно так же). Атомарность самого CANCEL'а
    // обеспечивается $transaction в submissions.service.ts (changeStatus).
    //
    // Prisma-relation между SubmissionPayment.financeTransactionId и
    // Transaction в schema.prisma не объявлена (только @unique-FK-поле),
    // поэтому nested-filter не сделать одним запросом. Делаем в 2 шага:
    // (1) выбираем матчащие платежи, (2) для тех, у кого есть
    // financeTransactionId, тянем set реверсированных tx-id и вычитаем.
    // Legacy-платежи без financeTransactionId (до того, как approvePayment
    // начал его писать) не имеют пары в Transaction — их не отфильтровываем
    // по reversedAt (в finance их тоже нет как reversed), они по-прежнему
    // считаются как valid bonus base, если submission не CANCELLED.
    //
    // BONUS-INFLATION-FIX (продолжение aff8b00): обе TJS-агрегации ниже —
    // жёсткий фильтр по TJS. Раньше суммы в USD/EUR/CNY/RUB складывались
    // с TJS как безразмерное число, а bonusAmount писался в SalaryRecord
    // с currency='TJS' (см. код ниже) — то есть USD 5000 приносили
    // менеджеру ~11× меньше корректного бонуса или падали не в тот
    // не в ту полосу (пороги полос заданы в TJS). Пока нет
    // FX-конвертации на write-time, не-TJS суммы НЕ участвуют в
    // bonusAmount / netAmount — та же политика, что в finance.service.ts
    // (REPORTING_CURRENCY=TJS). SubmissionPayment.amount не имеет
    // собственной валюты — она у родителя SaleSubmission (default USD),
    // фильтруем через relation.
    //
    // NON-TJS TRANSPARENCY (fix follow-up): не-TJS суммы за тот же
    // период отдельно собираются в `nonTjsSales` (по коду валюты) и
    // возвращаются в preview — это НЕ бонусная база, но и не
    // «молча выброшенные» деньги. Фронт показывает бухгалтеру:
    // «в периоде также была продажа USD 5000 — обработайте вручную».
    // Схема SalaryRecord держит один scalar salesAmount/bonusAmount —
    // полноценный per-currency payroll требует schema-миграции и вне
    // scope этого фикса (см. верхний комментарий про SALARY_REPORTING_CURRENCY).
    //
    // ОКНО ОБЪЁМА — КАЛЕНДАРНЫЙ МЕСЯЦ Asia/Dushanbe (не запрошенный
    // период), границы считаются через tj-time — см. комментарий
    // в common/manager-bonus-volume.ts.
    // ОБЪЁМ ДЛЯ ПОЛОСЫ = только APPROVED-платежи по сделкам (ТЗ):
    // «объём = сумма одобренных платежей по заявкам за календарный месяц».
    // Сами фильтры живут в common/manager-bonus-volume.ts — тот же расчёт
    // читает досье сотрудника (/me/full), чтобы менеджер и бухгалтер
    // видели ОДИН и тот же объём, полосу и процент.
    //
    // ПЕРИОД ДЛИННЕЕ МЕСЯЦА. Комиссия считается по КАЖДОМУ календарному
    // месяцу, который задевает период, и суммируется — см.
    // managerBonusMonths(). Раньше бралcя только месяц начала периода, и
    // за 1 июня – 1 сентября июль с августом пропадали молча.
    const bonusMonths = await managerBonusMonths(this.prisma, userId, periodStart, periodEnd);
    const bonusPeriodStart = bonusMonths[0]?.periodStart ?? tjStartOfMonth(periodStart);
    const bonusPeriodEnd =
      bonusMonths[bonusMonths.length - 1]?.periodEnd ?? tjEndOfMonth(periodStart);
    const salesAmount = round(bonusMonths.reduce((sum, m) => sum + m.volume, 0));

    // Ручные INCOME-транзакции (импорт / исторические данные / операции без
    // сделки) в бонусную базу по новому правилу НЕ входят — но и не
    // исчезают молча: отдаём их отдельным информационным полем, по той же
    // схеме, что nonTjsSales ниже. Если бухгалтеру нужно начислить за них
    // комиссию — это ручное решение, а не тихая прибавка к полосе.
    const manualSalesAgg = await this.prisma.transaction.aggregate({
      where: {
        managerId: userId,
        type: 'INCOME',
        category: { not: 'TUITION_PAYMENT' },
        date: { gte: bonusPeriodStart, lte: bonusPeriodEnd },
        reversedAt: null,
        currency: SALARY_REPORTING_CURRENCY,
      },
      _sum: { amount: true },
    });
    const manualSalesAmount = manualSalesAgg._sum.amount || 0;

    // Разбивка не-TJS продаж за тот же период: валютные платежи БЕЗ суммы в
    // сомони (одобрены до того, как её стали вводить) — из той же общей
    // выборки, что и объём, плюс валютные ручные приходы (groupBy по
    // currency). Валютный платёж С суммой в сомони уже сидит в объёме.
    const countedForMonths = await loadCountedPayments(this.prisma, [userId], {
      from: bonusPeriodStart,
      to: bonusPeriodEnd,
    });
    const nonTjsTransactionsAgg = await this.prisma.transaction.groupBy({
      by: ['currency'],
      where: {
        managerId: userId,
        type: 'INCOME',
        category: { not: 'TUITION_PAYMENT' },
        date: { gte: bonusPeriodStart, lte: bonusPeriodEnd },
        reversedAt: null,
        currency: { not: SALARY_REPORTING_CURRENCY },
      },
      _sum: { amount: true },
    });
    const nonTjsSales: NonTjsSalesBreakdown = { ...nonTjsCounted(countedForMonths) };
    for (const g of nonTjsTransactionsAgg) {
      const c = g.currency;
      nonTjsSales[c] = (nonTjsSales[c] || 0) + (g._sum.amount || 0);
    }
    for (const k of Object.keys(nonTjsSales)) {
      nonTjsSales[k] = round(nonTjsSales[k]);
    }
    // КОМИССИЯ МЕНЕДЖЕРА — flat-по-полосе (см. common/bonus-bands.ts).
    // Весь месячный объём умножается на ставку ОДНОЙ полосы, в которую он
    // попал. Не прогрессивно, срезы не складываются:
    //   200 000 → полоса 150 001–225 000 → 6% → 12 000 (а не 9 750).
    // Ставка у всех одна — по сетке. Персонального процента больше нет
    // (решение учредителя 2026-09-26); User.bonusPercent не читается.
    //
    // ОДИН МЕСЯЦ — одна полоса. НЕСКОЛЬКО — каждый месяц со своей полосой,
    // суммой. Ставку «за период целиком» не показываем: у трёх месяцев их
    // три, и одно число тут врало бы.
    const singleMonth = bonusMonths.length === 1 ? bonusMonths[0] : null;
    const bonusPercent = singleMonth ? singleMonth.percent : null;
    const band = singleMonth ? singleMonth.band : null;
    /** Комиссия за все задетые месяцы целиком. */
    const bonusMonthTotal = round(bonusMonths.reduce((sum, m) => sum + m.monthTotal, 0));

    // ЗАЩИТА ОТ ДВОЙНОГО НАЧИСЛЕНИЯ.
    // Зарплатных записей, задевающих один и тот же месяц, может быть
    // несколько (аванс + расчёт, две половины месяца, квартальный пересчёт
    // поверх месячных). Без вычета каждая начислила бы ПОЛНУЮ месячную
    // комиссию — менеджер получил бы её дважды.
    //
    // Уже начисленным для месяца считаем бонус записей, чей период этот
    // месяц ПЕРЕСЕКАЕТ. Вычет ограничен снизу нулём, поэтому пересчёт
    // никогда не отбирает выплаченное, а лишний захват соседних записей
    // может только недоплатить — и это видно на экране отдельной строкой,
    // в отличие от тихой двойной выплаты.
    //
    // ВНИМАНИЕ: здесь вычет — ТОЛЬКО ДЛЯ ПОКАЗА в калькуляторе. Гардом он
    // быть не может: preview читает, а create() пишет отдельным запросом, и
    // между ними ничего не стоит — два одновременных POST оба видели бы 0.
    // Настоящий bonusAmount, который уходит в БД, считается заново внутри
    // SERIALIZABLE-транзакции (insertRecordAtomically). Числа совпадают,
    // пока нет гонки; при гонке авторитетно значение из транзакции.
    const monthsWithDue: Array<{ month: (typeof bonusMonths)[number]; alreadyPaid: number; due: number }> = [];
    const paidPerMonth = await bonusPaidByMonth(this.prisma, userId, bonusMonths, opts.excludeRecordId);
    for (const m of bonusMonths) {
      const alreadyPaid = paidPerMonth.get(monthKey(m.periodStart)) ?? 0;
      monthsWithDue.push({
        month: m,
        alreadyPaid,
        due: Math.max(0, round(m.monthTotal - alreadyPaid)),
      });
    }
    const bonusAlreadyPaid = round(monthsWithDue.reduce((sum, x) => sum + x.alreadyPaid, 0));
    // ДОПЛАТА ЗА ПРОШЛЫЕ МЕСЯЦЫ: платежи с датой оплаты в уже рассчитанном
    // месяце, одобренные после его расчёта (см. bonusArrearsMonths).
    const arrears = await bonusArrearsMonths(this.prisma, userId, bonusPeriodStart, opts.excludeRecordId);
    const bonusArrearsAmount = round(arrears.reduce((sum, x) => sum + x.due, 0));
    /** К начислению сейчас = месячные комиссии минус уже начисленное плюс доплата за прошлые месяцы. */
    const bonusAmount = round(monthsWithDue.reduce((sum, x) => sum + x.due, 0) + bonusArrearsAmount);

    const baseSalary = user.baseSalary || 0;
    const hourlyRate = user.hourlyRate || 0;
    const hours = time.workedMinutes / 60;
    // ОКЛАД ПРОПОРЦИОНАЛЕН ДЛИНЕ ПЕРИОДА. baseSalary задан ЗА МЕСЯЦ, а
    // раньше подставлялся плоско, каким бы период ни был: за три месяца
    // начислялся один оклад, а два аванса по половине месяца приносили
    // ДВА полных — то есть двойную оплату. Считаем долю каждого задетого
    // месяца, попавшую в период, и складываем: полный месяц даёт ровно
    // один оклад, как и раньше. Почасовая оплата пропорциональна времени
    // по построению и не трогается.
    const baseMonthShares = bonusMonths.map((m) =>
      monthCoverageShare(m.periodStart, m.periodEnd, periodStart, periodEnd),
    );
    const monthsCovered = baseMonthShares.reduce((sum, sh) => sum + sh, 0);
    const baseAmount =
      baseSalary > 0 ? baseSalary * (monthsCovered || 1) : hourlyRate * hours;

    // ПЕРЕРАБОТКА УБРАНА (решение учредителя). Раньше здесь считался
    // overtimePay = overtimeMinutes/60 × effectiveHourlyRate ×
    // overtimeMultiplier и прибавлялся к net. Больше не считается и не
    // прибавляется; User.overtimeMultiplier / TimeEntry.overtimeMinutes /
    // SalaryRecord.overtimePay остались в схеме с историческими данными,
    // но не читаются. Штрафы (ниже) — отдельная сущность, остаются.

    // Штрафы берутся из таблицы Penalty (auto-cron) — fairness.
    // По ТЗ §5: штраф за опоздание попадает в зарплату ТОЛЬКО если
    // FOUNDER не одобрил причину. PENDING (ждёт решения) и APPROVED
    // не вычитаются — но показываем их отдельными строками в превью,
    // чтобы было видно «висит на рассмотрении ещё X TJS».
    const eff = await this.penaltiesSvc.effectivePenaltiesForUser(
      userId, periodStart, periodEnd, opts.alsoAppliedPenaltyIds,
    );
    const penalties = eff.effective;

    const net = baseAmount + bonusAmount + kpiBonus - penalties;

    return {
      userId,
      user: { id: user.id, fullName: user.fullName, role: user.role, email: user.email },
      periodStart,
      periodEnd,
      workedMinutes: time.workedMinutes,
      lateMinutes: time.lateMinutes,
      baseAmount: round(baseAmount),
      salesAmount: round(salesAmount),
      bonusAmount: round(bonusAmount),
      bonusPercent,
      /** Комиссия за месяц целиком (до вычета уже начисленного). */
      bonusMonthTotal: round(bonusMonthTotal),
      /** Уже начислено бонуса за этот месяц другими записями зарплаты. */
      bonusAlreadyPaid,
      // ── ОБЪЯСНЕНИЕ БОНУСА (чтобы менеджер мог проверить цифру сам) ──
      // CRM показывает: «объём 200 000 → полоса 150 001–225 000 → 6% →
      // 12 000». Подписи полос локализуются на фронте по bonusBand.key
      // (ru/tj), числа отдаём как числа — форматирование не наше дело.
      bonusPeriodStart,
      bonusPeriodEnd,
      bonusVolume: round(salesAmount),
      /**
       * Полоса и ставка — только когда период укладывается в ОДИН месяц.
       * У трёх месяцев полос три, и одно число здесь врало бы; разбивка
       * уходит в bonusMonths ниже, и её же рисует CRM.
       */
      bonusBand: band
        ? ({
            key: band.key,
            minAmount: band.minAmount,
            maxAmount: band.maxAmount, // null = без верхней границы
            percent: band.percent,
          } as ManagerBonusBand)
        : null,
      /** Всегда 'BAND' — ставка из сетки ('PERSONAL' бывает только у старых записей). */
      bonusSource: 'BAND' as const,
      /** Вся сетка целиком — CRM рисует полосы и подсвечивает текущую. */
      bonusBands: MANAGER_BONUS_BANDS,
      /**
       * Помесячная расшифровка: объём, полоса, ставка, комиссия за месяц,
       * уже начисленное и остаток к выплате. Для периода в один месяц — один
       * элемент, и CRM показывает привычную однострочную расшифровку.
       */
      bonusMonths: monthsWithDue.map((x) => ({
        periodStart: x.month.periodStart,
        periodEnd: x.month.periodEnd,
        volume: round(x.month.volume),
        band: x.month.band,
        percent: x.month.percent,
        source: x.month.source,
        monthTotal: round(x.month.monthTotal),
        alreadyPaid: x.alreadyPaid,
        due: x.due,
      })),
      /**
       * Доплата за прошлые месяцы — уже входит в bonusAmount. По каждому
       * месяцу: объём сейчас и тот, что видела его зарплата, сумма поздно
       * одобренных платежей, комиссия по обоим объёмам, уже доплаченное и
       * остаток к доплате. Пусто — доплачивать нечего.
       */
      bonusArrears: arrears,
      bonusArrearsAmount,
      /** Сколько месячных окладов вошло в baseAmount (доли — неполный месяц). */
      monthsCovered: Math.round(monthsCovered * 1000) / 1000,
      /** Ручные INCOME-транзакции за месяц: НЕ входят в объём и бонус. */
      manualSalesAmount: round(manualSalesAmount),
      kpiBonus: round(kpiBonus),
      penalties: round(penalties),
      penaltiesPending: round(eff.pending),
      penaltiesExcused: round(eff.excused),
      netAmount: round(net),
      // currency соответствует SALARY_REPORTING_CURRENCY: и baseAmount,
      // и bonusAmount, и penalties сейчас считаются как TJS-суммы
      // (bonusAmount — потому что бонусная база фильтруется по TJS выше,
      // baseSalary/hourlyRate у User фактически TJS). Меняем константу
      // здесь — меняем и фильтры выше.
      currency: SALARY_REPORTING_CURRENCY,
      // Не-TJS продажи за период (по коду валюты → сумма в исходной
      // валюте). НЕ входят ни в salesAmount, ни в bonusAmount, ни в
      // netAmount — это информационный breakdown для бухгалтера, чтобы
      // видеть, что USD/EUR/CNY/RUB активность в периоде была, но она
      // требует ручной обработки (или FX-конвертации до APPROVE).
      // Пустой {} — период чисто в сомони, фронт может ничего не
      // показывать.
      nonTjsSales,
    };
  }

  async create(dto: {
    userId: string;
    periodStart: string;
    periodEnd: string;
    kpiBonus?: number;
    comment?: string;
  }) {
    // QA-fix #29: безопасный парсинг дат — раньше "not-a-date" падало в 500.
    // Парсим как Asia/Dushanbe — UI присылает 'YYYY-MM-DD'; обычный
    // new Date(s) трактует это как UTC-полночь и съезжает на -5 часов.
    const start = tjParseLocalDate(dto.periodStart);
    const end = tjParseLocalDateEnd(dto.periodEnd);
    if (isNaN(start.getTime())) throw new BadRequestException('Некорректная дата начала периода');
    if (isNaN(end.getTime())) throw new BadRequestException('Некорректная дата конца периода');
    if (end < start) throw new BadRequestException('Конец периода раньше начала');
    // Период разумного размера. Раньше FOUNDER мог запросить salary за
    // 100 лет → SQL запрос с гигантской range на TimeEntries.
    const periodDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    if (periodDays > 366) throw new BadRequestException('Период не должен превышать 1 год');

    // kpiBonus — частая причина typo (1000000 вместо 1000). Cap'ой
    // защищаем от случайной зарплаты в миллион.
    if (dto.kpiBonus !== undefined && dto.kpiBonus !== null) {
      const kb = Number(dto.kpiBonus);
      if (!Number.isFinite(kb) || kb < 0) {
        throw new BadRequestException('kpiBonus должен быть числом ≥ 0');
      }
      if (kb > 100_000) {
        throw new BadRequestException('kpiBonus слишком велик (макс. 100 000)');
      }
    }
    // comment попадает в salary dashboard у админов. Length cap +
    // HTML guard — раньше принимался любой строкой.
    let commentClean: string | null = null;
    if (dto.comment !== undefined && dto.comment !== null) {
      const c = dto.comment.trim();
      if (c.length > 500) throw new BadRequestException('comment слишком длинный (макс. 500)');
      if (/[<>]/.test(c)) throw new BadRequestException('comment не должен содержать HTML-теги');
      commentClean = c || null;
    }
    return this.accrue(dto.userId, start, end, dto.kpiBonus || 0, commentClean);
  }

  /** Начисление за уже проверенный период — общее для create() и recalculate(). */
  private async accrue(userId: string, start: Date, end: Date, kpiBonus: number, commentClean: string | null) {
    // Быстрый отказ до тяжёлого preview: запись за этот период уже есть.
    // Это НЕ гард (проверка гоночная сама по себе) — настоящие гарды ниже:
    // SERIALIZABLE-транзакция и уникальный индекс. Здесь — только чтобы не
    // гонять агрегаты по платежам ради заведомо отклонённого запроса и
    // чтобы бухгалтер увидел внятное 400, а не 500 от индекса.
    const alreadyExists = await this.prisma.salaryRecord.findFirst({
      where: { userId: userId, periodStart: start },
      select: { id: true },
    });
    if (alreadyExists) throw new BadRequestException(DUPLICATE_PERIOD_MESSAGE);

    const preview = await this.preview(userId, start, end, kpiBonus);

    const record = await this.insertRecordAtomically({
      userId: userId,
      periodStart: start,
      periodEnd: end,
      bonusPeriodStart: preview.bonusPeriodStart,
      bonusPeriodEnd: preview.bonusPeriodEnd,
      bonusMonthTotal: preview.bonusMonthTotal,
      bonusMonths: preview.bonusMonths.map((m) => ({
        periodStart: m.periodStart,
        periodEnd: m.periodEnd,
        monthTotal: m.monthTotal,
      })),
      bonusArrears: preview.bonusArrears.map((m) => ({
        periodStart: m.periodStart,
        periodEnd: m.periodEnd,
        arrearsTotal: m.arrearsTotal,
      })),
      // Снимок расшифровки комиссии — сохраняется вместе с записью, чтобы
      // выплаченную строку можно было объяснить спустя месяцы. Ставку и
      // полосу берём из того же preview, из которого получился
      // bonusMonthTotal: второго расчёта здесь нет.
      bonusVolume: preview.bonusVolume,
      // Полоса пишется только для однoмесячной записи. Для периода в
      // несколько месяцев полос несколько, и одна из них в снимке была бы
      // ложью; месяцы восстанавливаются из periodStart/periodEnd записи.
      bonusBandKey: preview.bonusBand?.key ?? null,
      bonusBandMin: preview.bonusBand?.minAmount ?? null,
      bonusBandMax: preview.bonusBand?.maxAmount ?? null,
      bonusPercent: preview.bonusPercent,
      bonusSource: preview.bonusSource,
      workedMinutes: preview.workedMinutes,
      lateMinutes: preview.lateMinutes,
      baseAmount: preview.baseAmount,
      salesAmount: preview.salesAmount,
      kpiBonus: preview.kpiBonus,
      penalties: preview.penalties,
      currency: preview.currency,
      comment: commentClean,
    });
    // Помечаем applied ТОЛЬКО те штрафы, которые реально вошли в
    // netAmount. Pending/excused оставляем — они либо станут REJECTED
    // (тогда учтутся в следующей зарплате), либо умрут.
    const eff = await this.penaltiesSvc.effectivePenaltiesForUser(userId, start, end);
    const effectiveIds = eff.items
      .filter((i: any) => i.excuseStatus !== 'PENDING' && i.excuseStatus !== 'APPROVED')
      .map((i: any) => i.id as string);
    await this.penaltiesSvc.markApplied(userId, start, end, effectiveIds);
    return record;
  }

  /**
   * ЕДИНСТВЕННАЯ точка записи SalaryRecord — и единственное место, где
   * бонус к начислению становится окончательным.
   *
   * ЧТО БЫЛО СЛОМАНО. preview() читает bonusAlreadyPaid (сумма bonusAmount
   * записей того же календарного месяца), create() отдельным запросом
   * вставлял строку. Между чтением и записью не было ничего: два
   * одновременных POST /salary на одного менеджера за один период
   * (двойной клик по «Зафиксировать», ретрай после таймаута) оба видели
   * bonusAlreadyPaid = 0, оба писали ПОЛНЫЙ bonusMonthTotal — менеджер
   * получал месячную комиссию дважды. Дальше markPaid резал под каждую
   * строку отдельную расходную SALARY-транзакцию, и расходилась ещё и
   * финансовая отчётность.
   *
   * ЧТО ТЕПЕРЬ. Агрегат уже начисленного и вставка выполняются ОДНОЙ
   * SERIALIZABLE-транзакцией, и bonusAmount/netAmount пересчитываются
   * ВНУТРИ неё по свежепрочитанному bonusAlreadyPaid. Значения из preview
   * здесь — только те, что от конкурентной зарплатной вставки не зависят
   * (объём продаж, база, штрафы, KPI). Postgres SSI видит пересечение
   * «прочитанный диапазон periodStart ↔ вставка в тот же диапазон» и
   * отменяет вторую транзакцию с 40001 (Prisma: P2034). Её мы
   * перезапускаем: на втором проходе агрегат уже видит чужую строку,
   * bonusAlreadyPaid становится ненулевым и вторая запись доплачивает
   * ровно разницу (обычно 0) вместо полной комиссии.
   *
   * ТРЕТИЙ РУБЕЖ — уникальный индекс SalaryRecord(userId, periodStart)
   * (schema.prisma + prisma/ensure-salary-unique.ts). Он ловит дубль
   * периода даже если БД поднята со снятым SSI или индекс обошли мимо
   * сервиса. P2002 отдаём как 400, а не как 500.
   *
   * Полосы, границы и flat-правило комиссии не трогаются: bonusMonthTotal
   * приходит из preview как есть, здесь только вычитается уже начисленное.
   * Исторические записи не пересчитываются.
   */
  private async insertRecordAtomically(args: {
    userId: string;
    periodStart: Date;
    periodEnd: Date;
    bonusPeriodStart: Date;
    bonusPeriodEnd: Date;
    bonusMonthTotal: number;
    /**
     * Месяцы, задетые периодом, с комиссией за каждый целиком. Вычет уже
     * начисленного делается по каждому месяцу отдельно внутри транзакции.
     */
    bonusMonths: Array<{ periodStart: Date; periodEnd: Date; monthTotal: number }>;
    /**
     * Доплата за прошлые месяцы (bonusArrearsMonths): положенная за месяц
     * целиком; уже доплаченное вычитается внутри транзакции.
     */
    bonusArrears: Array<{ periodStart: Date; periodEnd: Date; arrearsTotal: number }>;
    /** Снимок расшифровки комиссии — пишется в запись как есть. */
    bonusVolume: number;
    /** null — период задел несколько месяцев, одной полосы у него нет. */
    bonusBandKey: string | null;
    bonusBandMin: number | null;
    bonusBandMax: number | null;
    bonusPercent: number | null;
    bonusSource: 'BAND' | 'PERSONAL';
    workedMinutes: number;
    lateMinutes: number;
    baseAmount: number;
    salesAmount: number;
    kpiBonus: number;
    penalties: number;
    currency: string;
    comment: string | null;
  }) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // Повторная проверка дубля — уже под защитой SSI, в отличие от
            // быстрой проверки в create().
            const dup = await tx.salaryRecord.findFirst({
              where: { userId: args.userId, periodStart: args.periodStart },
              select: { id: true },
            });
            if (dup) throw new BadRequestException(DUPLICATE_PERIOD_MESSAGE);

            // Уже начисленный бонус — читаем здесь, а не в preview: только
            // это чтение попадает в диапазон предикатной блокировки вместе
            // с последующей вставкой.
            //
            // ПО КАЖДОМУ МЕСЯЦУ ОТДЕЛЬНО. Общий вычет «сумма месяцев минус
            // всё начисленное» схлопнул бы разные месяцы в одно число: уже
            // выплаченный июнь гасил бы неоплаченный июль. Для месяца
            // уже начисленным считаем записи, которые его ПЕРЕСЕКАЮТ.
            let bonusAmount = 0;
            let bonusAlreadyPaid = 0;
            const bonusByMonth: Record<string, number> = {};
            const paidPerMonth = await bonusPaidByMonth(tx, args.userId, args.bonusMonths);
            for (const m of args.bonusMonths) {
              const key = monthKey(m.periodStart);
              const paid = paidPerMonth.get(key) ?? 0;
              const due = Math.max(0, round(m.monthTotal - paid));
              bonusAlreadyPaid += paid;
              bonusAmount += due;
              bonusByMonth[key] = due;
            }
            // Доплата за прошлые месяцы — тем же приёмом: уже доплаченное
            // читается в этой же транзакции, и если параллельная запись успела
            // доплатить месяц, здесь выйдет 0, а не вторая доплата. Долю
            // пишем в bonusByMonth под ключом прошлого месяца — по ней следующие
            // записи увидят, что за этот месяц уже доплачено.
            if (args.bonusArrears.length) {
              const arrearsPaid = await bonusArrearsPaidByMonth(tx, args.userId, args.bonusArrears);
              for (const m of args.bonusArrears) {
                const key = monthKey(m.periodStart);
                const due = Math.max(0, round(m.arrearsTotal - (arrearsPaid.get(key) ?? 0)));
                if (due > 0) {
                  bonusAmount += due;
                  bonusByMonth[key] = due;
                }
              }
            }
            bonusAmount = round(bonusAmount);
            bonusAlreadyPaid = round(bonusAlreadyPaid);
            // net пересчитываем здесь же: preview.netAmount посчитан со
            // «своим» bonusAmount, который мог устареть между preview и
            // этой транзакцией.
            const netAmount = round(
              args.baseAmount + bonusAmount + args.kpiBonus - args.penalties,
            );

            return tx.salaryRecord.create({
              data: {
                userId: args.userId,
                periodStart: args.periodStart,
                periodEnd: args.periodEnd,
                workedMinutes: args.workedMinutes,
                lateMinutes: args.lateMinutes,
                // overtimeMinutes / overtimePay НЕ пишем — переработка убрана.
                // Колонки остаются в схеме с @default(0) ради исторических строк.
                baseAmount: args.baseAmount,
                salesAmount: args.salesAmount,
                bonusAmount,
                kpiBonus: args.kpiBonus,
                penalties: args.penalties,
                netAmount,
                currency: args.currency,
                // СНИМОК РАСШИФРОВКИ КОМИССИИ (audit HIGH «строка не
                // сходится»). Раньше в БД оседало одно число bonusAmount,
                // а объяснение — объём, полоса, ставка, вычет уже
                // начисленного — жило только в live-preview и исчезало в
                // момент сохранения. Спустя полгода строку «Бонус 12 500»
                // защитить было нечем: сетка полос лежит в коде и может
                // смениться, платежи могли быть отменены, пересчёт дал бы
                // уже другое число. Пишем ровно те цифры, из которых
                // bonusAmount получился ЗДЕСЬ — в том числе
                // bonusAlreadyPaid, прочитанный внутри этой же
                // SERIALIZABLE-транзакции (значение из preview могло
                // устареть, и снимок разошёлся бы с фактом).
                bonusVolume: args.bonusVolume,
                bonusBandKey: args.bonusBandKey,
                bonusBandMin: args.bonusBandMin,
                bonusBandMax: args.bonusBandMax,
                bonusPercent: args.bonusPercent,
                bonusMonthTotal: args.bonusMonthTotal,
                bonusAlreadyPaid,
                bonusByMonth,
                bonusSource: args.bonusSource,
                comment: args.comment,
              },
              include: { user: { select: { id: true, fullName: true, isActive: true, role: true } } },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError) {
          // Уникальный индекс (userId, periodStart) — дубль периода.
          // 400 с внятным текстом вместо 500.
          if (e.code === 'P2002') {
            throw new BadRequestException(DUPLICATE_PERIOD_MESSAGE);
          }
          // P2034 — write conflict / serialization failure (Postgres 40001).
          // Ровно тот случай, ради которого взят SERIALIZABLE: перезапуск
          // безопасен, потому что вся арифметика бонуса живёт внутри
          // транзакции и на втором проходе увидит чужую запись.
          if (e.code === 'P2034') {
            if (attempt < SERIALIZABLE_RETRIES) continue;
            throw new BadRequestException(CONCURRENT_WRITE_MESSAGE);
          }
        }
        throw e;
      }
    }
  }

  /** QA-fix: атомарное claim PENDING → PAID, чтобы повторный вызов
   *  не создавал вторую expense-транзакцию (раньше можно было дёрнуть
   *  /salary/:id/pay дважды и получить дубль расхода). */
  async markPaid(id: string) {
    const rec = await this.prisma.salaryRecord.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Запись не найдена');
    if (rec.status === 'PAID') throw new BadRequestException('Зарплата уже выплачена');

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.salaryRecord.updateMany({
        where: { id, status: { not: 'PAID' } },
        data: { status: 'PAID', paidAt: new Date() },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Зарплата уже выплачена');
      }
      // Транзакции оплат по сделкам, вошедшие в базу бонуса этой выплаты,
      // помечаем bonusApplied: удалить их без явного обхода руководством
      // (overrideBonusApplied) больше нельзя. Отбор — тот же, что у базы
      // бонуса (loadCountedPayments в common/manager-bonus-volume.ts), по
      // месяцам периода: помечаются ровно те платежи, за которые заплатили.
      const bonusFrom = tjStartOfMonth(rec.periodStart);
      const bonusTo = tjEndOfMonth(rec.periodEnd);
      const counted = await loadCountedPayments(tx, [rec.userId], { from: bonusFrom, to: bonusTo });
      // Доплата за прошлые месяцы (доли bonusByMonth с ключами раньше
      // периода) — платежи этих месяцев тоже оплачены этой выплатой.
      const split = rec.bonusByMonth as Record<string, number> | null;
      if (split && typeof split === 'object') {
        for (const [key, due] of Object.entries(split)) {
          const start = monthStartFromKey(key);
          if (!start || start >= bonusFrom || !(Number(due) > 0)) continue;
          counted.push(...(await loadCountedPayments(tx, [rec.userId], { from: start, to: tjEndOfMonth(start) })));
        }
      }
      const txIds = counted.map((p) => p.financeTransactionId).filter((x): x is string => !!x);
      if (txIds.length) {
        await tx.transaction.updateMany({ where: { id: { in: txIds }, reversedAt: null }, data: { bonusApplied: true } });
      }
      await tx.transaction.create({
        data: {
          type: 'EXPENSE',
          category: 'SALARY',
          amount: rec.netAmount,
          currency: rec.currency,
          managerId: rec.userId,
          comment: `Зарплата за период ${tjLocalDay(rec.periodStart)} — ${tjLocalDay(rec.periodEnd)}`,
          date: new Date(),
        },
      });
      return tx.salaryRecord.findUnique({
        where: { id },
        include: { user: { select: { id: true, fullName: true, isActive: true, role: true } } },
      });
    });
  }

  /**
   * Удаление зарплатной записи.
   *
   * ВЫПЛАЧЕННУЮ (PAID) запись удалять НЕЛЬЗЯ, и это не косметика:
   *
   * 1. Двойная комиссия. preview()/create() считают bonusAlreadyPaid
   *    агрегатом bonusAmount по записям месяца. Удаление PAID-записи
   *    вычло бы её из агрегата, и следующий расчёт показал бы ПОЛНУЮ
   *    месячную комиссию как «к начислению» — её можно было бы
   *    выплатить второй раз.
   * 2. Осиротевший расход. markPaid() пишет EXPENSE/SALARY транзакцию;
   *    при delete она осталась бы в финансах без своей зарплатной
   *    записи и ничем не сторнировалась бы.
   *
   * Удаление DRAFT остаётся разрешённым, и уменьшать агрегат при этом
   * КОРРЕКТНО: черновик ничего не выплатил, он лишь резервировал часть
   * месячной комиссии, и удаление этот резерв освобождает.
   */
  async remove(id: string) {
    const rec = await this.prisma.salaryRecord.findUnique({
      where: { id },
      select: { id: true, status: true, userId: true, periodStart: true, periodEnd: true },
    });
    if (!rec) throw new NotFoundException('Запись не найдена');
    if (rec.status === 'PAID') {
      throw new BadRequestException(
        'Выплаченную зарплату нельзя удалить — используйте сторнирование',
      );
    }
    // Штрафы, которые учла эта запись, снова «не учтены» — при новом
    // начислении за этот период они вычтутся. Без этого удалить и
    // начислить заново значило молча простить все её штрафы.
    return this.prisma.$transaction(async (tx) => {
      const remaining = await tx.salaryRecord.findMany({
        where: { userId: rec.userId, id: { not: rec.id } },
        select: { periodStart: true, periodEnd: true },
      });
      await this.penaltiesSvc.releaseForRemovedSalary(tx, rec.userId, rec, remaining);
      return tx.salaryRecord.delete({ where: { id } });
    });
  }

  // ===== ПЕРЕСЧЁТ НЕВЫПЛАЧЕННОЙ ЗАРПЛАТЫ =====
  //
  // Начисленная запись — снимок: штрафы, часы и бонус, появившиеся позже,
  // в неё не попадают. «Пересчитать» считает период заново по текущим данным
  // (KPI-бонус, комментарий и сам период — прежние), как будто записи не
  // было: её бонус не идёт в «уже начислено», её штрафы снова не учтены.
  // Выплаченную не трогаем — деньги ушли, расход в финансах записан.
  //
  // Технически это «снять запись → начислить заново» через тот же accrue(),
  // что и обычное начисление: та же SERIALIZABLE-вставка, тот же снимок
  // бонуса, и момент записи обновляется — доплата за прошлые месяцы
  // (bonusArrearsMonths) больше не считает поздними платежи, которые новая
  // запись уже учла.

  private async recalculable(id: string) {
    const rec = await this.prisma.salaryRecord.findUnique({
      where: { id },
      include: { user: { select: { fullName: true } } },
    });
    if (!rec) throw new NotFoundException('Запись не найдена');
    if (rec.status === 'PAID') throw new BadRequestException(RECALC_PAID_MESSAGE);
    return rec;
  }

  /** Сколько станет после пересчёта — ничего не сохраняя. */
  async recalculatePreview(id: string) {
    const rec = await this.recalculable(id);
    const remaining = await this.prisma.salaryRecord.findMany({
      where: { userId: rec.userId, id: { not: rec.id } },
      select: { periodStart: true, periodEnd: true },
    });
    const freed = await this.penaltiesSvc.appliedBySalary(this.prisma, rec.userId, rec, remaining);
    const p = await this.preview(rec.userId, rec.periodStart, rec.periodEnd, rec.kpiBonus, {
      excludeRecordId: rec.id,
      alsoAppliedPenaltyIds: freed,
    });
    return {
      id: rec.id,
      userId: rec.userId,
      fullName: rec.user?.fullName ?? '',
      before: round(rec.netAmount),
      after: p.netAmount,
      penaltiesBefore: round(rec.penalties),
      penaltiesAfter: p.penalties,
    };
  }

  async recalculate(id: string) {
    const old = await this.recalculable(id);
    const { user, ...row } = old;
    const freed = await this.prisma.$transaction(async (tx) => {
      // Между чтением и снятием запись могли выплатить — проверяем ещё раз.
      const fresh = await tx.salaryRecord.findUnique({ where: { id }, select: { status: true } });
      if (!fresh || fresh.status === 'PAID') throw new BadRequestException(RECALC_PAID_MESSAGE);
      const remaining = await tx.salaryRecord.findMany({
        where: { userId: old.userId, id: { not: id } },
        select: { periodStart: true, periodEnd: true },
      });
      const ids = await this.penaltiesSvc.releaseForRemovedSalary(tx, old.userId, old, remaining);
      await tx.salaryRecord.delete({ where: { id } });
      return ids;
    });
    try {
      const rec = await this.accrue(old.userId, old.periodStart, old.periodEnd, old.kpiBonus, old.comment);
      return {
        id: rec.id,
        userId: old.userId,
        fullName: user?.fullName ?? '',
        before: round(old.netAmount),
        after: round(rec.netAmount),
      };
    } catch (e) {
      // Начислить заново не вышло — возвращаем прежнюю запись и её штрафы
      // ровно как были, чтобы пересчёт не оставил сотрудника без зарплаты.
      const { bonusByMonth, ...rest } = row;
      await this.prisma.$transaction([
        this.prisma.salaryRecord.create({
          data: { ...rest, ...(bonusByMonth !== null ? { bonusByMonth: bonusByMonth as Prisma.InputJsonValue } : {}) },
        }),
        this.prisma.penalty.updateMany({ where: { id: { in: freed } }, data: { applied: true } }),
      ]);
      throw e;
    }
  }

  /** Невыплаченные записи периода — те, что таблица показывает «начисленными». */
  private recalculableInPeriod(start: Date, end: Date) {
    return this.prisma.salaryRecord.findMany({
      where: { status: { not: 'PAID' }, periodStart: { gte: start, lte: end } },
      orderBy: [{ periodStart: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
  }

  async recalculatePreviewAll(start: Date, end: Date) {
    const recs = await this.recalculableInPeriod(start, end);
    const items: Awaited<ReturnType<SalaryService['recalculatePreview']>>[] = [];
    for (const r of recs) items.push(await this.recalculatePreview(r.id));
    return {
      count: items.length,
      before: round(items.reduce((s, x) => s + x.before, 0)),
      after: round(items.reduce((s, x) => s + x.after, 0)),
      items,
    };
  }

  /** По одной записи подряд: пересчёт сотрудника зависит от уже пересчитанных записей того же месяца. */
  async recalculateAll(start: Date, end: Date) {
    const recs = await this.recalculableInPeriod(start, end);
    const items: Awaited<ReturnType<SalaryService['recalculate']>>[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const r of recs) {
      try {
        items.push(await this.recalculate(r.id));
      } catch (e: any) {
        failed.push({ id: r.id, message: e?.message || String(e) });
      }
    }
    return {
      done: items.length,
      failed,
      before: round(items.reduce((s, x) => s + x.before, 0)),
      after: round(items.reduce((s, x) => s + x.after, 0)),
      items,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Ключ календарного месяца по Душанбе: «2026-06». */
function monthKey(d: Date): string {
  return tjLocalDay(d).slice(0, 7);
}

/**
 * Уже начисленный бонус по каждому месяцу. Запись с разбивкой bonusByMonth
 * отдаёт месяцу ровно его долю: запись «май–июнь» больше не гасит весь июнь
 * своим майским бонусом. Долю берём у ЛЮБОЙ записи, где она есть, — в том
 * числе у более поздней, которая доплачивала этот месяц (доплата за прошлые
 * месяцы, см. bonusArrearsMonths), иначе доплата ушла бы второй раз. У старых
 * записей без разбивки весь bonusAmount ложится на каждый задетый месяц —
 * лучше недоплатить на виду, чем начислить дважды.
 */
async function bonusPaidByMonth(
  db: Prisma.TransactionClient | PrismaService,
  userId: string,
  months: Array<{ periodStart: Date; periodEnd: Date }>,
  /** Пересчитываемая запись — её бонус в «уже начислено» не входит. */
  excludeRecordId?: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!months.length) return out;
  const earliest = new Date(Math.min(...months.map((m) => m.periodStart.getTime())));
  // Запись, закончившаяся раньше самого раннего месяца, ни задеть его, ни
  // доплатить за него не может: доплату несут только более поздние записи.
  const records = await db.salaryRecord.findMany({
    where: { userId, periodEnd: { gte: earliest }, ...(excludeRecordId && { id: { not: excludeRecordId } }) },
    select: { periodStart: true, periodEnd: true, bonusAmount: true, bonusByMonth: true },
  });
  for (const m of months) {
    const key = monthKey(m.periodStart);
    let paid = 0;
    for (const r of records) {
      const split = r.bonusByMonth as Record<string, number> | null;
      if (split && typeof split === 'object') {
        paid += Number(split[key] || 0);
      } else if (!(r.periodStart > m.periodEnd || r.periodEnd < m.periodStart)) {
        paid += r.bonusAmount || 0;
      }
    }
    out.set(key, round(paid));
  }
  return out;
}

/** Доплата за прошлые месяцы, вошедшая в запись: доли bonusByMonth с ключами раньше её периода. */
function recordArrearsAmount(rec: { periodStart: Date; bonusByMonth: Prisma.JsonValue | null }): number {
  const split = rec.bonusByMonth as Record<string, number> | null;
  if (!split || typeof split !== 'object') return 0;
  const own = monthKey(rec.periodStart);
  let sum = 0;
  for (const [key, v] of Object.entries(split)) if (key < own) sum += Number(v) || 0;
  return round(sum);
}

/** Начало месяца Asia/Dushanbe по ключу «2026-10»; null — ключ не месяц. */
function monthStartFromKey(key: string): Date | null {
  if (!/^\d{4}-\d{2}$/.test(key)) return null;
  const d = tjParseLocalDate(`${key}-01`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * С какого момента одобрение считается поздним и даёт доплату за прошлый
 * месяц. До 26.09.2026 доплат не было: платёж, одобренный после расчёта
 * своего месяца, в бонус не попадал, и такие случаи основатель закрывал сам.
 * Задним числом их не доплачиваем — иначе система сама выплатила бы за давно
 * закрытые месяцы.
 */
const BONUS_ARREARS_SINCE = new Date('2026-09-26T00:00:00+05:00');

/** Как далеко назад искать недоплату, месяцев. */
const ARREARS_LOOKBACK_MONTHS = 24;

/** Доплата за один прошлый месяц — строка расшифровки в зарплате. */
export interface BonusArrearsMonth {
  periodStart: Date;
  periodEnd: Date;
  /** Объём месяца сейчас — со всеми одобренными платежами. */
  volume: number;
  band: ManagerBonusBand;
  percent: number;
  /** Комиссия месяца по сегодняшнему объёму. */
  monthTotal: number;
  /** Объём, который видела зарплата месяца, — без поздно одобренных платежей. */
  knownVolume: number;
  /** Комиссия по этому объёму. */
  knownTotal: number;
  /** Сумма платежей месяца, одобренных после его расчёта. */
  lateVolume: number;
  /** Доплата за месяц целиком: monthTotal − knownTotal, не меньше нуля. */
  arrearsTotal: number;
  /** Уже доплачено за этот месяц прошлыми записями. */
  alreadyPaid: number;
  /** К доплате сейчас. */
  due: number;
}

/**
 * ДОПЛАТА ЗА ПРОШЛЫЕ МЕСЯЦЫ.
 *
 * Бонус считается по месяцу ОПЛАТЫ (common/manager-bonus-volume.ts), а
 * одобряет платёж основатель, когда успеет: бывает, что зарплата за месяц
 * оплаты к этому времени уже зафиксирована. Комиссия того месяца выросла, а
 * запись уже лежит — разницу доплачивает следующая запись.
 *
 * Считаем НЕ «комиссия сейчас минус начисленное тогда»: начисленное тогда
 * могло считаться по другим правилам (до 26.09 — личный процент и другая
 * сетка), и пересчёт по сегодняшним правилам выдал бы «доплату» за смену
 * правил — автоматическую выплату за давно закрытые месяцы. Доплата — ровно
 * эффект поздних одобрений:
 *
 *   комиссия(объём со всеми) − комиссия(объём без поздних) − уже доплаченное,
 *
 * где поздний — одобрен после последней зарплатной записи, задевающей месяц,
 * и не раньше BONUS_ARREARS_SINCE. Ставка — по сетке на весь объём: если
 * поздний платёж перевёл месяц в следующую полосу, доплата включает и подъём
 * ставки на весь объём месяца.
 *
 * Месяцы БЕЗ зарплатных записей не берём: их бонус начислит их собственная
 * запись. Назад ничего не забираем — отмена сделки уменьшает объём, но
 * разница ограничена нулём, как и в основном расчёте.
 */
async function bonusArrearsMonths(
  db: Prisma.TransactionClient | PrismaService,
  userId: string,
  before: Date,
  excludeRecordId?: string,
): Promise<BonusArrearsMonth[]> {
  const ownStart = tjStartOfMonth(before);
  let horizon = ownStart;
  for (let i = 0; i < ARREARS_LOOKBACK_MONTHS; i++) horizon = tjStartOfMonth(new Date(horizon.getTime() - 1));
  const records = await db.salaryRecord.findMany({
    where: {
      userId,
      periodStart: { lt: ownStart },
      periodEnd: { gte: horizon },
      ...(excludeRecordId && { id: { not: excludeRecordId } }),
    },
    select: { periodStart: true, periodEnd: true, createdAt: true },
  });
  // Прошлые месяцы с зарплатными записями и момент последней записи по
  // каждому: платежи, одобренные позже него, эта зарплата не видела.
  const lastFixAt = new Map<number, number>();
  for (const r of records) {
    let cursor = tjStartOfMonth(r.periodStart);
    for (let guard = 0; cursor < ownStart && cursor <= r.periodEnd && guard < 24; guard++) {
      if (cursor >= horizon) {
        const t = cursor.getTime();
        lastFixAt.set(t, Math.max(lastFixAt.get(t) ?? 0, r.createdAt.getTime()));
      }
      cursor = tjStartOfMonth(new Date(tjEndOfMonth(cursor).getTime() + 1));
    }
  }
  if (!lastFixAt.size) return [];
  const starts = [...lastFixAt.keys()].sort((a, b) => a - b);
  const payments = await loadCountedPayments(db, [userId], {
    from: new Date(starts[0]),
    to: tjEndOfMonth(new Date(starts[starts.length - 1])),
  });
  const now = new Map<number, number>();
  const known = new Map<number, number>();
  for (const p of payments) {
    const t = tjStartOfMonth(p.countedAt).getTime();
    const fixAt = lastFixAt.get(t);
    // Месяц без зарплатной записи — его бонус начислит его собственная запись.
    if (fixAt === undefined) continue;
    const sum = p.amountTjs ?? 0;
    now.set(t, (now.get(t) ?? 0) + sum);
    const late = !!p.reviewedAt && p.reviewedAt.getTime() > fixAt && p.reviewedAt >= BONUS_ARREARS_SINCE;
    if (!late) known.set(t, (known.get(t) ?? 0) + sum);
  }
  const candidates = starts.filter((t) => round(now.get(t) ?? 0) > round(known.get(t) ?? 0));
  if (!candidates.length) return [];
  const months = candidates.map((t) => ({ periodStart: new Date(t), periodEnd: tjEndOfMonth(new Date(t)) }));
  const paid = await bonusArrearsPaidByMonth(db, userId, months, excludeRecordId);
  const out: BonusArrearsMonth[] = [];
  for (const m of months) {
    const t = m.periodStart.getTime();
    const volume = round(now.get(t) ?? 0);
    const knownVolume = round(known.get(t) ?? 0);
    const eff = effectiveManagerBonus(volume);
    const monthTotal = computeManagerBonus(volume).amount;
    const knownTotal = computeManagerBonus(knownVolume).amount;
    const arrearsTotal = Math.max(0, round(monthTotal - knownTotal));
    const alreadyPaid = paid.get(monthKey(m.periodStart)) ?? 0;
    const due = Math.max(0, round(arrearsTotal - alreadyPaid));
    if (due <= 0) continue;
    out.push({
      periodStart: m.periodStart,
      periodEnd: m.periodEnd,
      volume,
      band: eff.band,
      percent: eff.percent,
      monthTotal,
      knownVolume,
      knownTotal,
      lateVolume: round(volume - knownVolume),
      arrearsTotal,
      alreadyPaid,
      due,
    });
  }
  return out;
}

/**
 * Уже доплачено за прошлые месяцы: доли bonusByMonth у записей, которые месяц
 * НЕ задевают, — то есть у более поздних, несших доплату. Свои записи месяца
 * доплатой не считаются: что они видели, учитывает момент последней записи.
 */
async function bonusArrearsPaidByMonth(
  db: Prisma.TransactionClient | PrismaService,
  userId: string,
  months: Array<{ periodStart: Date; periodEnd: Date }>,
  excludeRecordId?: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!months.length) return out;
  const earliestEnd = new Date(Math.min(...months.map((m) => m.periodEnd.getTime())));
  const records = await db.salaryRecord.findMany({
    where: { userId, periodStart: { gt: earliestEnd }, ...(excludeRecordId && { id: { not: excludeRecordId } }) },
    select: { periodStart: true, periodEnd: true, bonusByMonth: true },
  });
  for (const m of months) {
    const key = monthKey(m.periodStart);
    let paid = 0;
    for (const r of records) {
      if (r.periodStart <= m.periodEnd) continue;
      const split = r.bonusByMonth as Record<string, number> | null;
      if (split && typeof split === 'object') paid += Number(split[key] || 0);
    }
    out.set(key, round(paid));
  }
  return out;
}
