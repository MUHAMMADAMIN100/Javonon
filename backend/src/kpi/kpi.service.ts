import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isElevated, UserWithRoles } from '../auth/role-utils';
import { PAID_STUDENT_WHERE } from '../common/paid-student';
import { PrismaService } from '../prisma/prisma.service';
import { FINISHED_APPLICATION_STATUSES } from '../common/application-status';
import { dateRangeFilter } from '../common/query-date';
import {
  NonReportingCurrencyBreakdown,
  REPORTING_CURRENCY,
} from '../common/reporting-currency';

/** Диапазон дат из dateRangeFilter(): undefined — «за всё время». */
type DateRange = ReturnType<typeof dateRangeFilter>;

/**
 * Потолок строк в каждом списке окна подробностей. У активного менеджера за
 * «всё время» тысячи заявок — тащить их все в окно бессмысленно. Итоги при
 * этом считаются по ВСЕМ записям, обрезается только показ.
 */
const DETAILS_LIST_LIMIT = 300;

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
          this.prisma.application.count({ where: this.applicationsWhere(u.id, dateFilter) }),
          this.prisma.application.count({
            where: { ...this.applicationsWhere(u.id, dateFilter), status: { in: FINISHED_APPLICATION_STATUSES } },
          }),
          this.prisma.student.count({ where: this.studentsWhere(u.id, dateFilter) }),
          this.prisma.transaction.aggregate({
            where: this.salesWhere(u.id, dateFilter),
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
  /* ======================================================================
   *  УСЛОВИЯ ВЫБОРКИ — ОДНИ НА РЕЙТИНГ И НА ОКНО ПОДРОБНОСТЕЙ
   *
   *  Окно по клику на строку обязано показывать РОВНО те записи, из которых
   *  сложились числа строки: «Студентов: 1» — один студент в списке,
   *  «Продажи 6 000» — платежи в сумме 6 000. Две копии условия разошлись
   *  бы при первой же правке, и человек увидел бы «в рейтинге 5, в списке
   *  4». Поэтому и leaderboard(), и details() берут where отсюда.
   * ==================================================================== */

  /** Заявки сотрудника (любой из двух слотов менеджера), по дате создания. */
  private applicationsWhere(userId: string, dateFilter: DateRange): Prisma.ApplicationWhereInput {
    return {
      OR: [{ managerId: userId }, { chinaManagerId: userId }],
      ...(dateFilter && { createdAt: dateFilter }),
    };
  }

  /** Активные ОПЛАТИВШИЕ студенты сотрудника, по дате заведения карточки. */
  private studentsWhere(userId: string, dateFilter: DateRange): Prisma.StudentWhereInput {
    return {
      OR: [{ managerId: userId }, { chinaManagerId: userId }],
      status: 'ACTIVE',
      // Студент = оплативший (common/paid-student.ts) — как в списке
      // «Студенты» и на карточке дашборда.
      ...PAID_STUDENT_WHERE,
      // Режем по дате заведения студента — ровно так считает карточка 04
      // «Активные клиенты» (students/stats), поэтому суммы сходятся.
      ...(dateFilter && { createdAt: dateFilter }),
    };
  }

  /** Действующие приходы сотрудника в отчётной валюте, по дате платежа. */
  private salesWhere(userId: string, dateFilter: DateRange): Prisma.TransactionWhereInput {
    return {
      managerId: userId,
      type: 'INCOME',
      // Исключаем отменённые (reversedAt) — иначе продажи завышены отказами.
      reversedAt: null,
      currency: REPORTING_CURRENCY,
      ...(dateFilter && { date: dateFilter }),
    };
  }

  /**
   * Подробности по строке рейтинга: что именно стоит за числами сотрудника
   * за тот же период — его студенты, платежи и заявки.
   *
   * ДОСТУП. Руководство (FOUNDER/ADMIN/ACCOUNTANT) открывает любого,
   * сотрудник — только себя. Сам рейтинг видят все, но в нём лишь итоги;
   * здесь же фамилии чужих клиентов и суммы по каждому платежу — то, что
   * менеджеру о коллеге знать не положено. Проверка стоит на сервере:
   * некликабельная строка в интерфейсе защитой не является.
   */
  async details(userId: string, filters: { from?: Date; to?: Date }, viewer: UserWithRoles & { id: string }) {
    if (!isElevated(viewer) && viewer.id !== userId) {
      throw new ForbiddenException('Подробности по другому сотруднику доступны только руководству');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, role: true },
    });
    if (!user) throw new NotFoundException('Сотрудник не найден');

    const dateFilter = dateRangeFilter(filters);
    const appsWhere = this.applicationsWhere(userId, dateFilter);
    const salesWhere = this.salesWhere(userId, dateFilter);

    const [students, sales, salesAgg, otherCurrencySales, applications, applicationsTotal, applicationsEnrolled, byStatus] =
      await Promise.all([
        this.prisma.student.findMany({
          where: this.studentsWhere(userId, dateFilter),
          select: {
            id: true, fullName: true, direction: true, status: true, cabinet: true, createdAt: true,
            // Сколько студент оплатил ВСЕГО (действующие платежи за обучение) —
            // справочно; в «Продажи» периода это число не входит.
            transactions: {
              where: { type: 'INCOME', category: 'TUITION_PAYMENT', reversedAt: null, currency: REPORTING_CURRENCY },
              select: { amount: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: DETAILS_LIST_LIMIT,
        }),
        this.prisma.transaction.findMany({
          where: salesWhere,
          select: {
            id: true, amount: true, currency: true, date: true, category: true, comment: true, payerName: true,
            studentId: true, student: { select: { id: true, fullName: true } },
          },
          orderBy: { date: 'desc' },
          take: DETAILS_LIST_LIMIT,
        }),
        this.prisma.transaction.aggregate({ where: salesWhere, _sum: { amount: true }, _count: true }),
        // Приходы в прочих валютах: в сумму «Продажи» не входят (конвертации
        // нет), но и молча не пропадают — показываем отдельным списком.
        this.prisma.transaction.findMany({
          where: { ...salesWhere, currency: { not: REPORTING_CURRENCY } },
          select: {
            id: true, amount: true, currency: true, date: true, category: true, comment: true, payerName: true,
            studentId: true, student: { select: { id: true, fullName: true } },
          },
          orderBy: { date: 'desc' },
          take: DETAILS_LIST_LIMIT,
        }),
        this.prisma.application.findMany({
          where: appsWhere,
          select: { id: true, fullName: true, phone: true, status: true, country: true, createdAt: true, studentId: true },
          orderBy: { createdAt: 'desc' },
          take: DETAILS_LIST_LIMIT,
        }),
        this.prisma.application.count({ where: appsWhere }),
        this.prisma.application.count({ where: { ...appsWhere, status: { in: FINISHED_APPLICATION_STATUSES } } }),
        this.prisma.application.groupBy({ by: ['status'], where: appsWhere, _count: true }),
      ]);

    const studentsTotal =
      students.length < DETAILS_LIST_LIMIT
        ? students.length
        : await this.prisma.student.count({ where: this.studentsWhere(userId, dateFilter) });

    return {
      user,
      currency: REPORTING_CURRENCY,
      /** Списки обрезаются до этого числа строк; итоги считаются по всем. */
      listLimit: DETAILS_LIST_LIMIT,
      totals: {
        applicationsAssigned: applicationsTotal,
        applicationsEnrolled,
        studentsCount: studentsTotal,
        salesAmount: salesAgg._sum.amount || 0,
        salesCount: salesAgg._count,
      },
      students: students.map(({ transactions, ...st }) => ({
        ...st,
        paidTotal: Math.round(transactions.reduce((sum, t) => sum + (t.amount || 0), 0) * 100) / 100,
      })),
      sales,
      otherCurrencySales,
      applications: applications.map((a) => ({
        ...a,
        enrolled: (FINISHED_APPLICATION_STATUSES as readonly string[]).includes(a.status),
      })),
      applicationsByStatus: byStatus
        .map((g) => ({ status: g.status, count: g._count }))
        .sort((x, y) => y.count - x.count),
    };
  }

  async forUser(userId: string) {
    const board = await this.leaderboard({});
    return board.find((u) => u.id === userId) || null;
  }
}
