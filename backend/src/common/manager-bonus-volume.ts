/**
 * ЕДИНЫЙ РАСЧЁТ БОНУСНОГО ОБЪЁМА МЕНЕДЖЕРА И ДЕЙСТВУЮЩЕЙ СТАВКИ.
 *
 * Зачем отдельный модуль: объём и ставку показывают ТРИ экрана —
 *   1) Зарплата (preview у бухгалтера/учредителя, salary.service.preview),
 *   2) Досье сотрудника /me и /me/profile/:id (users.service.fullProfile),
 *   3) KPI-рейтинг /kpi (kpi.service.leaderboard — «ВАШИ ПРОДАЖИ» и
 *      сортировка мест),
 * и это единственное место, где менеджер видит СВОЙ процент комиссии.
 * Пока расчёт жил только в salary.service, досье показывало сырое
 * `user.bonusPercent` — то есть «0%» у каждого, кто сидит на сетке,
 * при 6% на экране зарплаты. Одна функция — один ответ на всех экранах.
 *
 * ═══ AUDIT HIGH: «два несовместимых определения объёма» ═══
 * Число, по которому менеджеру ПЛАТЯТ, и число, которое ему ПОКАЗЫВАЮТ
 * шрифтом в 104px на /kpi, считались из разных таблиц:
 *   salary  — SubmissionPayment, APPROVED, окно по paidAt, только TJS,
 *             сделка не CANCELLED, минус платежи с развёрнутой транзакцией;
 *   kpi     — Transaction, type=INCOME, окно по `date` (= payment.paidAt),
 *             ЛЮБЫЕ категории, включая ручные не-TUITION проводки.
 * Для одного менеджера и одного месяца это разные суммы: платёж, принятый
 * 30 января и одобренный 2 февраля, попадал в «январь» на KPI и в
 * «февраль» в зарплате; ручная INCOME-строка раздувала KPI, хотя из
 * бонусной базы она намеренно исключена (salary отдаёт её отдельным
 * manualSalesAmount). Гарантированный спор о зарплате — и ни на одном
 * экране не было объяснения расхождения.
 * КАНОНИЧЕСКИМ выбрано зарплатное определение (ТЗ: «объём = одобренные
 * платежи по заявкам»), потому что по нему реально платят. KPI больше не
 * считает объём сам — он вызывает approvedSalesByManager() ниже, ту же
 * функцию, из которой объём берёт managerBonusVolume(). Не «такой же
 * запрос», а буквально один и тот же код.
 *
 * Правила (те же, что в salary.service — здесь их физический дом):
 *  • объём = APPROVED-платежи по сделкам, окно по paidAt (дата, когда
 *    менеджер реально получил деньги — см. блок «ЯКОРЬ = paidAt» ниже);
 *    для бонуса окно = КАЛЕНДАРНЫЙ месяц Asia/Dushanbe, для KPI — период,
 *    выбранный на экране (тем же парсером Asia/Dushanbe);
 *  • только TJS (пороги полос заданы в TJS, см. bonus-bands.ts);
 *  • отменённые сделки и платежи с развёрнутой (reversedAt) финансовой
 *    транзакцией исключены — parity с finance;
 *  • ручные INCOME-транзакции в объём НЕ входят;
 *
 * ═══ ЯКОРЬ ПЕРИОДА = paidAt, А НЕ reviewedAt ═══
 * Раньше платёж попадал в месяц по reviewedAt — по моменту, когда FOUNDER
 * нажал «одобрить». Это ставило зарплату менеджера в зависимость от чужой
 * расторопности, и при ПЛОСКОЙ полосе цена ошибки максимальная: один
 * платёж, переехавший через границу месяца, меняет ставку НА ВЕСЬ объём
 * месяца, а не только на себя.
 *
 * На боевых данных (сентябрь 2026, Khurshed Hakimov) это выглядело так:
 * 15 платежей на 83 750 TJS получены в ИЮНЕ, а заведены в систему 1 июля
 * и одобрены 1–6 июля. Июнь у менеджера был нулевым, вся июньская работа
 * уехала в июль и раздула его до 119 750. Платёж 2 000, полученный
 * 30 июля, одобрен 2 августа — и ушёл в августовскую полосу.
 *
 * Теперь якорь — paidAt: месяц определяет дата, когда деньги реально
 * пришли. Одобрение остаётся ФИЛЬТРОМ (status='APPROVED'): неодобренный
 * платёж в объём не входит вовсе, а когда его одобрят — попадёт в СВОЙ
 * месяц, а не в текущий.
 *
 * Побочный эффект — сходимость с остальными экранами: approvePayment
 * пишет Transaction.date = payment.paidAt (submissions.service), а KPI и
 * /finance режут период по Transaction.date. То есть до этой правки
 * зарплата была ЕДИНСТВЕННЫМ модулем, жившим по другому якорю.
 *
 * Плата за это — задним числом одобренный платёж меняет уже посчитанный
 * месяц. Дыру закрывает не запрет, а вычитание: salary.service считает
 * комиссию за месяц целиком и вычитает уже начисленное по этому месяцу
 * (bonusAlreadyPaid), так что доплачивается только разница, а забрать
 * назад уже выплаченное невозможно (Math.max(0, …)).
 *  • ставка — FLAT по полосе на весь объём, не по срезам;
 *  • персональный процент (User.bonusPercent) перебивает сетку только
 *    если он > 0; 0 означает «по сетке».
 */
import { PrismaService } from '../prisma/prisma.service';
import { tjEndOfMonth, tjStartOfMonth } from './tj-time';
import { ManagerBonusBand, computeManagerBonus, findManagerBonusBand } from './bonus-bands';
import { NonReportingCurrencyBreakdown, REPORTING_CURRENCY } from './reporting-currency';

/**
 * Валюта бонусной базы. НЕ отдельный литерал: тот же REPORTING_CURRENCY,
 * что у finance / salary / kpi (см. common/reporting-currency.ts). Именно
 * расхождение копий этого литерала по модулям и породило серию currency-
 * mixing багов — держим одну константу и алиасы к ней.
 */
export const MANAGER_BONUS_CURRENCY = REPORTING_CURRENCY;

export interface ManagerBonusVolume {
  /** Начало календарного месяца Asia/Dushanbe. */
  periodStart: Date;
  /** Последняя мс месяца, inclusive. */
  periodEnd: Date;
  /** Сумма APPROVED-платежей (TJS) за месяц. Без округления. */
  volume: number;
}

/** 'BAND' — ставка из сетки; 'PERSONAL' — персональный процент юзера. */
export type ManagerBonusSource = 'BAND' | 'PERSONAL';

export interface EffectiveManagerBonus {
  /** Ставка, которая РЕАЛЬНО применяется к объёму. */
  percent: number;
  source: ManagerBonusSource;
  /** Персональный override из User.bonusPercent (0 = не задан). */
  personalPercent: number;
  /** Полоса объёма — считается всегда, даже при персональном проценте. */
  band: ManagerBonusBand;
}

/**
 * Бонусный объём менеджера за календарный месяц, в который попадает `ref`.
 * Выдёргивать эти фильтры куда-то ещё нельзя — иначе экраны разъедутся.
 */
export async function managerBonusVolume(
  prisma: PrismaService,
  userId: string,
  ref: Date,
): Promise<ManagerBonusVolume> {
  // Границы берём из tj-time: сервер живёт в UTC, и `new Date(y, m, 1)` дал
  // бы месяц, начинающийся 1-го числа в 05:00 по Душанбе — платежи первой
  // ночи месяца уехали бы в предыдущий месяц и в чужую полосу.
  const periodStart = tjStartOfMonth(ref);
  const periodEnd = tjEndOfMonth(ref);
  // ЧЕЙ ЭТО ПЛАТЁЖ. Приоритет у снапшота creditedManagerId — менеджера,
  // записанного в момент APPROVE (submissions.service). Снапшот переживает
  // удаление сотрудника: SaleSubmission.managerId стоит на onDelete: SetNull,
  // и hard-delete в UsersService.remove() обнулял его у ВСЕХ сделок уволенного
  // — после чего пересчёт любого прошлого месяца отдавал объём 0.
  //
  // Fallback на submission.managerId нужен для строк, одобренных ДО появления
  // колонки: у них снапшот пустой. Просто переключить фильтр на
  // creditedManagerId нельзя — на проде эта колонка появляется пустой у всех
  // существующих платежей, и объём обнулился бы у каждого менеджера разом.
  // Условие ниже даёт ровно сегодняшнее поведение на старых строках и уже
  // правильное — на новых, без миграции данных.
  const candidates = await prisma.submissionPayment.findMany({
    where: {
      status: 'APPROVED',
      paidAt: { gte: periodStart, lte: periodEnd },
      submission: {
        status: { not: 'CANCELLED' },
        currency: MANAGER_BONUS_CURRENCY,
      },
      OR: [
        { creditedManagerId: userId },
        { creditedManagerId: null, submission: { managerId: userId } },
      ],
    },
    select: { amount: true, financeTransactionId: true },
  });
  // Второй якорь (parity с finance): linked Transaction.reversedAt.
  // Пропускаем платежи, чья финансовая запись помечена как reversed —
  // даже если submission ещё не CANCELLED (ручная корректировка).
  const linkedIds = candidates
    .map((p) => p.financeTransactionId)
    .filter((x): x is string => !!x);
  const reversed = new Set<string>();
  if (linkedIds.length > 0) {
    const rows = await prisma.transaction.findMany({
      where: { id: { in: linkedIds }, reversedAt: { not: null } },
      select: { id: true },
    });
    for (const r of rows) reversed.add(r.id);
  }
  const rawVolume = candidates.reduce((sum, p) => {
    if (p.financeTransactionId && reversed.has(p.financeTransactionId)) return sum;
    return sum + (p.amount || 0);
  }, 0);
  // FLOAT-BAND-FIX: округляем до копеек ЗДЕСЬ, в единственной точке, где
  // объём рождается — до того, как он уйдёт в findManagerBonusBand /
  // effectiveManagerBonus / computeManagerBonus.
  // SubmissionPayment.amount — Float, и IEEE-754-накопление обычных
  // двухзначных сумм даёт значение чуть ВЫШЕ целого порога:
  //   6948.28+21080.81+4960.17+14775.2+3445.05+37396.48+61394.01
  //   = ровно 150 000.00 в десятичном виде, но 150000.00000000002910
  //   как Float → «v <= 150000» ложно → полоса 150 001–225 000 (6%)
  //   вместо 75 001–150 000 (5%) → бонус 9 000 вместо 7 500. Это 20%
  //   переплаты ровно на граничном примере из ТЗ (150 000 = 5%).
  // Ошибка ОДНОСТОРОННЯЯ — всегда в пользу переплаты, никогда наоборот,
  // и повторяется на 75 000 / 225 000 / 300 000. Плюс отображение
  // противоречило само себе: salary.service печатает bonusVolume уже
  // округлённым, и CRM рисовала «объём 150 000 → полоса 150 001–225 000».
  // Округление объёма — тот самый шаг, без которого рассуждение
  // «сравниваем только с верхней границей» в bonus-bands.ts не держится.
  const volume = Math.round(rawVolume * 100) / 100;
  return { periodStart, periodEnd, volume };
}

/**
 * Действующая ставка комиссии: персональный процент, если он задан (> 0),
 * иначе ставка полосы, в которую попал объём. Полосу возвращаем всегда —
 * CRM показывает менеджеру, куда попал его объём, даже когда ставка личная.
 */
export function effectiveManagerBonus(
  personalPercentRaw: number | null | undefined,
  volume: number,
): EffectiveManagerBonus {
  const band = findManagerBonusBand(volume);
  const personalPercent = personalPercentRaw || 0;
  const usePersonal = personalPercent > 0;
  return {
    percent: usePersonal ? personalPercent : band.percent,
    source: usePersonal ? 'PERSONAL' : 'BAND',
    personalPercent,
    band,
  };
}

/** Округление до копеек — то же, что round() в salary.service. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ManagerBonusMonth {
  /** Начало календарного месяца Asia/Dushanbe. */
  periodStart: Date;
  /** Последняя мс месяца, inclusive. */
  periodEnd: Date;
  volume: number;
  band: ManagerBonusBand;
  percent: number;
  source: ManagerBonusSource;
  /** Комиссия за ЭТОТ месяц целиком, до вычета уже начисленного. */
  monthTotal: number;
}

/**
 * Разбивка комиссии по календарным месяцам, которые задевает период.
 *
 * ЗАЧЕМ. Комиссия по своей природе месячная: полосу определяет объём за
 * календарный месяц. Экран зарплаты при этом разрешает выбрать любой
 * диапазон, и раньше при периоде длиннее месяца бонус считался ТОЛЬКО за
 * месяц, в котором период начинался — за 1 июня – 1 сентября менеджер
 * получал июньскую комиссию, а июль и август пропадали молча. Часы и
 * штрафы при этом честно считались за все три месяца, то есть одна
 * квитанция складывала окна разной длины.
 *
 * Теперь каждый задетый месяц получает свою полосу и свою ставку, а суммы
 * складываются. Складывать сами ОБЪЁМЫ и брать одну полосу на весь период
 * нельзя: тогда ставка начала бы зависеть от того, какой диапазон выбрали
 * на экране — выбрал полгода, получил 8%.
 *
 * Месяц входит целиком, даже если период задевает его частично: полоса
 * определяется МЕСЯЧНЫМ объёмом, а урезанный объём занижал бы ставку.
 * От двойной оплаты защищает не урезание, а вычет уже начисленного за этот
 * месяц (salary.service).
 */
export async function managerBonusMonths(
  prisma: PrismaService,
  userId: string,
  personalPercentRaw: number | null | undefined,
  from: Date,
  to: Date,
): Promise<ManagerBonusMonth[]> {
  const months: ManagerBonusMonth[] = [];
  let cursor = tjStartOfMonth(from);
  // Страховка от бесконечного цикла: create() уже ограничивает период
  // годом, но preview зовут и напрямую.
  for (let guard = 0; cursor.getTime() <= to.getTime() && guard < 24; guard++) {
    const { periodStart, periodEnd, volume } = await managerBonusVolume(prisma, userId, cursor);
    const eff = effectiveManagerBonus(personalPercentRaw, volume);
    const monthTotal =
      eff.source === 'PERSONAL'
        ? round2((volume * eff.percent) / 100)
        : computeManagerBonus(volume).amount;
    months.push({
      periodStart,
      periodEnd,
      volume,
      band: eff.band,
      percent: eff.percent,
      source: eff.source,
      monthTotal,
    });
    // Следующий месяц — от первой мс после конца текущего, снова через
    // tj-time: арифметика вида «месяц + 1» на сыром Date промахивается
    // мимо месяцев разной длины.
    cursor = tjStartOfMonth(new Date(periodEnd.getTime() + 1));
  }
  return months;
}

/**
 * Доля месяца, попавшая в период — для окладной части.
 *
 * Оклад задан за месяц, поэтому за период в три месяца его надо начислить
 * трижды, а за половину месяца — половину. Раньше baseAmount был плоским:
 * за три месяца платился один оклад, а два аванса по половине месяца
 * приносили ДВА полных оклада. Считаем долей времени, а не днями: границы
 * приходят как мс, и деление мс на мс не спотыкается о месяцы разной длины.
 */
export function monthCoverageShare(
  monthStart: Date,
  monthEnd: Date,
  from: Date,
  to: Date,
): number {
  const start = Math.max(monthStart.getTime(), from.getTime());
  const end = Math.min(monthEnd.getTime(), to.getTime());
  const span = monthEnd.getTime() - monthStart.getTime();
  if (span <= 0 || end <= start) return 0;
  return Math.min(1, (end - start) / span);
}
