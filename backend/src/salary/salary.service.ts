import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  findManagerBonusBand,
} from '../common/bonus-bands';

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
const SALARY_REPORTING_CURRENCY = 'TJS';

// Разбивка не-TJS продаж (по коду валюты → сумма в исходной валюте).
// Используется исключительно для отображения / audit — эти суммы НЕ
// участвуют в bonusAmount и netAmount, но и не теряются в тишине.
export type NonTjsSalesBreakdown = Record<string, number>;

@Injectable()
export class SalaryService {
  constructor(
    private prisma: PrismaService,
    private timeSvc: TimeTrackingService,
    private penaltiesSvc: PenaltiesService,
  ) {}

  /**
   * Возвращает set-у Transaction.id, отмеченных reversedAt != null, среди
   * переданных id (nulls игнорим — legacy-платежи без linked-tx). Используется
   * для parity-фильтра с finance: платёж, чья финансовая запись развёрнута,
   * не должен попадать в бонусную базу, даже если submission ещё ACTIVE
   * (случай ручной корректировки без cancel'а сделки). См. подробный
   * комментарий в preview() (ANCHOR-PARITY-FIX).
   */
  private async reversedLinkedTxIds(
    candidateIds: Array<string | null | undefined>,
  ): Promise<Set<string>> {
    const ids = candidateIds.filter((x): x is string => !!x);
    if (ids.length === 0) return new Set();
    const reversed = await this.prisma.transaction.findMany({
      where: { id: { in: ids }, reversedAt: { not: null } },
      select: { id: true },
    });
    return new Set(reversed.map((t) => t.id));
  }

  async list(filters: { userId?: string; from?: Date; to?: Date }) {
    return this.prisma.salaryRecord.findMany({
      where: {
        ...(filters.userId && { userId: filters.userId }),
        ...(filters.from && { periodStart: { gte: filters.from } }),
        ...(filters.to && { periodEnd: { lte: filters.to } }),
      },
      orderBy: { periodStart: 'desc' },
      include: { user: { select: { id: true, fullName: true, role: true, email: true } } },
    });
  }

  /**
   * Считает (без сохранения) зарплату сотрудника за период:
   *   - hours/minutes — берём из TimeEntry за ЗАПРОШЕННЫЙ период
   *   - объём продаж (бонусная база) — сумма APPROVED SubmissionPayment,
   *     reviewedAt которых попал в КАЛЕНДАРНЫЙ МЕСЯЦ (Asia/Dushanbe) даты
   *     начала периода. Триггер начисления — момент одобрения FOUNDER'ом,
   *     а не дата получения денег менеджером (см. bug #22 ниже).
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
  async preview(userId: string, periodStart: Date, periodEnd: Date, kpiBonus = 0) {
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
    // 1) Платежи по сделкам (SubmissionPayment) — попадают в бонус по
    //    reviewedAt (когда FOUNDER одобрил), а НЕ по paidAt (когда менеджер
    //    принёс деньги). Это фикс bug #22 из audit:integration:
    //    paidAt мог оказаться в уже закрытом (PAID) salary-периоде, и при
    //    задержке одобрения бонус терялся бесследно (preview не пересчитывает
    //    PAID-записи, а в новый период date<periodStart). Transaction.date
    //    при этом по-прежнему = paidAt — это «факт прихода денег» для
    //    финансовой отчётности; reviewedAt — «триггер начисления бонуса».
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
    // период). Границы берём из tj-time (tjStartOfMonth/tjEndOfMonth), а
    // не из сырого Date: сервер живёт в UTC, и `new Date(y, m, 1)` дал бы
    // месяц, начинающийся 1-го числа в 05:00 по Душанбе — платежи первой
    // ночи месяца уехали бы в предыдущий месяц и в чужую полосу.
    const bonusPeriodStart = tjStartOfMonth(periodStart);
    const bonusPeriodEnd = tjEndOfMonth(periodStart); // последняя мс месяца, inclusive
    const tjsPaymentCandidates = await this.prisma.submissionPayment.findMany({
      where: {
        status: 'APPROVED',
        reviewedAt: { gte: bonusPeriodStart, lte: bonusPeriodEnd },
        submission: {
          managerId: userId,
          status: { not: 'CANCELLED' },
          currency: SALARY_REPORTING_CURRENCY,
        },
      },
      select: { amount: true, financeTransactionId: true },
    });
    const reversedLinkedTxIds = await this.reversedLinkedTxIds(
      tjsPaymentCandidates.map((p) => p.financeTransactionId),
    );
    const submissionSalesSum = tjsPaymentCandidates.reduce((sum, p) => {
      // Второй якорь (parity с finance): linked Transaction.reversedAt.
      // Пропускаем платежи, чья финансовая запись помечена как reversed —
      // даже если submission ещё не CANCELLED (случай (B) в комментарии
      // выше: ручная корректировка).
      if (p.financeTransactionId && reversedLinkedTxIds.has(p.financeTransactionId)) {
        return sum;
      }
      return sum + (p.amount || 0);
    }, 0);
    // ОБЪЁМ ДЛЯ ПОЛОСЫ = только APPROVED-платежи по сделкам (ТЗ):
    // «объём = сумма одобренных платежей по заявкам за календарный месяц».
    const salesAmount = submissionSalesSum;

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

    // Разбивка не-TJS продаж за тот же период. Для transaction — обычный
    // groupBy по currency. Для submissionPayment currency лежит у
    // родителя SaleSubmission, а Prisma groupBy не умеет по relation
    // scalar — поэтому findMany с include и группировка в памяти
    // (типичный размер платежей за период — десятки, не тысячи).
    // Отменённые сделки (submission.status='CANCELLED') и reversed
    // транзакции по-прежнему исключены — теми же фильтрами, что и TJS.
    const nonTjsSubmissionPayments = await this.prisma.submissionPayment.findMany({
      where: {
        status: 'APPROVED',
        reviewedAt: { gte: bonusPeriodStart, lte: bonusPeriodEnd },
        submission: {
          managerId: userId,
          status: { not: 'CANCELLED' },
          currency: { not: SALARY_REPORTING_CURRENCY },
        },
      },
      select: {
        amount: true,
        financeTransactionId: true,
        submission: { select: { currency: true } },
      },
    });
    // Тот же parity-фикс, что и для TJS: платежи с reversed linked-tx
    // исключаем, иначе non-TJS breakdown разойдётся с finance по тем же
    // сценариям (A)/(B), описанным в комментарии выше.
    const reversedNonTjsLinkedTxIds = await this.reversedLinkedTxIds(
      nonTjsSubmissionPayments.map((p) => p.financeTransactionId),
    );
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
    const nonTjsSales: NonTjsSalesBreakdown = {};
    for (const p of nonTjsSubmissionPayments) {
      if (p.financeTransactionId && reversedNonTjsLinkedTxIds.has(p.financeTransactionId)) {
        continue; // linked tx reversed — parity с finance
      }
      const c = p.submission?.currency || 'UNKNOWN';
      nonTjsSales[c] = (nonTjsSales[c] || 0) + (p.amount || 0);
    }
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
    // Полоса определяется ВСЕГДА (даже при персональном проценте) — чтобы
    // CRM могла показать менеджеру, куда попал его объём.
    const band = findManagerBonusBand(salesAmount);
    // Персональный bonusPercent у юзера, если > 0, перебивает сетку
    // (ручной override FOUNDER'а, существующая функция — не трогаем).
    const personalPct = user.bonusPercent || 0;
    const usePersonal = personalPct > 0;
    const bonusPercent = usePersonal ? personalPct : band.percent;
    /** Комиссия за ВЕСЬ месяц целиком. */
    const bonusMonthTotal = usePersonal
      ? round((salesAmount * personalPct) / 100)
      : computeManagerBonus(salesAmount).amount;

    // ЗАЩИТА ОТ ДВОЙНОГО НАЧИСЛЕНИЯ.
    // Объём считается за календарный месяц, а зарплатных записей внутри
    // месяца может быть несколько (аванс + расчёт, две половины месяца).
    // Без этой поправки каждая такая запись начислила бы ПОЛНЫЙ месячный
    // бонус — менеджер получил бы комиссию дважды.
    //
    // Уже начисленным считаем бонус тех записей, чей periodStart попал в
    // ЭТОТ ЖЕ месяц: именно так бонус и привязывается к месяцу выше
    // (окно = месяц даты начала периода). Записи, начавшиеся в прошлом
    // месяце, относятся к бонусу прошлого месяца и не вычитаются.
    //
    // Если объём за месяц вырос и поднял полосу, вторая запись доплатит
    // разницу — это и есть верное поведение месячной комиссии.
    const priorBonusAgg = await this.prisma.salaryRecord.aggregate({
      where: {
        userId,
        periodStart: { gte: bonusPeriodStart, lte: bonusPeriodEnd },
      },
      _sum: { bonusAmount: true },
    });
    const bonusAlreadyPaid = round(priorBonusAgg._sum.bonusAmount || 0);
    /** К начислению сейчас = месячная комиссия минус уже начисленное. */
    const bonusAmount = Math.max(0, round(bonusMonthTotal - bonusAlreadyPaid));

    const baseSalary = user.baseSalary || 0;
    const hourlyRate = user.hourlyRate || 0;
    // Итоговая базовая ставка: либо фикс., либо почасовая.
    const hours = time.workedMinutes / 60;
    const baseAmount = baseSalary > 0 ? baseSalary : hourlyRate * hours;

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
    const eff = await this.penaltiesSvc.effectivePenaltiesForUser(userId, periodStart, periodEnd);
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
      bonusBand: {
        key: band.key,
        minAmount: band.minAmount,
        maxAmount: band.maxAmount, // null = без верхней границы
        percent: band.percent,
      } as ManagerBonusBand,
      /** 'BAND' — ставка из сетки; 'PERSONAL' — персональный процент юзера. */
      bonusSource: usePersonal ? ('PERSONAL' as const) : ('BAND' as const),
      /** Вся сетка целиком — CRM рисует полосы и подсвечивает текущую. */
      bonusBands: MANAGER_BONUS_BANDS,
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

    const preview = await this.preview(dto.userId, start, end, dto.kpiBonus || 0);

    const record = await this.prisma.salaryRecord.create({
      data: {
        userId: dto.userId,
        periodStart: start,
        periodEnd: end,
        workedMinutes: preview.workedMinutes,
        lateMinutes: preview.lateMinutes,
        // overtimeMinutes / overtimePay НЕ пишем — переработка убрана.
        // Колонки остаются в схеме с @default(0) ради исторических строк.
        baseAmount: preview.baseAmount,
        salesAmount: preview.salesAmount,
        bonusAmount: preview.bonusAmount,
        kpiBonus: preview.kpiBonus,
        penalties: preview.penalties,
        netAmount: preview.netAmount,
        currency: preview.currency,
        comment: commentClean,
      },
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
    // Помечаем applied ТОЛЬКО те штрафы, которые реально вошли в
    // netAmount. Pending/excused оставляем — они либо станут REJECTED
    // (тогда учтутся в следующей зарплате), либо умрут.
    const eff = await this.penaltiesSvc.effectivePenaltiesForUser(dto.userId, start, end);
    const effectiveIds = eff.items
      .filter((i: any) => i.excuseStatus !== 'PENDING' && i.excuseStatus !== 'APPROVED')
      .map((i: any) => i.id as string);
    await this.penaltiesSvc.markApplied(dto.userId, start, end, effectiveIds);
    return record;
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
        include: { user: { select: { id: true, fullName: true, role: true } } },
      });
    });
  }

  async remove(id: string) {
    return this.prisma.salaryRecord.delete({ where: { id } });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
