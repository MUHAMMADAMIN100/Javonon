import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FINISHED_APPLICATION_STATUSES } from '../common/application-status';
import { dateRangeFilter } from '../common/query-date';
import {
  NonReportingCurrencyBreakdown,
  REPORTING_CURRENCY,
} from '../common/reporting-currency';

@Injectable()
export class KpiService {
  constructor(private prisma: PrismaService) {}

  /**
   * Сводный KPI по сотрудникам:
   *  - applicationsAssigned — сколько заявок назначено
   *  - applicationsEnrolled — сколько дошло до SUCCESSFUL_LEAD (успешный лид;
   *    легаси ENROLLED/COMPLETED считаются тем же, см. common/application-status)
   *  - conversionRate — % конверсии
   *  - studentsCount — сколько из заведённых студентов сейчас ACTIVE
   *  - salesAmount — сумма продаж клиентов этого менеджера
   *  - tasksOpen / tasksDone
   *
   * ПЕРИОД — ОДНО ПРАВИЛО НА ВСЕ МЕТРИКИ: «СОЗДАНО В ПЕРИОДЕ».
   *
   * Границы накладываются на дату появления самой записи (createdAt; у
   * транзакции — её собственная `date`, см. ниже), и ни на какое поле
   * «когда последний раз тронули». Это то же правило, что у
   * /applications/stats, /students/stats и /finance/summary, то есть у
   * карточек 01–07 дашборда, и оно же описано в PeriodSwitcher.tsx:
   * «сколько ИЗ СОЗДАННЫХ в этом месяце заявок сейчас в таком-то
   * состоянии», а не «сколько заявок за месяц перешло в это состояние».
   *
   * Почему не updatedAt (так считались enrolled и tasksDone):
   *  1. Числитель и знаменатель конверсии брались из РАЗНЫХ популяций —
   *     enrolled по updatedAt, assigned по createdAt. Заявка, созданная в
   *     прошлом году и закрытая в этом месяце, попадала в числитель и не
   *     попадала в знаменатель: 3 созданных заявки против 8 закрытых
   *     старых давали «267% CONV» на главном экране руководителя.
   *  2. `updatedAt` двигает ЛЮБАЯ правка строки (смена менеджера, коммент,
   *     телефон), поэтому «зачислено за период» на самом деле означало
   *     «закрытую заявку в этот период кто-то потрогал».
   *  3. Карточка 05 «Зачислено» на дашборде считает те же статусы по
   *     createdAt — цифры на одном экране обязаны сходиться.
   *
   * Транзакции фильтруем по `Transaction.date`: у платежа это и есть его
   * собственная дата события (в схеме `@default(now())`), по ней же режет
   * период /finance/summary. Взять здесь createdAt значило бы разойтись с
   * финансовой карточкой того же дашборда на задним числом проведённых
   * платежах.
   *
   * ВАЛЮТА — ТОЛЬКО ОТЧЁТНАЯ (TJS), см. common/reporting-currency.ts.
   * `Transaction.currency` — свободная строка с `@default("TJS")`, а ручная
   * проводка в /finance принимает пять валют (TJS/USD/EUR/CNY/RUB). До этого
   * фикса `salesAmount` считался `_sum: { amount: true }` БЕЗ фильтра по
   * валюте: USD 5 000 складывались с TJS 5 000 как безразмерные числа, а фронт
   * рисовал итог сомонями (Kpi.tsx — `fmtMoney(row.salesAmount)` с
   * currency='TJS'). Этим же числом сортируется лидерборд, то есть менеджер с
   * одной валютной сделкой поднимался наверх на курсовой разнице, а не на
   * продажах. Ровно этот баг уже чинили в finance.service.ts
   * (REPORTING_CURRENCY во всех агрегатах) и в salary.service.ts
   * (SALARY_REPORTING_CURRENCY в бонусной базе) — KPI оставался последним
   * несинхронизированным модулем.
   *
   * Не-TJS приходы НЕ конвертируются (FX на write-time в системе нет) и НЕ
   * пропадают молча: они уходят отдельным полем `nonTjsSales` — по коду
   * валюты, в исходной валюте, — по той же схеме, что `nonTjsTotals` в
   * finance и `nonTjsSales` в salary.preview(). Ни в `salesAmount`, ни в
   * сортировку они не входят.
   *
   * Без границ (`{}` — /kpi/me, /kpi/:userId и режим «за всё время»)
   * dateRangeFilter отдаёт undefined, ни один фильтр не подмешивается и
   * запросы остаются ровно теми же, что были до появления периода.
   *
   * Сами границы разворачивает в моменты общий парсер (common/query-date →
   * common/tj-time): календарный день Asia/Dushanbe, `to` включительно до
   * 23:59:59.999 TJT. Арифметики над Date здесь нет и быть не должно.
   */
  async leaderboard(filters: { from?: Date; to?: Date }) {
    const dateFilter = dateRangeFilter(filters);

    // KPI leaderboard включает всех, кто работает с заявками: ADMIN
    // (исторически вёл свои), и оба типа менеджеров. Мульти-роли (ТЗ §2)
    // учитываются через OR на roles[].
    const KPI_ROLES = ['ADMIN', 'SALES_MANAGER', 'CLIENT_MANAGER'] as const;
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { role: { in: KPI_ROLES as any } },
          { roles: { hasSome: KPI_ROLES as any } },
        ],
      },
      select: { id: true, fullName: true, role: true, email: true, bonusPercent: true },
    });

    // Разбивка не-TJS приходов — ОДИН groupBy на всех пользователей, а не
    // ещё один запрос внутри цикла по users: лидерборд и так делает шесть
    // запросов на человека, седьмой удвоил бы стоимость экрана ради поля,
    // которое в чисто-сомонёвой базе всегда пустое. Фильтры совпадают с
    // TJS-агрегатом выше один в один (type / reversedAt / период) — иначе
    // «остаток» разошёлся бы с основной цифрой по причинам помимо валюты.
    const nonTjsGrouped = await this.prisma.transaction.groupBy({
      by: ['managerId', 'currency'],
      where: {
        managerId: { in: users.map((u) => u.id) },
        type: 'INCOME',
        reversedAt: null,
        currency: { not: REPORTING_CURRENCY },
        ...(dateFilter && { date: dateFilter }),
      },
      _sum: { amount: true },
    });
    const nonTjsByUser = new Map<string, NonReportingCurrencyBreakdown>();
    for (const g of nonTjsGrouped) {
      if (!g.managerId) continue; // отсечено в where, но типы этого не знают
      const bucket = nonTjsByUser.get(g.managerId) || {};
      // currency — свободная строка в схеме; пустую подписываем UNKNOWN,
      // ровно как nonTjsTotals() в finance.service.ts.
      const cur = g.currency || 'UNKNOWN';
      // Округление до копеек — как round() в salary.service: сложение Float
      // даёт хвосты вида 4999.999999999999.
      bucket[cur] = Math.round(((bucket[cur] || 0) + (g._sum.amount || 0)) * 100) / 100;
      nonTjsByUser.set(g.managerId, bucket);
    }

    const result = await Promise.all(
      users.map(async (u) => {
        const [
          applicationsAssigned,
          applicationsEnrolled,
          studentsCount,
          salesAgg,
          tasksOpen,
          tasksDone,
        ] = await Promise.all([
          this.prisma.application.count({
            where: {
              OR: [{ managerId: u.id }, { chinaManagerId: u.id }],
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
          this.prisma.application.count({
            where: {
              OR: [{ managerId: u.id }, { chinaManagerId: u.id }],
              // Не одно значение, а группа: пока не прогнали
              // migrate-lead-statuses.ts (перенос опт-ин, см.
              // MIGRATE_LEAD_STATUSES), часть строк носит ENROLLED/COMPLETED,
              // и строгий матч по SUCCESSFUL_LEAD обнулил бы весь KPI.
              status: { in: FINISHED_APPLICATION_STATUSES },
              // Тот же createdAt, что и у знаменателя конверсии выше:
              // считаем «сколько из назначенных за период заявок уже
              // дошли до успеха». Подмножество — значит conversionRate
              // физически не может превысить 100%.
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
          this.prisma.student.count({
            where: {
              OR: [{ managerId: u.id }, { chinaManagerId: u.id }],
              status: 'ACTIVE',
              // Период здесь раньше игнорировался молча: на /kpi с
              // выбранными «30 днями» эта колонка одна показывала «за всё
              // время». Режем по дате заведения студента — ровно так
              // считает карточка 04 «Активные клиенты» (students/stats),
              // поэтому сумма колонки сходится с ней.
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
          this.prisma.transaction.aggregate({
            where: {
              managerId: u.id,
              type: 'INCOME',
              // Bug #25: исключаем INCOME-транзакции, помеченные как
              // reversed (CANCEL сделки или ручной refund), иначе KPI
              // показывает завышенный salesAmount по отменённым сделкам.
              reversedAt: null,
              // Audit HIGH: складывать разные валюты в одно число нельзя —
              // см. блок «ВАЛЮТА» в шапке метода. Остаток периода в прочих
              // валютах возвращается в nonTjsSales (агрегируется ниже).
              currency: REPORTING_CURRENCY,
              ...(dateFilter && { date: dateFilter }),
            },
            _sum: { amount: true },
          }),
          this.prisma.task.count({
            where: {
              assignedToId: u.id,
              status: { not: 'DONE' },
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
          this.prisma.task.count({
            where: {
              assignedToId: u.id,
              status: 'DONE',
              // Обе задачные метрики — по createdAt, иначе колонка
              // «tasksDone / (tasksDone + tasksOpen)» на /kpi складывала бы
              // закрытые-в-периоде с открытыми-за-всё-время.
              ...(dateFilter && { createdAt: dateFilter }),
            },
          }),
        ]);

        // Math.min(100, …) — не расчёт, а предохранитель. После перевода
        // enrolled на createdAt он строго подмножество assigned, и выйти
        // за 100% арифметически нельзя. Клампа стоит на случай, если базы
        // дат снова разведут: «конверсия 267%» — цифра, из-за которой
        // перестают верить всему экрану, лучше упереться в 100%.
        const conversionRate =
          applicationsAssigned > 0
            ? Math.min(100, Math.round((applicationsEnrolled / applicationsAssigned) * 100))
            : 0;

        return {
          ...u,
          applicationsAssigned,
          applicationsEnrolled,
          conversionRate,
          studentsCount,
          salesAmount: salesAgg._sum.amount || 0,
          // Валюта, в которой посчитан salesAmount. Отдаём явно, чтобы фронт
          // не хардкодил 'TJS' в fmtMoney — та же форма ответа, что у
          // finance summary/breakdown.
          currency: REPORTING_CURRENCY,
          // Пустой объект = период был чисто в сомони, фронту нечего
          // дорисовывать. Непустой — подсказка «была ещё выручка в USD/…,
          // в рейтинг она не входит».
          nonTjsSales: nonTjsByUser.get(u.id) || {},
          tasksOpen,
          tasksDone,
        };
      }),
    );

    // Сортируем по продажам — топ-менеджеры наверху. Ключ сортировки
    // одновалютный (TJS), поэтому сравнение осмысленно: до фикса валюты
    // порядок мест зависел от того, в какой валюте оформлена сделка.
    return result.sort((a, b) => b.salesAmount - a.salesAmount);
  }

  /** KPI одного сотрудника + история по месяцам. */
  async forUser(userId: string) {
    const board = await this.leaderboard({});
    return board.find((u) => u.id === userId) || null;
  }
}
