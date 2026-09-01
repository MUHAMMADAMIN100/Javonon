/**
 * ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ по отчётной валюте.
 *
 * ═══ ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ ═══
 * `Transaction.currency` — свободная строка со `@default("TJS")`
 * (schema.prisma), а `create()` в FinanceService пропускает пять валют
 * (TJS/USD/EUR/CNY/RUB). Любой `_sum: { amount: true }` БЕЗ фильтра по
 * валюте складывает USD 5 000 с TJS 5 000 как безразмерные числа, и
 * результат всё равно рисуется на фронте как сомони.
 *
 * Этот баг чинили трижды, каждый раз своей копией литерала:
 *   • finance.service.ts     — `REPORTING_CURRENCY`
 *   • salary.service.ts      — `SALARY_REPORTING_CURRENCY`
 *   • submissions.service.ts — локальный `REPORTING_CURRENCY` внутри метода
 *   • common/bonus-bands.ts  — `MANAGER_BONUS_BANDS_CURRENCY`
 * а KPI-модуль так и остался несинхронизированным (audit HIGH:
 * «KPI leaderboard salesAmount sums all currencies without conversion»).
 * Четыре копии одного литерала — это четыре места, где он может разъехаться,
 * и ноль мест, где расхождение заметно на ревью. Поэтому константа живёт
 * здесь, а модули её импортируют (при необходимости — под своим локальным
 * псевдонимом, чтобы не переписывать сотни существующих строк).
 *
 * ═══ ПОЛИТИКА ═══
 * Пока нет FX-конвертации на write-time, все денежные АГРЕГАТЫ считаются
 * ТОЛЬКО по этой валюте, а «отброшенные» не-TJS суммы возвращаются
 * отдельным информационным полем (`nonTjsTotals` в finance, `nonTjsSales`
 * в salary и kpi) — деньги не участвуют в расчёте, но и не пропадают молча.
 *
 * ═══ ЕДИНИЦЫ ═══
 * Целые сомони (TJS): Transaction.amount / SubmissionPayment.amount /
 * SalaryRecord.* — Float в целых единицах валюты, НЕ дирамы.
 */
export const REPORTING_CURRENCY = 'TJS';

/**
 * Разбивка сумм по НЕ-отчётным валютам: код валюты → сумма в исходной
 * валюте. Пустой объект означает, что период был чисто в TJS и фронту
 * нечего дополнительно показывать. Общая форма для salary.preview()
 * (`nonTjsSales`) и kpi.leaderboard() (`nonTjsSales`).
 */
export type NonReportingCurrencyBreakdown = Record<string, number>;
