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
  managerBonusVolume,
  managerBonusMonths,
  monthCoverageShare,
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
   *     paidAt которых попал в КАЛЕНДАРНЫЙ МЕСЯЦ (Asia/Dushanbe) даты
   *     начала периода. Месяц определяет дата получения денег; одобрение
   *     остаётся фильтром, а не якорем периода — обоснование и разбор на
   *     боевых данных в common/manager-bonus-volume.ts.
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
    const bonusMonths = await managerBonusMonths(
      this.prisma,
      userId,
      user.bonusPercent,
      periodStart,
      periodEnd,
    );
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
        // Тот же якорь, что и у TJS-объёма — paidAt, не reviewedAt
        // (см. common/manager-bonus-volume.ts, блок «ЯКОРЬ ПЕРИОДА»).
        paidAt: { gte: bonusPeriodStart, lte: bonusPeriodEnd },
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
    // Персональный bonusPercent, если > 0, перебивает сетку.
    //
    // ОДИН МЕСЯЦ — одна полоса. НЕСКОЛЬКО — каждый месяц со своей полосой,
    // суммой. Ставку «за период целиком» не показываем: у трёх месяцев их
    // три, и одно число тут врало бы.
    const singleMonth = bonusMonths.length === 1 ? bonusMonths[0] : null;
    const bonusPercent = singleMonth ? singleMonth.percent : null;
    const band = singleMonth ? singleMonth.band : null;
    const usePersonal = bonusMonths.some((m) => m.source === 'PERSONAL');
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
    for (const m of bonusMonths) {
      const agg = await this.prisma.salaryRecord.aggregate({
        where: {
          userId,
          periodStart: { lte: m.periodEnd },
          periodEnd: { gte: m.periodStart },
        },
        _sum: { bonusAmount: true },
      });
      const alreadyPaid = round(agg._sum.bonusAmount || 0);
      monthsWithDue.push({
        month: m,
        alreadyPaid,
        due: Math.max(0, round(m.monthTotal - alreadyPaid)),
      });
    }
    const bonusAlreadyPaid = round(monthsWithDue.reduce((sum, x) => sum + x.alreadyPaid, 0));
    /** К начислению сейчас = месячные комиссии минус уже начисленное. */
    const bonusAmount = round(monthsWithDue.reduce((sum, x) => sum + x.due, 0));

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
      /** 'BAND' — ставка из сетки; 'PERSONAL' — персональный процент юзера. */
      bonusSource: usePersonal ? ('PERSONAL' as const) : ('BAND' as const),
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

    // Быстрый отказ до тяжёлого preview: запись за этот период уже есть.
    // Это НЕ гард (проверка гоночная сама по себе) — настоящие гарды ниже:
    // SERIALIZABLE-транзакция и уникальный индекс. Здесь — только чтобы не
    // гонять агрегаты по платежам ради заведомо отклонённого запроса и
    // чтобы бухгалтер увидел внятное 400, а не 500 от индекса.
    const alreadyExists = await this.prisma.salaryRecord.findFirst({
      where: { userId: dto.userId, periodStart: start },
      select: { id: true },
    });
    if (alreadyExists) throw new BadRequestException(DUPLICATE_PERIOD_MESSAGE);

    const preview = await this.preview(dto.userId, start, end, dto.kpiBonus || 0);

    const record = await this.insertRecordAtomically({
      userId: dto.userId,
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
    const eff = await this.penaltiesSvc.effectivePenaltiesForUser(dto.userId, start, end);
    const effectiveIds = eff.items
      .filter((i: any) => i.excuseStatus !== 'PENDING' && i.excuseStatus !== 'APPROVED')
      .map((i: any) => i.id as string);
    await this.penaltiesSvc.markApplied(dto.userId, start, end, effectiveIds);
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
            for (const m of args.bonusMonths) {
              const agg = await tx.salaryRecord.aggregate({
                where: {
                  userId: args.userId,
                  periodStart: { lte: m.periodEnd },
                  periodEnd: { gte: m.periodStart },
                },
                _sum: { bonusAmount: true },
              });
              const paid = round(agg._sum.bonusAmount || 0);
              bonusAlreadyPaid += paid;
              bonusAmount += Math.max(0, round(m.monthTotal - paid));
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
                bonusSource: args.bonusSource,
                comment: args.comment,
              },
              include: { user: { select: { id: true, fullName: true, role: true } } },
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
      select: { id: true, status: true },
    });
    if (!rec) throw new NotFoundException('Запись не найдена');
    if (rec.status === 'PAID') {
      throw new BadRequestException(
        'Выплаченную зарплату нельзя удалить — используйте сторнирование',
      );
    }
    return this.prisma.salaryRecord.delete({ where: { id } });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
