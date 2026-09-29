/**
 * ЕДИНЫЙ РАСЧЁТ БОНУСА МЕНЕДЖЕРА: какие платежи засчитаны, в какой месяц,
 * на какую сумму в сомони, какая ставка и сколько осталось до следующей.
 *
 * Этим модулем пользуются ВСЕ экраны, где звучит слово «продажи» или
 * «бонус»: Зарплата (salary.service), KPI-рейтинг и окно подробностей
 * (kpi.service через common/manager-sales.ts), досье сотрудника
 * (users.service). Фильтры платежей живут ТОЛЬКО в loadCountedPayments()
 * ниже — копировать их куда-то ещё нельзя, иначе экраны разъедутся (ровно
 * так раньше KPI показывал одно, а зарплата платила другое).
 *
 * ═══ ПРАВИЛО (решение учредителя, 2026-09-29) ═══
 *  • В объём идёт СУММА КАЖДОГО ПЛАТЕЖА, одобренного основателем
 *    (SubmissionPayment.status = APPROVED). Неодобренный — не входит.
 *  • Месяц — МЕСЯЦ ОПЛАТЫ (paidAt, «Дата оплаты» у платежа): «заплатил в
 *    октябре — бонус за октябрь», даже если одобрили в ноябре
 *    (BONUS_MONTH_RULE ниже). Календарный месяц Asia/Dushanbe.
 *  • Одобрили, когда зарплата за месяц оплаты уже зафиксирована, — комиссия
 *    того месяца выросла (иногда вместе со ставкой), а запись уже лежит.
 *    Разницу доплачивает следующая зарплатная запись («доплата за месяц»,
 *    salary.service → bonusArrearsMonths). Так платёж не теряется и не
 *    платится дважды.
 *  • Кому — менеджеру, записанному в платёж в момент одобрения
 *    (creditedManagerId); у строк без снапшота — владельцу сделки.
 *  • Сумма в сомони. TJS-сделка — amount как есть. Сделка в другой валюте —
 *    amountTjs, который основатель вводит при одобрении (курса валют в
 *    системе нет). Валютный платёж без amountTjs (одобрен до этой правки)
 *    в объём не входит и показывается отдельно (nonTjs).
 *  • Отменённая сделка и платёж с развёрнутой финансовой транзакцией
 *    (reversedAt) — не входят (parity с finance).
 *  • Ставка — ОДНА полоса на ВЕСЬ месячный объём (common/bonus-bands.ts),
 *    одинаково для всех. Персонального процента больше нет: User.bonusPercent
 *    остался в схеме, но не читается.
 *
 * ═══ ИСТОРИЯ ПРАВИЛА И ПОЧЕМУ ОНО ХРАНИТСЯ У ПЛАТЕЖА ═══
 * До 2026-09-26 платёж ложился в месяц по paidAt, с 26.09 по 29.09 — по
 * месяцу одобрения (reviewedAt), с 29.09 снова по paidAt, теперь уже с
 * доплатой за поздно одобренные. approvePayment пишет в платёж правило, по
 * которому его засчитали (SubmissionPayment.bonusMonthBy), NULL у старых
 * строк значит «по paidAt»: смена BONUS_MONTH_RULE меняет только НОВЫЕ
 * одобрения и не переносит платёж, за который уже заплатили, в другой месяц
 * (иначе он попал бы в две зарплаты). Одобренные 26–29.09 строки переведены
 * на месяц оплаты скриптом prisma/migrate-bonus-month-payment.ts — кроме тех,
 * что уже вошли в зафиксированную зарплату месяца одобрения: они остаются
 * 'APPROVAL' и считаются по reviewedAt.
 */
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { tjEndOfMonth, tjStartOfMonth } from './tj-time';
import { MANAGER_BONUS_BANDS, ManagerBonusBand, computeManagerBonus, findManagerBonusBand } from './bonus-bands';
import { REPORTING_CURRENCY } from './reporting-currency';

/**
 * Валюта бонусной базы — тот же REPORTING_CURRENCY, что у finance / salary /
 * kpi (common/reporting-currency.ts), а не отдельный литерал.
 */
export const MANAGER_BONUS_CURRENCY = REPORTING_CURRENCY;

/**
 *  'APPROVAL' — платёж ложится в месяц, когда основатель его одобрил;
 *  'PAYMENT'  — в месяц, когда менеджер получил деньги (paidAt).
 */
export type BonusMonthRule = 'APPROVAL' | 'PAYMENT';

/**
 * Правило для НОВЫХ одобрений — месяц оплаты (решение учредителя
 * 2026-09-29; с 26.09 было 'APPROVAL'). Уже одобренные платежи остаются по
 * правилу, записанному в них самих (см. шапку файла).
 */
export const BONUS_MONTH_RULE: BonusMonthRule = 'PAYMENT';

type Db = PrismaService | Prisma.TransactionClient;

/** Одобренный платёж, засчитанный менеджеру в объём (или валютный — в nonTjs). */
export interface CountedPayment {
  id: string;
  /** Кому засчитан. */
  managerId: string;
  /** По какому правилу лёг в месяц. */
  rule: BonusMonthRule;
  /** Момент, определяющий месяц: paidAt ('PAYMENT') или reviewedAt (строки 'APPROVAL' 26–29.09). */
  countedAt: Date;
  paidAt: Date;
  reviewedAt: Date | null;
  /** Сумма в валюте сделки. */
  amount: number;
  /** Валюта сделки как есть (без нормализации — см. approvePayment). */
  currency: string;
  /**
   * Сумма в сомони, которая идёт в объём. null — валютный платёж без суммы
   * в сомони: в объём НЕ входит, показывается отдельно.
   */
  amountTjs: number | null;
  financeTransactionId: string | null;
  notes: string | null;
  submissionId: string;
  studentId: string | null;
  student: { id: string; fullName: string } | null;
  newStudentName: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function rangeFilter(range: { from?: Date; to?: Date }): Prisma.DateTimeFilter | undefined {
  if (!range.from && !range.to) return undefined;
  return { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) };
}

/**
 * Все одобренные платежи, засчитанные этим менеджерам за период.
 * ЕДИНСТВЕННОЕ место, где живут фильтры бонусной базы.
 *
 * Период режется по countedAt: по paidAt, а у оставшихся строк с правилом
 * 'APPROVAL' (одобрены 26–29.09 и уже вошли в зарплату месяца одобрения) —
 * по reviewedAt. Без границ — за всё время.
 */
export async function loadCountedPayments(
  db: Db,
  userIds: string[],
  range: { from?: Date; to?: Date } = {},
): Promise<CountedPayment[]> {
  if (!userIds.length) return [];
  const date = rangeFilter(range);
  const rows = await db.submissionPayment.findMany({
    where: {
      status: 'APPROVED',
      submission: { status: { not: 'CANCELLED' } },
      AND: [
        {
          OR: [
            { creditedManagerId: { in: userIds } },
            // Строки, одобренные до появления снапшота, — владельцу сделки.
            { creditedManagerId: null, submission: { managerId: { in: userIds } } },
          ],
        },
        ...(date
          ? [
              {
                OR: [
                  { bonusMonthBy: 'APPROVAL', reviewedAt: date },
                  // NULL — одобрено до 2026-09-26, 'PAYMENT' — с 2026-09-29: по paidAt.
                  { OR: [{ bonusMonthBy: null }, { bonusMonthBy: 'PAYMENT' }], paidAt: date },
                ],
              },
            ]
          : []),
      ],
    },
    select: {
      id: true, amount: true, amountTjs: true, paidAt: true, reviewedAt: true, bonusMonthBy: true,
      financeTransactionId: true, creditedManagerId: true, notes: true,
      submission: {
        select: {
          id: true, managerId: true, currency: true, studentId: true, newStudentName: true,
          student: { select: { id: true, fullName: true } },
        },
      },
    },
  });

  // Платёж, чья финансовая транзакция развёрнута (отмена / ручная
  // корректировка), в объём не входит — даже если сделка не CANCELLED.
  // Отношения SubmissionPayment → Transaction в схеме нет (голый @unique id),
  // поэтому вторым запросом.
  const linked = rows.map((p) => p.financeTransactionId).filter((x): x is string => !!x);
  const reversed = new Set<string>();
  if (linked.length) {
    const tx = await db.transaction.findMany({
      where: { id: { in: linked }, reversedAt: { not: null } },
      select: { id: true },
    });
    for (const t of tx) reversed.add(t.id);
  }

  const wanted = new Set(userIds);
  const out: CountedPayment[] = [];
  for (const p of rows) {
    if (p.financeTransactionId && reversed.has(p.financeTransactionId)) continue;
    const managerId = p.creditedManagerId ?? p.submission.managerId;
    if (!managerId || !wanted.has(managerId)) continue;
    const rule: BonusMonthRule = p.bonusMonthBy === 'APPROVAL' ? 'APPROVAL' : 'PAYMENT';
    const currency = p.submission.currency || MANAGER_BONUS_CURRENCY;
    out.push({
      id: p.id,
      managerId,
      rule,
      countedAt: rule === 'APPROVAL' && p.reviewedAt ? p.reviewedAt : p.paidAt,
      paidAt: p.paidAt,
      reviewedAt: p.reviewedAt,
      amount: p.amount || 0,
      currency,
      amountTjs: currency === MANAGER_BONUS_CURRENCY ? p.amount || 0 : p.amountTjs ?? null,
      financeTransactionId: p.financeTransactionId,
      notes: p.notes,
      submissionId: p.submission.id,
      studentId: p.submission.studentId,
      student: p.submission.student,
      newStudentName: p.submission.newStudentName,
    });
  }
  out.sort((a, b) => b.countedAt.getTime() - a.countedAt.getTime());
  return out;
}

/**
 * Можно ли сменить дату оплаты ОДОБРЕННОГО платежа.
 *
 * Бонус считается по месяцу оплаты, поэтому смена МЕСЯЦА в paidAt переносит
 * платёж между бонусными месяцами. Если зарплата менеджера за старый месяц
 * уже рассчитана, бонус за платёж там уже учтён (или доплачен) — перенос
 * начислил бы его второй раз. Если рассчитана зарплата за новый месяц, её
 * расчёт платёж не видел, а доплата его не узнает (одобрен раньше расчёта) —
 * бонус потерялся бы. Поэтому такой перенос запрещён, пока расчёт не удалён:
 * черновик можно удалить, перенести дату и рассчитать заново.
 *
 * Внутри месяца дата меняется свободно. Неодобренный платёж в бонус ещё не
 * входит. Строки 'APPROVAL' (одобрены 26–29.09) считаются по дате одобрения —
 * их дата оплаты на бонус не влияет.
 *
 * Возвращает начало месяца, который мешает переносу, или null — можно.
 */
export async function bonusMonthLockedFor(
  db: Db,
  payment: { status: string; paidAt: Date; bonusMonthBy: string | null; creditedManagerId: string | null },
  ownerManagerId: string | null,
  newPaidAt: Date,
): Promise<Date | null> {
  if (payment.status !== 'APPROVED' || payment.bonusMonthBy === 'APPROVAL') return null;
  const from = tjStartOfMonth(payment.paidAt);
  const to = tjStartOfMonth(newPaidAt);
  if (from.getTime() === to.getTime()) return null;
  const managerId = payment.creditedManagerId ?? ownerManagerId;
  if (!managerId) return null;
  for (const m of [from, to]) {
    const fixed = await db.salaryRecord.findFirst({
      where: { userId: managerId, periodStart: { lte: tjEndOfMonth(m) }, periodEnd: { gte: m } },
      select: { id: true },
    });
    if (fixed) return m;
  }
  return null;
}

/** Сумма в сомони по засчитанным платежам (валютные без суммы в сомони — мимо). */
export function sumCountedTjs(payments: CountedPayment[]): number {
  // Округление до копеек ЗДЕСЬ обязательно: IEEE-754-накопление обычных
  // двухзначных сумм даёт 150000.00000000003 вместо 150 000 → «v <= 150000»
  // ложно → 6% вместо 5% (подробно — в bonus-bands.ts).
  return round2(payments.reduce((s, p) => s + (p.amountTjs ?? 0), 0));
}

/** Валютные платежи без суммы в сомони — по кодам валют, в исходной валюте. */
export function nonTjsCounted(payments: CountedPayment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of payments) {
    if (p.amountTjs !== null) continue;
    out[p.currency] = round2((out[p.currency] || 0) + p.amount);
  }
  return out;
}

export interface ManagerBonusVolume {
  /** Начало календарного месяца Asia/Dushanbe. */
  periodStart: Date;
  /** Последняя мс месяца, inclusive. */
  periodEnd: Date;
  /** Объём в сомони за месяц, округлён до копеек. */
  volume: number;
}

/** Бонусный объём менеджера за календарный месяц, в который попадает `ref`. */
export async function managerBonusVolume(db: Db, userId: string, ref: Date): Promise<ManagerBonusVolume> {
  // Границы — из tj-time: сервер живёт в UTC, и `new Date(y, m, 1)` дал бы
  // месяц с 05:00 по Душанбе — первая ночь месяца уехала бы в прошлый.
  const periodStart = tjStartOfMonth(ref);
  const periodEnd = tjEndOfMonth(ref);
  const payments = await loadCountedPayments(db, [userId], { from: periodStart, to: periodEnd });
  return { periodStart, periodEnd, volume: sumCountedTjs(payments) };
}

/** Объёмы месяца сразу по многим менеджерам — одним запросом (рейтинг KPI). */
export async function managerBonusVolumes(db: Db, userIds: string[], ref: Date): Promise<Map<string, ManagerBonusVolume>> {
  const periodStart = tjStartOfMonth(ref);
  const periodEnd = tjEndOfMonth(ref);
  const sums = new Map<string, number>();
  for (const id of userIds) sums.set(id, 0);
  const payments = await loadCountedPayments(db, userIds, { from: periodStart, to: periodEnd });
  for (const p of payments) sums.set(p.managerId, (sums.get(p.managerId) ?? 0) + (p.amountTjs ?? 0));
  const out = new Map<string, ManagerBonusVolume>();
  for (const [id, v] of sums) out.set(id, { periodStart, periodEnd, volume: round2(v) });
  return out;
}

/**
 * 'BAND' — ставка из сетки. 'PERSONAL' больше не производится, но остаётся в
 * типе: так помечены старые зарплатные записи, начисленные по личному
 * проценту, и CRM должна уметь их показать.
 */
export type ManagerBonusSource = 'BAND' | 'PERSONAL';

export interface EffectiveManagerBonus {
  /** Ставка, которая применяется ко ВСЕМУ объёму. */
  percent: number;
  source: 'BAND';
  band: ManagerBonusBand;
}

/** Ставка комиссии для объёма — всегда по сетке, одинаково для всех. */
export function effectiveManagerBonus(volume: number): EffectiveManagerBonus {
  const band = findManagerBonusBand(volume);
  return { percent: band.percent, source: 'BAND', band };
}

export interface ManagerBonusMonth {
  periodStart: Date;
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
 * Полосу определяет объём за календарный месяц, поэтому у каждого задетого
 * месяца — своя полоса, суммы складываются. Складывать ОБЪЁМЫ и брать одну
 * полосу на весь период нельзя: ставка зависела бы от выбранного на экране
 * диапазона (выбрал полгода — получил 8%). Месяц входит целиком; от двойной
 * оплаты защищает вычет уже начисленного за месяц (salary.service).
 */
export async function managerBonusMonths(db: Db, userId: string, from: Date, to: Date): Promise<ManagerBonusMonth[]> {
  const months: ManagerBonusMonth[] = [];
  let cursor = tjStartOfMonth(from);
  // Страховка от бесконечного цикла: create() ограничивает период годом,
  // но preview зовут и напрямую.
  for (let guard = 0; cursor.getTime() <= to.getTime() && guard < 24; guard++) {
    const { periodStart, periodEnd, volume } = await managerBonusVolume(db, userId, cursor);
    const eff = effectiveManagerBonus(volume);
    months.push({
      periodStart,
      periodEnd,
      volume,
      band: eff.band,
      percent: eff.percent,
      source: eff.source,
      monthTotal: computeManagerBonus(volume).amount,
    });
    // Следующий месяц — от первой мс после конца текущего, снова через
    // tj-time: «месяц + 1» на сыром Date промахивается мимо месяцев разной длины.
    cursor = tjStartOfMonth(new Date(periodEnd.getTime() + 1));
  }
  return months;
}

/** Прогресс менеджера к следующей ставке — для полоски в KPI и профиле. */
export interface ManagerBonusProgress {
  periodStart: Date;
  periodEnd: Date;
  /** Набрано в сомони за месяц. */
  volume: number;
  /** Текущая полоса и ставка. */
  band: ManagerBonusBand;
  percent: number;
  /** Комиссия на сегодняшний объём (объём × ставка), до вычета начисленного. */
  bonus: number;
  /** Следующая полоса; null — уже максимальная ставка. */
  nextBand: ManagerBonusBand | null;
  /** Сколько не хватает до следующей полосы; null — максимальная ставка. */
  toNext: number | null;
  /** Вся сетка — CRM рисует шкалу и отмечает на ней объём. */
  bands: readonly ManagerBonusBand[];
}

export function managerBonusProgress(vol: ManagerBonusVolume): ManagerBonusProgress {
  const { band, percent, amount } = computeManagerBonus(vol.volume);
  const idx = MANAGER_BONUS_BANDS.findIndex((b) => b.key === band.key);
  const nextBand = idx >= 0 && idx < MANAGER_BONUS_BANDS.length - 1 ? MANAGER_BONUS_BANDS[idx + 1] : null;
  return {
    periodStart: vol.periodStart,
    periodEnd: vol.periodEnd,
    volume: vol.volume,
    band,
    percent,
    bonus: amount,
    nextBand,
    // До нижней границы следующей полосы — ровно как границы подписаны в
    // CRM («75 001 – 150 000 → 5%»).
    toNext: nextBand ? Math.max(0, round2(nextBand.minAmount - vol.volume)) : null,
    bands: MANAGER_BONUS_BANDS,
  };
}

/**
 * Доля месяца, попавшая в период — для окладной части.
 *
 * Оклад задан за месяц: за период в три месяца его надо начислить трижды, за
 * половину месяца — половину. Считаем долей времени (мс/мс), а не днями —
 * не спотыкается о месяцы разной длины.
 */
export function monthCoverageShare(monthStart: Date, monthEnd: Date, from: Date, to: Date): number {
  const start = Math.max(monthStart.getTime(), from.getTime());
  const end = Math.min(monthEnd.getTime(), to.getTime());
  const span = monthEnd.getTime() - monthStart.getTime();
  if (span <= 0 || end <= start) return 0;
  return Math.min(1, (end - start) / span);
}
