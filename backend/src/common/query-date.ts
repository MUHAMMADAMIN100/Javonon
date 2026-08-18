import { BadRequestException } from '@nestjs/common';
import { tjParseLocalDate, tjParseLocalDateEnd } from './tj-time';

/**
 * Единый парсер query-параметров `from` / `to` для всех эндпоинтов,
 * принимающих период (finance/*, applications/stats, students/stats).
 *
 * Раньше жил локально в finance.controller.ts. Вынесен сюда, когда
 * dashboard-переключатель периода потребовал того же парсинга в
 * applications/students controllers: импортировать функцию из чужого
 * *.controller.ts — значит тянуть за собой весь его модуль (multer,
 * FinanceService, NotificationsService) ради одной чистой функции.
 * Второй (третий) экземпляр парсера — это ровно тот путь, которым в
 * проекте уже разъезжались границы суток, поэтому парсер один на всех.
 *
 * endOfDay=true — если пришла date-only строка "YYYY-MM-DD" (её присылает
 * <input type="date"> и наш календарный пикер), поднимаем её до конца
 * суток 23:59:59.999 Asia/Dushanbe. Иначе `new Date("2026-01-31")` даёт
 * 2026-01-31T00:00:00Z, а фильтр `date <= to` молча выкидывает всё с
 * этой даты после полуночи UTC — целый последний день пропадал из
 * summary/breakdown/timeseries/etc. Bug: менеджер смотрит на пирог и не
 * видит платёж, зарегистрированный сегодня днём.
 *
 * TZ-fix (issue #4): раньше здесь стоял `new Date(v) + setUTCHours(23,…)`,
 * что давало границу по UTC-суткам. Из-за offset UTC+5 в Душанбе
 * «2026-01-31» на самом деле начинается в 19:00 UTC 30-го числа, поэтому
 * фильтр с UTC-границами обрезал последние 5 часов суток TJT в каждом
 * периоде. Единый парсер через tjParseLocalDate/tjParseLocalDateEnd
 * делает границы согласованными с остальным бэкендом (reports, salary,
 * attendance, kpi и т.д.).
 *
 * Использовать endOfDay=true только для «правой» границы диапазона (to).
 * Для `from` фактическое 00:00 TJT — это как раз то, что нужно.
 */
export function parseDate(
  v: string | undefined,
  name: string,
  endOfDay = false,
): Date | undefined {
  if (!v) return undefined;
  const d = endOfDay ? tjParseLocalDateEnd(v) : tjParseLocalDate(v);
  if (isNaN(d.getTime())) throw new BadRequestException(`${name}: некорректная дата`);
  return d;
}

/**
 * `{ from, to }` → фильтр Prisma для DateTime-поля, либо `undefined`,
 * если границ нет вообще.
 *
 * Возврат именно `undefined` (а не `{}`) важен: вызывающий по нему решает,
 * трогать ли базовый `where`. Без периода where обязан остаться ровно тем,
 * чем был (в т.ч. `undefined` для elevated-ролей) — «всё время».
 */
export function dateRangeFilter(range?: {
  from?: Date;
  to?: Date;
}): { gte?: Date; lte?: Date } | undefined {
  if (!range?.from && !range?.to) return undefined;
  const filter: { gte?: Date; lte?: Date } = {};
  if (range.from) filter.gte = range.from;
  // lte, а не lt: `to` уже поднят до 23:59:59.999 TJT парсером выше,
  // т.е. граница inclusive по календарному дню Душанбе.
  if (range.to) filter.lte = range.to;
  return filter;
}
