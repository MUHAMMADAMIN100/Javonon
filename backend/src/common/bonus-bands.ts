/**
 * ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ по комиссии менеджера (бонусу с продаж).
 *
 * ═══ ПОЛОСА (band), А НЕ ПРОГРЕССИВНАЯ ШКАЛА ═══
 * Объём продаж менеджера за календарный месяц попадает в ОДНУ полосу, и
 * ВЕСЬ объём умножается на ОДНУ ставку этой полосы. Это НЕ прогрессивная
 * (посрезовая) шкала: срезы не считаются и не складываются.
 *
 *   объём 200 000 → полоса 150 001–225 000 → 6% → бонус 12 000
 *   (прогрессивный расчёт дал бы 9 750 — это НЕВЕРНО, так не считаем)
 *
 * ═══ ГРАНИЦЫ ВКЛЮЧИТЕЛЬНЫЕ С ОБЕИХ СТОРОН ═══
 * `minAmount` и `maxAmount` — обе границы ВКЛЮЧИТЕЛЬНО, ровно как в ТЗ:
 *   150 000 → 5% (верх полосы 2), 150 001 → 6% (низ полосы 3).
 * Полосы стыкуются без зазоров: max предыдущей + 1 = min следующей.
 * У последней полосы maxAmount = null (без верхней границы).
 *
 * ═══ ПОЧЕМУ ХАРДКОД, А НЕ ТАБЛИЦА В БД ═══
 * Раньше сетка жила в таблице BonusTier и правилась FOUNDER'ом из
 * Настройки → Зарплата. Это дало два источника правды и тихие дыры:
 * дефолтный seed оставлял зазоры (49 990 → 50 000: объём 49 995 не
 * попадал никуда → бонус 0), а прод-база уже содержала строки со
 * старыми, неверными порогами. Ставки комиссии — договорённость
 * учредителя, меняется раз в годы и вместе с релизом, поэтому
 * фиксируем её в коде: ревью, история в git, ноль зазоров по построению.
 * Модель BonusTier и её строки НЕ удалены (см. schema.prisma) — их
 * просто больше никто не читает; /settings/bonus-tiers отдаёт проекцию
 * этой константы (read-only), чтобы CRM показывала действующую сетку.
 *
 * ═══ ЕДИНИЦЫ ═══
 * Целые сомони (TJS), как и SubmissionPayment.amount / Transaction.amount /
 * SalaryRecord.* — Float в целых единицах валюты, НЕ дирамы/центы.
 */

export interface ManagerBonusBand {
  /** Стабильный ключ для i18n на фронте (ru/tj подписи полос). */
  key: string;
  /** Нижняя граница объёма, ВКЛЮЧИТЕЛЬНО (TJS). */
  minAmount: number;
  /** Верхняя граница объёма, ВКЛЮЧИТЕЛЬНО (TJS). null = без верхней границы. */
  maxAmount: number | null;
  /** Ставка, применяемая ко ВСЕМУ объёму (проценты). */
  percent: number;
}

/** Ставка комиссии менеджера. Flat-по-полосе, границы включительные. */
export const MANAGER_BONUS_BANDS: readonly ManagerBonusBand[] = [
  { key: 'band1', minAmount: 0,       maxAmount: 75_000,  percent: 4 },
  { key: 'band2', minAmount: 75_001,  maxAmount: 150_000, percent: 5 },
  { key: 'band3', minAmount: 150_001, maxAmount: 225_000, percent: 6 },
  { key: 'band4', minAmount: 225_001, maxAmount: 300_000, percent: 7 },
  { key: 'band5', minAmount: 300_001, maxAmount: null,    percent: 8 },
] as const;

/** Валюта, в которой заданы пороги (совпадает с SALARY_REPORTING_CURRENCY). */
export const MANAGER_BONUS_BANDS_CURRENCY = 'TJS';

/**
 * Полоса для объёма продаж. Никогда не возвращает null.
 *
 * Ищем ПЕРВУЮ (полосы идут по возрастанию) полосу, чей потолок объём не
 * превышает; последняя полоса без потолка ловит всё остальное. Сравниваем
 * только с верхней границей НАМЕРЕННО: суммы — Float, и объём 75 000.50
 * при проверке «v >= min И v <= max» не попал бы никуда (пороги целые,
 * между 75 000 и 75 001 дыра). Здесь такой дыры нет: 75 000 → 4%,
 * 75 000.50 → уже выше потолка первой полосы → 5%. Отрицательное / NaN
 * трактуем как 0 → первая полоса, бонус 0.
 */
export function findManagerBonusBand(volume: number): ManagerBonusBand {
  const v = Number.isFinite(volume) && volume > 0 ? volume : 0;
  const band = MANAGER_BONUS_BANDS.find((b) => b.maxAmount === null || v <= b.maxAmount);
  return band || MANAGER_BONUS_BANDS[MANAGER_BONUS_BANDS.length - 1];
}

/**
 * Бонус = ВЕСЬ объём × ставка полосы. Округление до копеек — как round()
 * в salary.service (Math.round(n*100)/100).
 */
export function computeManagerBonus(volume: number): {
  band: ManagerBonusBand;
  percent: number;
  amount: number;
} {
  const band = findManagerBonusBand(volume);
  const v = Number.isFinite(volume) && volume > 0 ? volume : 0;
  const amount = Math.round(((v * band.percent) / 100) * 100) / 100;
  return { band, percent: band.percent, amount };
}
